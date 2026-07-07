import type { Canvas, CanvasKit, Paint, Surface } from 'canvaskit-wasm';
import { buildFontProvider, isFontLoaded, loadGoogleFontData, onFontLoaded } from './fonts';
import { parseSVGPathD } from './svg_utils';

/** Helper for efficient zero-copy parsing of the WASM binary render buffer. */
class BinaryReader {
    view: DataView;
    offset: number = 0;
    private decoder = new TextDecoder();

    constructor(view: DataView) {
        this.view = view;
    }

    u8() { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
    u16() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
    u32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
    f32() { const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
    
    f32Array(n: number): Float32Array {
        // The protocol keeps every field 4-byte aligned relative to the buffer
        // start, so a zero-copy view works whenever the WASM allocation itself
        // is 4-byte aligned (true in practice, but not guaranteed for Vec<u8>).
        const byteOffset = this.view.byteOffset + this.offset;
        this.offset += n * 4;
        if (byteOffset % 4 === 0) {
            return new Float32Array(this.view.buffer, byteOffset, n);
        }
        const arr = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            arr[i] = this.view.getFloat32(byteOffset + i * 4, true);
        }
        return arr;
    }

    string(): string {
        const len = this.u32();
        const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
        this.offset += len;
        // Align to 4 bytes
        this.offset = (this.offset + 3) & ~3;
        return this.decoder.decode(bytes);
    }
}

import type { WasmScene } from './wasm_scene';
import type { InputManager } from './input';

// Render protocol (see engine/src/lib.rs "Render Protocol"). These MUST match
// the RENDER_PROTOCOL_MAGIC / RENDER_PROTOCOL_VERSION constants the engine emits.
// Bump EXPECTED_RENDER_PROTOCOL_VERSION here in lockstep with any change to the
// render-buffer layout on either side; a mismatch means engine/pkg is stale
// (rebuild wasm) or renderer.ts is out of date.
const RENDER_PROTOCOL_MAGIC = 0x31434556; // ASCII "VEC1", little-endian
const EXPECTED_RENDER_PROTOCOL_VERSION = 1;

export class Renderer {
    /** Generate a path for a text node (for "Create Outlines"). */
    getTextPath(id: number): any[] | null {
        const node = this.scene.getNode(id);
        if (!node || !node.geometry.Text) return null;
        
        const geo = node.geometry.Text;
        const fontSize = geo.font_size;
        const fontFamily = geo.font_family;
        const textAlign = geo.text_align; // 0=Left, 1=Center, 2=Right
        const lineHeight = geo.line_height || 1.2;
        const content = geo.content;

        // Use a generic font manager if possible, or null for default
        const font = new this.ck.Font(null, fontSize);
        const lines = content.split('\n');
        const combinedPath = new this.ck.Path();

        // Calculate line widths for alignment
        const lineData: { text: string, width: number }[] = [];
        for (const line of lines) {
            const width = font.measureText(line);
            lineData.push({ text: line, width });
        }

        for (let i = 0; i < lineData.length; i++) {
            const { text, width } = lineData[i];
            
            // Offset for alignment
            let offsetX = 0;
            if (textAlign === 1) offsetX = -width / 2;
            else if (textAlign === 2) offsetX = -width;

            const offsetY = i * fontSize * lineHeight;

            const glyphIDs = font.getGlyphIDs(text);
            const glyphWidths = font.getGlyphWidths(glyphIDs);
            const paths = font.getGlyphPaths(glyphIDs);
            
            let currentX = offsetX;
            for (let j = 0; j < paths.length; j++) {
                const p = paths[j];
                if (p) {
                    p.transform([1, 0, currentX, 0, 1, offsetY, 0, 0, 1]);
                    combinedPath.addPath(p);
                    p.delete();
                }
                currentX += glyphWidths[j];
            }
        }

        const svgD = combinedPath.toSVGString();
        combinedPath.delete();
        font.delete();

        return parseSVGPathD(svgD);
    }

    ck: CanvasKit;
    canvas: HTMLCanvasElement;
    scene: WasmScene;
    surface: Surface | null;
    // CanvasKit WebGL context handles — typed as `number` (opaque GL context IDs)
    private glContext: number = 0;
    private grContext: unknown = null;
    isRunning: boolean;
    zoom: number;
    pan: { x: number; y: number };
    inputManager: InputManager | null = null;
    /** Face ID currently being hovered by the paint bucket tool (or -1). */
    hoverFaceId: number = -1;

    // ─── Cached Resources (avoid per-frame allocation) ───
    private paint: Paint | null = null;

    // ─── Dirty-frame gating ───
    /** When false, the rAF loop skips rendering. Set to true by requestRender(). */
    private _needsRender = true;
    /** One-shot guard so a render-protocol desync logs once, not every frame. */
    private _protocolDesyncWarned = false;

    // ─── Path object cache (avoid rebuilding CanvasKit paths every frame) ───
    private _pathCache: Map<number, { path: ReturnType<CanvasKit['Path']['prototype']['copy']>; fillRule: number }> = new Map();

    // ─── Gradient shader cache ───
    private _gradientCache: Map<string, ReturnType<CanvasKit['Shader']['MakeLinearGradient']>> = new Map();

    // ─── Filled faces cache ───
    private _filledFacesCache: { data: { boundary: number[][]; fill: { r: number; g: number; b: number; a: number } }[] } | null = null;

    // ─── Cached overlay paints (created once, reused every frame) ───
    private _overlayPaints: {
        selOutline: Paint;
        selHandleFill: Paint;
        selHandleStroke: Paint;
        hoverOutline: Paint;
        gridPaint: Paint;
        artboardFill: Paint;
        artboardStroke: Paint;
    } | null = null;

    constructor(ck: CanvasKit, canvas: HTMLCanvasElement, scene: WasmScene) {
        this.ck = ck;
        this.canvas = canvas;
        this.scene = scene;
        this.surface = null;
        this.isRunning = false;

        this.zoom = 1.0;
        this.pan = { x: 0, y: 0 };

        this.initGL();

        // Re-render when a Google Font finishes loading so text appears correctly
        onFontLoaded(() => {
            this.scene.invalidateCache();
            this._needsRender = true;
        });
    }

    /** Signal that the scene or view changed and a new frame is needed. */
    requestRender() {
        this._needsRender = true;
    }

    /** Invalidate all cached rendering resources. Call when the scene mutates. */
    invalidateRenderCaches() {
        // Clear path cache
        for (const entry of this._pathCache.values()) {
            entry.path.delete();
        }
        this._pathCache.clear();

        // Clear gradient cache
        for (const shader of this._gradientCache.values()) {
            if (shader) shader.delete();
        }
        this._gradientCache.clear();

        // Clear filled faces cache
        this._filledFacesCache = null;

        this._needsRender = true;
    }

    /** Ensure the reusable overlay Paint objects exist. */
    private ensureOverlayPaints() {
        if (this._overlayPaints) return this._overlayPaints;
        const ck = this.ck;
        const selOutline = new ck.Paint();
        selOutline.setColor(ck.Color(0, 162, 255, 1.0));
        selOutline.setStyle(ck.PaintStyle.Stroke);

        const selHandleFill = new ck.Paint();
        selHandleFill.setColor(ck.Color(255, 255, 255, 1.0));
        selHandleFill.setStyle(ck.PaintStyle.Fill);

        const selHandleStroke = new ck.Paint();
        selHandleStroke.setColor(ck.Color(0, 162, 255, 1.0));
        selHandleStroke.setStyle(ck.PaintStyle.Stroke);

        const hoverOutline = new ck.Paint();
        hoverOutline.setColor(ck.Color(0, 162, 255, 0.55));
        hoverOutline.setStyle(ck.PaintStyle.Stroke);
        hoverOutline.setAntiAlias(true);

        const gridPaint = new ck.Paint();
        gridPaint.setColor(ck.Color(255, 255, 255, 0.04));
        gridPaint.setStyle(ck.PaintStyle.Stroke);

        const artboardFill = new ck.Paint();
        artboardFill.setColor(ck.Color(255, 255, 255, 1.0));
        artboardFill.setStyle(ck.PaintStyle.Fill);

        const artboardStroke = new ck.Paint();
        artboardStroke.setColor(ck.Color(80, 80, 80, 1.0));
        artboardStroke.setStyle(ck.PaintStyle.Stroke);

        this._overlayPaints = { selOutline, selHandleFill, selHandleStroke, hoverOutline, gridPaint, artboardFill, artboardStroke };
        return this._overlayPaints;
    }


    private initGL() {
        // CanvasKit's GetWebGLContext/MakeGrContext aren't in public typings
        const ckAny = this.ck as unknown as Record<string, CallableFunction>;
        this.glContext = ckAny.GetWebGLContext(this.canvas) as number;
        this.grContext = ckAny.MakeGrContext(this.glContext);
        this.onResize();
        window.addEventListener('resize', () => this.onResize());
    }

    destroy() {
        this.isRunning = false;
        if (this.paint) {
            this.paint.delete();
            this.paint = null;
        }
        if (this.surface) {
            this.surface.delete();
            this.surface = null;
        }
        // Clean up cached CanvasKit objects
        this.invalidateRenderCaches();
        if (this._overlayPaints) {
            this._overlayPaints.selOutline.delete();
            this._overlayPaints.selHandleFill.delete();
            this._overlayPaints.selHandleStroke.delete();
            this._overlayPaints.hoverOutline.delete();
            this._overlayPaints.gridPaint.delete();
            this._overlayPaints.artboardFill.delete();
            this._overlayPaints.artboardStroke.delete();
            this._overlayPaints = null;
        }
    }

    onResize() {
        try {
            const dpr = window.devicePixelRatio;
            this.canvas.width = this.canvas.clientWidth * dpr;
            this.canvas.height = this.canvas.clientHeight * dpr;
            
            if (this.surface) {
                this.surface.delete();
            }
            
            const ckExt = this.ck as unknown as Record<string, CallableFunction>;
            const ckRaw = this.ck as unknown as Record<string, Record<string, unknown>>;
            this.surface = ckExt.MakeOnScreenGLSurface(
                this.grContext,
                this.canvas.width,
                this.canvas.height,
                ckRaw.ColorSpace ? ckRaw.ColorSpace.SRGB : null
            ) as Surface | null;
            
            // Fallback for different CanvasKit versions
            if (!this.surface && ckExt.MakeRenderTarget) {
                this.surface = ckExt.MakeRenderTarget(this.glContext, this.canvas.width, this.canvas.height) as Surface | null;
            }
            if (!this.surface) {
                this.surface = this.ck.MakeWebGLCanvasSurface(this.canvas);
            }
            
            this.render();
        } catch (e) {
            console.error("Failed to resize surface:", e);
        }
    }

    zoomToFit(docW: number, docH: number) {
        const viewW = this.canvas.clientWidth;
        const viewH = this.canvas.clientHeight;
        if (viewW <= 0 || viewH <= 0) return;

        const margin = 48; // css px on each side
        const scale = Math.min(
            (viewW - margin * 2) / docW,
            (viewH - margin * 2) / docH,
        );
        this.zoom = Math.max(0.02, Math.min(4, scale));
        this.pan.x = (viewW - docW * this.zoom) / 2;
        this.pan.y = (viewH - docH * this.zoom) / 2;
    }

    /** Fit the given world-space bounds in the viewport (zoom to selection). */
    zoomToBounds(b: { x: number; y: number; w: number; h: number }) {
        const viewW = this.canvas.clientWidth;
        const viewH = this.canvas.clientHeight;
        if (viewW <= 0 || viewH <= 0 || b.w <= 0 || b.h <= 0) return;

        const margin = 64; // css px on each side
        const scale = Math.min((viewW - margin * 2) / b.w, (viewH - margin * 2) / b.h);
        this.zoom = Math.max(0.02, Math.min(64, scale));
        this.pan.x = (viewW - b.w * this.zoom) / 2 - b.x * this.zoom;
        this.pan.y = (viewH - b.h * this.zoom) / 2 - b.y * this.zoom;
    }

    /** Set zoom keeping the viewport center fixed. */
    setZoomCentered(newZoom: number) {
        const viewW = this.canvas.clientWidth;
        const viewH = this.canvas.clientHeight;
        const cx = viewW / 2, cy = viewH / 2;
        const worldX = (cx - this.pan.x) / this.zoom;
        const worldY = (cy - this.pan.y) / this.zoom;
        this.zoom = Math.max(0.01, Math.min(100, newZoom));
        this.pan.x = cx - worldX * this.zoom;
        this.pan.y = cy - worldY * this.zoom;
    }

    loop() {
        if (!this.isRunning) return;
        if (this._needsRender) {
            this._needsRender = false;
            this.render();
        }
        requestAnimationFrame(() => this.loop());
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.loop();
    }

    fitToArtboard(docW?: number, docH?: number) {
        const w = docW ?? this.scene.engine?.get_document_width() ?? 1000;
        const h = docH ?? this.scene.engine?.get_document_height() ?? 1000;
        this.zoomToFit(w, h);
        this.render();
    }

    render() {
        if (!this.surface || !this.scene.engine) return;
        const canvas = this.surface.getCanvas();
        const dpr = window.devicePixelRatio || 1;

        canvas.clear(this.ck.Color(43, 43, 43, 1.0));

        this.drawGrid(canvas, dpr);
        
        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        this.drawArtboard(canvas);

        // Compute viewport in document space for culling
        const viewportMinX = -this.pan.x / this.zoom;
        const viewportMinY = -this.pan.y / this.zoom;
        const viewportMaxX = (this.canvas.width / dpr - this.pan.x) / this.zoom;
        const viewportMaxY = (this.canvas.height / dpr - this.pan.y) / this.zoom;

        // Draw Scene Objects via binary command stream (Phase 3: No JSON Tax)
        const visibleIds = this.scene.getVisibleNodes(viewportMinX, viewportMinY, viewportMaxX, viewportMaxY);
        const view = this.scene.getRenderData(visibleIds);
        const reader = new BinaryReader(view);

        // Validate the protocol header before trusting any offsets. A magic or
        // version mismatch means the engine wasm is stale/incompatible — fail
        // loudly rather than parsing garbage.
        const magic = reader.u32();
        if (magic !== RENDER_PROTOCOL_MAGIC) {
            throw new Error(
                `Render buffer magic 0x${magic.toString(16)} != 0x${RENDER_PROTOCOL_MAGIC.toString(16)}. ` +
                `engine/pkg is stale or corrupt — rebuild the wasm engine.`);
        }
        const protocolVersion = reader.u32();
        if (protocolVersion !== EXPECTED_RENDER_PROTOCOL_VERSION) {
            throw new Error(
                `Render protocol version ${protocolVersion} != expected ${EXPECTED_RENDER_PROTOCOL_VERSION}. ` +
                `Rebuild the wasm engine after engine/src changes, or update renderer.ts to match.`);
        }

        const commandCount = reader.u32();
        if (!this.paint) this.paint = new this.ck.Paint();
        const p = this.paint;
        p.setAntiAlias(true);

        // Compute the dim target once per frame. getEditingDimTarget self-heals a
        // stale id (edited node removed by undo/delete), so dimming can never stick.
        const dimTarget = this.inputManager?.getEditingDimTarget() ?? null;

        for (let i = 0; i < commandCount; i++) {
            const recordLen = reader.u32();
            const recordStart = reader.offset;
            const cmdType = reader.u32();
            const nodeId = reader.u32();

            if (cmdType === 1) { // CMD_START_GROUP
                const opacity = reader.f32();
                if (opacity < 1.0) {
                    p.setAlphaf(opacity);
                    canvas.saveLayer(p);
                    p.setAlphaf(1.0);
                } else {
                    canvas.save();
                }
            } else if (cmdType === 3) { // CMD_END_GROUP
                canvas.restore();
            } else if (cmdType === 2) { // CMD_DRAW_NODE
                const nodeType = reader.u32();
                const matrix = reader.f32Array(9);
                
                // Dim non-edited nodes in path edit mode
                const nodeAlpha = (dimTarget !== null && nodeId !== dimTarget) ? 0.3 : 1.0;

                // ─── Read Fills ─────────────────
                const fillCount = reader.u32();
                const fills: any[] = [];
                for (let i = 0; i < fillCount; i++) {
                    const fillType = reader.u32();
                    if (fillType === 1) { // Solid
                        fills.push({
                            type: 1,
                            r: reader.f32(), g: reader.f32(), b: reader.f32(), a: reader.f32()
                        });
                    } else if (fillType === 2 || fillType === 3) { // Gradient
                        const stopCount = reader.u32();
                        const stops = [];
                        for (let s = 0; s < stopCount; s++) {
                            stops.push({
                                offset: reader.f32(),
                                r: reader.f32(), g: reader.f32(), b: reader.f32(), a: reader.f32(),
                            });
                        }
                        fills.push({
                            type: fillType,
                            stops,
                            start: [reader.f32(), reader.f32()],
                            end: [reader.f32(), reader.f32()]
                        });
                    } else {
                        fills.push({ type: 0 });
                    }
                }

                // ─── Read Strokes ───────────────
                const strokeCount = reader.u32();
                const strokes: any[] = [];
                for (let i = 0; i < strokeCount; i++) {
                    const strokeType = reader.u32();
                    let paint: any = { type: 0 };
                    if (strokeType === 1) { // Solid
                        paint = {
                            type: 1,
                            r: reader.f32(), g: reader.f32(), b: reader.f32(), a: reader.f32()
                        };
                    } else if (strokeType === 2 || strokeType === 3) { // Gradient
                        const stopCount = reader.u32();
                        const stops = [];
                        for (let s = 0; s < stopCount; s++) {
                            stops.push({
                                offset: reader.f32(),
                                r: reader.f32(), g: reader.f32(), b: reader.f32(), a: reader.f32(),
                            });
                        }
                        paint = {
                            type: strokeType,
                            stops,
                            start: [reader.f32(), reader.f32()],
                            end: [reader.f32(), reader.f32()]
                        };
                    }
                    strokes.push({
                        paint,
                        width: reader.f32(),
                        cap: reader.u32(),
                        join: reader.u32(),
                        dashOn: reader.f32(),
                        dashOff: reader.f32(),
                        dashPhase: reader.f32(),
                        miterLimit: reader.f32(),
                        alignment: reader.u32()
                    });
                }

                const cornerRadius = reader.f32();
                const styleFlags = reader.u32();
                const blendMode  = (styleFlags >>> 16) & 0xFF;
                const fillRule   = (styleFlags >>> 24) & 0xFF;

                canvas.save();
                canvas.concat(matrix);

                const startGeoOffset = reader.offset;
                const geoSize = reader.view.getUint32(startGeoOffset, true);

                // Apply blend mode (shared across fill + stroke passes)
                const ckBlendModes = [
                    this.ck.BlendMode.SrcOver,    // 0: Normal
                    this.ck.BlendMode.Multiply,   // 1
                    this.ck.BlendMode.Screen,     // 2
                    this.ck.BlendMode.Overlay,    // 3
                    this.ck.BlendMode.Darken,     // 4
                    this.ck.BlendMode.Lighten,    // 5
                    this.ck.BlendMode.ColorDodge, // 6
                    this.ck.BlendMode.ColorBurn,  // 7
                    this.ck.BlendMode.HardLight,  // 8
                    this.ck.BlendMode.SoftLight,  // 9
                    this.ck.BlendMode.Difference, // 10
                    this.ck.BlendMode.Exclusion,  // 11
                    this.ck.BlendMode.Hue,        // 12
                    this.ck.BlendMode.Saturation, // 13
                    this.ck.BlendMode.Color,      // 14
                    this.ck.BlendMode.Luminosity, // 15
                ];
                if (blendMode > 0 && blendMode < ckBlendModes.length) {
                    p.setBlendMode(ckBlendModes[blendMode]);
                }

                // Fill Pass(es)
                if (fills.length === 0 && strokes.length === 0) {
                    reader.offset += 4 + geoSize; // Skip geometry if totally invisible
                } else {
                    for (const fill of fills) {
                        if (fill.type === 0) continue;
                        reader.offset = startGeoOffset; // Rewind geometry reader
                        if (fill.type === 1) {
                            p.setColor(this.ck.Color4f(fill.r, fill.g, fill.b, fill.a * nodeAlpha));
                            p.setShader(null);
                        } else if (fill.type === 2 || fill.type === 3) {
                            const fillShader = this.getOrCreateGradientShader(
                                fill.type, fill.stops, fill.start, fill.end, nodeAlpha
                            );
                            p.setShader(fillShader);
                        }
                        p.setStyle(this.ck.PaintStyle.Fill);
                        this.drawBinaryGeometry(canvas, nodeType, reader, p, cornerRadius, fillRule, nodeId);
                        p.setShader(null);
                    }
                    if (fills.length === 0) {
                         // Skip geometry once if there were no fills, so strokes can rewind
                         reader.offset += 4 + geoSize;
                    }

                    // Stroke Pass(es)
                    const ckCaps = [this.ck.StrokeCap.Butt, this.ck.StrokeCap.Round, this.ck.StrokeCap.Square];
                    const ckJoins = [this.ck.StrokeJoin.Miter, this.ck.StrokeJoin.Round, this.ck.StrokeJoin.Bevel];

                    for (const st of strokes) {
                        if (st.paint.type === 0 || st.width <= 0) continue;
                        reader.offset = startGeoOffset; // Rewind geometry reader
                        
                        if (st.paint.type === 1) {
                            p.setColor(this.ck.Color4f(st.paint.r, st.paint.g, st.paint.b, st.paint.a * nodeAlpha));
                            p.setShader(null);
                        } else if (st.paint.type === 2 || st.paint.type === 3) {
                            const strokeShader = this.getOrCreateGradientShader(
                                st.paint.type, st.paint.stops, st.paint.start, st.paint.end, nodeAlpha
                            );
                            p.setShader(strokeShader);
                        }
                        
                        p.setStyle(this.ck.PaintStyle.Stroke);
                        
                        // 0: Center, 1: Inner, 2: Outer
                        if (st.alignment === 0) {
                            p.setStrokeWidth(st.width);
                        } else {
                            // Multiply by 2 because clip will hide half of it
                            p.setStrokeWidth(st.width * 2);
                        }

                        p.setStrokeCap(ckCaps[st.cap] ?? this.ck.StrokeCap.Butt);
                        p.setStrokeJoin(ckJoins[st.join] ?? this.ck.StrokeJoin.Miter);
                        p.setStrokeMiter(st.miterLimit);

                        let dashEffect = null;
                        if (st.dashOn > 0) {
                            dashEffect = this.ck.PathEffect.MakeDash([st.dashOn, st.dashOff], st.dashPhase);
                            p.setPathEffect(dashEffect);
                        }

                        if (st.alignment === 1 || st.alignment === 2) {
                            // Need to parse geometry path to clip
                            const tempPath = this.getBinaryGeometryPath(nodeType, reader, cornerRadius, nodeId);
                            if (tempPath) {
                                canvas.save();
                                if (st.alignment === 1) { // Inner
                                    canvas.clipPath(tempPath, this.ck.ClipOp.Intersect, true);
                                } else if (st.alignment === 2) { // Outer
                                    canvas.clipPath(tempPath, this.ck.ClipOp.Difference, true);
                                }
                                canvas.drawPath(tempPath, p);
                                canvas.restore();
                                tempPath.delete();
                            }
                        } else {
                            // Standard draw
                            this.drawBinaryGeometry(canvas, nodeType, reader, p, cornerRadius, undefined, nodeId);
                        }

                        if (dashEffect) {
                            p.setPathEffect(null);
                            dashEffect.delete();
                        }
                        p.setShader(null);
                    }
                    
                    if (strokes.length === 0 && fills.length > 0) {
                        // Keep reader at the end of geometry
                        reader.offset = startGeoOffset + 4 + geoSize;
                    } else if (strokes.length > 0) {
                        // After last stroke, reader is already at the end of geometry
                        reader.offset = startGeoOffset + 4 + geoSize;
                    }
                }

                // Reset blend mode after all passes
                if (blendMode > 0) {
                    p.setBlendMode(this.ck.BlendMode.SrcOver);
                }

                canvas.restore();
            }

            // Framing check: every record declared its own byte length. If the
            // reader didn't consume exactly that, writer/reader layouts have
            // skewed (usually a stale engine/pkg). Report once, then resync to
            // the declared record boundary so the rest of the frame still draws.
            const consumed = reader.offset - recordStart;
            if (consumed !== recordLen) {
                if (!this._protocolDesyncWarned) {
                    console.error(
                        `Render protocol desync at command ${i} (cmdType=${cmdType}, node=${nodeId}): ` +
                        `consumed ${consumed} bytes but record declared ${recordLen}. ` +
                        `Writer/reader layout skew — engine/pkg is likely stale.`);
                    this._protocolDesyncWarned = true;
                }
                reader.offset = recordStart + recordLen;
            }
        }

        // Draw filled faces (Live Paint)
        this.drawFilledFaces(canvas);

        // Draw live preview shape (while user is dragging to create)
        this.drawPreview(canvas);

        // Draw pen tool in-progress path
        this.drawPenPreview(canvas);

        // Draw paint bucket hover preview
        this.drawPaintBucketHover(canvas);

        // Draw marquee selection rectangle
        this.drawMarquee(canvas);

        // Draw snapping alignment guides
        this.drawSnapGuides(canvas, viewportMinX, viewportMinY, viewportMaxX, viewportMaxY);

        canvas.restore();

        // Draw hover outline (shape under cursor, selection tool)
        this.drawHoverOutline(canvas, dpr);

        // Draw selection overlay
        this.renderSelectionOverlay(canvas, dpr);

        // Draw direct selection edit handles
        this.drawDirectEditHandles(canvas, dpr);

        // Draw scissors / add-point hover dot
        this.drawScissorsPreview(canvas, dpr);

        this.surface.flush();
    }

    /** Build a cache key for a gradient and return a cached or newly created shader. */
    private getOrCreateGradientShader(
        gradType: number,
        stops: { offset: number; r: number; g: number; b: number; a: number }[],
        start: [number, number],
        end: [number, number],
        nodeAlpha: number = 1.0,
    ): ReturnType<CanvasKit['Shader']['MakeLinearGradient']> {
        // Build a compact cache key from gradient parameters
        let key = `${gradType}|${start[0]},${start[1]}|${end[0]},${end[1]}|${nodeAlpha}`;
        for (const s of stops) {
            key += `|${s.offset},${s.r},${s.g},${s.b},${s.a}`;
        }
        const cached = this._gradientCache.get(key);
        if (cached) return cached;

        const colors = stops.map(s => this.ck.Color4f(s.r, s.g, s.b, s.a * nodeAlpha));
        const offsets = stops.map(s => s.offset);
        let shader: ReturnType<CanvasKit['Shader']['MakeLinearGradient']>;
        if (gradType === 2) { // Linear
            shader = this.ck.Shader.MakeLinearGradient(
                start, end, colors, offsets, this.ck.TileMode.Clamp,
            );
        } else { // Radial
            const radius = Math.hypot(end[0] - start[0], end[1] - start[1]);
            shader = this.ck.Shader.MakeTwoPointConicalGradient(
                start, 0, start, radius, colors, offsets, this.ck.TileMode.Clamp,
            );
        }
        this._gradientCache.set(key, shader);
        return shader;
    }

    private getBinaryGeometryPath(type: number, reader: BinaryReader, cornerRadius: number = 0, nodeId: number = 0) {
        const path = new this.ck.Path();
        reader.u32(); // skip size

        if (type === 1) { // Rect
            const w = reader.f32();
            const h = reader.f32();
            if (cornerRadius > 0) {
                const r = Math.min(cornerRadius, w / 2, h / 2);
                path.addRRect(this.ck.RRectXY(this.ck.LTRBRect(0, 0, w, h), r, r));
            } else {
                path.addRect(this.ck.LTRBRect(0, 0, w, h));
            }
        } else if (type === 2) { // Ellipse
            const rx = reader.f32();
            const ry = reader.f32();
            path.addOval(this.ck.LTRBRect(-rx, -ry, rx, ry));
        } else if (type === 0) { // Path
            const numSubpaths = reader.u32();
            
            // Check cache
            const cached = this._pathCache.get(nodeId);
            if (cached && nodeId > 0) {
                for (let s = 0; s < numSubpaths; s++) {
                    reader.u32(); // closed
                    const numPoints = reader.u32();
                    reader.offset += numPoints * 6 * 4;
                }
                path.delete();
                return cached.path.copy();
            }

            for (let s = 0; s < numSubpaths; s++) {
                const closed = reader.u32() === 1;
                const numPoints = reader.u32();
                let prevCP2: [number, number] | null = null;
                let firstX = 0, firstY = 0, firstCP1: [number, number] = [0, 0];

                for (let p = 0; p < numPoints; p++) {
                    const x = reader.f32(); const y = reader.f32();
                    const cp1x = reader.f32(); const cp1y = reader.f32();
                    const cp2x = reader.f32(); const cp2y = reader.f32();
                    
                    if (p === 0) {
                        path.moveTo(x, y);
                        firstX = x; firstY = y;
                        firstCP1 = [cp1x, cp1y];
                    } else if (prevCP2) {
                        path.cubicTo(prevCP2[0], prevCP2[1], cp1x, cp1y, x, y);
                    }
                    prevCP2 = [cp2x, cp2y];
                }
                if (closed && numPoints >= 2 && prevCP2) {
                    path.cubicTo(prevCP2[0], prevCP2[1], firstCP1[0], firstCP1[1], firstX, firstY);
                    path.close();
                } else if (closed) {
                    path.close();
                }
            }
        } else if (type === 4) { // Text
            reader.f32(); // fontSize
            reader.u32(); // textAlign
            reader.f32(); // lineHeight
            reader.string(); // fontFamily
            reader.string(); // content
            path.delete();
            return null;
        }
        return path;
    }

    private drawBinaryGeometry(canvas: Canvas, type: number, reader: BinaryReader, paint: Paint, cornerRadius: number = 0, fillRule: number = 0, nodeId: number = 0) {
        reader.u32(); // skip size

        if (type === 1) { // Rect
            const w = reader.f32();
            const h = reader.f32();
            if (cornerRadius > 0) {
                // Clamp the radius so opposite corners never overlap
                const r = Math.min(cornerRadius, w / 2, h / 2);
                canvas.drawRRect(this.ck.RRectXY(this.ck.LTRBRect(0, 0, w, h), r, r), paint);
            } else {
                canvas.drawRect(this.ck.LTRBRect(0, 0, w, h), paint);
            }
        } else if (type === 2) { // Ellipse
            const rx = reader.f32();
            const ry = reader.f32();
            canvas.drawOval(this.ck.LTRBRect(-rx, -ry, rx, ry), paint);
        } else if (type === 0) { // Path
            const numSubpaths = reader.u32();

            // Check path cache first
            const cached = this._pathCache.get(nodeId);
            if (cached && nodeId > 0) {
                // Skip past the binary path data (we already have the cached CK path)
                for (let s = 0; s < numSubpaths; s++) {
                    reader.u32(); // closed
                    const numPoints = reader.u32();
                    reader.offset += numPoints * 6 * 4; // 6 floats per point × 4 bytes
                }
                // Apply fill rule if it changed
                if (fillRule !== cached.fillRule) {
                    cached.path.setFillType(
                        fillRule === 1 ? this.ck.FillType.EvenOdd : this.ck.FillType.Winding,
                    );
                    cached.fillRule = fillRule;
                }
                canvas.drawPath(cached.path, paint);
                return;
            }

            const path = new this.ck.Path();
            for (let s = 0; s < numSubpaths; s++) {
                const closed = reader.u32() === 1;
                const numPoints = reader.u32();
                let prevCP2: [number, number] | null = null;
                let firstX = 0, firstY = 0, firstCP1: [number, number] = [0, 0];

                for (let p = 0; p < numPoints; p++) {
                    const x = reader.f32(); const y = reader.f32();
                    const cp1x = reader.f32(); const cp1y = reader.f32();
                    const cp2x = reader.f32(); const cp2y = reader.f32();
                    
                    if (p === 0) {
                        path.moveTo(x, y);
                        firstX = x; firstY = y;
                        firstCP1 = [cp1x, cp1y];
                    } else if (prevCP2) {
                        path.cubicTo(prevCP2[0], prevCP2[1], cp1x, cp1y, x, y);
                    }
                    prevCP2 = [cp2x, cp2y];
                }
                if (closed && numPoints >= 2 && prevCP2) {
                    path.cubicTo(prevCP2[0], prevCP2[1], firstCP1[0], firstCP1[1], firstX, firstY);
                    path.close();
                } else if (closed) {
                    path.close();
                }
            }
            // Apply fill rule (EvenOdd vs NonZero/Winding)
            if (fillRule === 1) {
                path.setFillType(this.ck.FillType.EvenOdd);
            }
            canvas.drawPath(path, paint);

            // Cache the path for future frames (copy so it survives reuse)
            if (nodeId > 0) {
                this._pathCache.set(nodeId, { path: path.copy(), fillRule });
            }
            path.delete();
        } else if (type === 4) { // Text
            const fontSize = reader.f32();
            const textAlign = reader.u32();   // 0=Left, 1=Center, 2=Right
            const lineHeight = reader.f32();  // multiplier
            const fontFamily = reader.string();
            const content = reader.string();

            // Map text_align to CanvasKit TextAlign enum
            const ckTextAlign = textAlign === 1 ? this.ck.TextAlign.Center
                : textAlign === 2 ? this.ck.TextAlign.Right
                : this.ck.TextAlign.Left;

            // Extract current fill color from paint for the paragraph text style
            const paintColor = paint.getColor();

            // Try Paragraph API for rich text rendering
            const fontProvider = buildFontProvider(this.ck);
            const fontFamilies = fontFamily ? [fontFamily, 'sans-serif'] : ['sans-serif'];

            try {
                const paraStyle = new this.ck.ParagraphStyle({
                    textStyle: {
                        color: this.ck.Color4f(paintColor[0], paintColor[1], paintColor[2], paintColor[3]),
                        fontSize: fontSize,
                        fontFamilies: fontFamilies,
                        heightMultiplier: lineHeight,
                    },
                    textAlign: ckTextAlign,
                });

                let builder;
                if (fontProvider && fontFamily) {
                    builder = this.ck.ParagraphBuilder.MakeFromFontProvider(paraStyle, fontProvider);
                } else {
                    const defaultFontMgr = this.ck.FontMgr.RefDefault();
                    builder = this.ck.ParagraphBuilder.Make(paraStyle, defaultFontMgr);
                }

                builder.addText(content);
                const para = builder.build();
                // Layout with a generous max width; for left/center/right to matter,
                // we use approx width based on content length (or a fixed large width).
                const layoutWidth = content.includes('\n') ? content.length * fontSize * 0.6 : 1e5;
                para.layout(layoutWidth);

                canvas.drawParagraph(para, 0, -fontSize);

                para.delete();
                builder.delete();
            } catch {
                // Fallback: use simple TextBlob if Paragraph API fails
                const font = new this.ck.Font(null, fontSize);
                const blob = this.ck.TextBlob.MakeFromText(content, font);
                if (blob) {
                    canvas.drawTextBlob(blob, 0, 0, paint);
                    blob.delete();
                }
                font.delete();
            }

            // Trigger lazy font loading if font isn't cached yet
            if (fontFamily && !isFontLoaded(fontFamily)) {
                loadGoogleFontData(fontFamily); // fire-and-forget; repaint via callback
            }
            // Clean up font provider
            if (fontProvider) fontProvider.delete();
        }
    }

    /** Light outline around the node under the cursor (Figma-style hover). */
    private drawHoverOutline(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (!im || im.isMouseDown || im.hoverNodeId === null) return;
        const id = im.hoverNodeId;
        // Skip if already selected — the selection overlay covers it
        if (this.scene.getSelection().includes(id)) return;

        const b = this.scene.getNodeBounds(id);
        if (b[2] <= b[0] || b[3] <= b[1]) return;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const op = this.ensureOverlayPaints();
        op.hoverOutline.setStrokeWidth(1.5 / this.zoom);
        canvas.drawRect(this.ck.LTRBRect(b[0], b[1], b[2], b[3]), op.hoverOutline);
        canvas.restore();
    }

    private renderSelectionOverlay(canvas: Canvas, dpr: number) {
        const selection = this.scene.getSelection();
        if (selection.length === 0) return;

        const live = this.inputManager?.liveResizeBounds;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const op = this.ensureOverlayPaints();
        op.selOutline.setStrokeWidth(1.0 / this.zoom);

        let totalMinX = Infinity, totalMinY = Infinity, totalMaxX = -Infinity, totalMaxY = -Infinity;

        // Draw individual outlines
        for (const id of selection) {
            const nodeTypeNum = this.scene.getNodeType(id);
            if (nodeTypeNum === undefined) continue;

            const bounds = this.scene.getNodeBounds(id);
            totalMinX = Math.min(totalMinX, bounds[0]);
            totalMinY = Math.min(totalMinY, bounds[1]);
            totalMaxX = Math.max(totalMaxX, bounds[2]);
            totalMaxY = Math.max(totalMaxY, bounds[3]);

            // Skip individual outlines for multi-selection to avoid clutter/lag
            if (selection.length > 5 && !live) continue;

            if (nodeTypeNum === 3) { // Group
                const [gMinX, gMinY, gMaxX, gMaxY] = bounds;
                canvas.drawRect(this.ck.LTRBRect(gMinX, gMinY, gMaxX, gMaxY), op.selOutline);
            } else {
                const transform = this.scene.getTransform(id);
                canvas.save();
                canvas.concat(transform);
                
                const geo = this.scene.getNodeGeometry(id);
                if (geo.Rect) {
                    canvas.drawRect(this.ck.LTRBRect(0, 0, geo.Rect.width, geo.Rect.height), op.selOutline);
                } else if (geo.Ellipse) {
                    canvas.drawOval(this.ck.LTRBRect(-geo.Ellipse.radius_x, -geo.Ellipse.radius_y, geo.Ellipse.radius_x, geo.Ellipse.radius_y), op.selOutline);
                } else if (geo.Path) {
                    // Use the resolved (corner-radius-rounded) outline so the
                    // outline matches the rendered shape and the resize handles.
                    const resolved = this.scene.getResolvedSubpaths(id);
                    const pathBounds = this.calculatePathBounds({ subpaths: resolved });
                    canvas.drawRect(this.ck.LTRBRect(pathBounds.minX, pathBounds.minY, pathBounds.maxX, pathBounds.maxY), op.selOutline);
                } else if (geo.Text) {
                    const approxW = geo.Text.content.length * geo.Text.font_size * 0.6;
                    canvas.drawRect(this.ck.LTRBRect(0, -geo.Text.font_size, approxW, 0), op.selOutline);
                }
                canvas.restore();
            }
        }

        // Use live bounds if dragging a resize handle for zero-lag feedback
        let hMinX = totalMinX, hMinY = totalMinY, hMaxX = totalMaxX, hMaxY = totalMaxY;
        if (live) {
            hMinX = live.x;
            hMinY = live.y;
            hMaxX = live.x + live.w;
            hMaxY = live.y + live.h;
        }

        // Draw global bounding box and handles (skip in node-editing mode — anchors replace resize handles)
        const isNodeEditing = this.inputManager?.editingNodeId != null;
        if (hMaxX > hMinX && hMaxY > hMinY && !isNodeEditing) {
            if (selection.length > 1 || live) {
                canvas.drawRect(this.ck.LTRBRect(hMinX, hMinY, hMaxX, hMaxY), op.selOutline);
            }

            const hSize = 4 / this.zoom;
            const midX = (hMinX + hMaxX) / 2;
            const midY = (hMinY + hMaxY) / 2;

            const handlePositions = [
                [hMinX, hMinY], [midX, hMinY], [hMaxX, hMinY],
                [hMinX, midY],                 [hMaxX, midY],
                [hMinX, hMaxY], [midX, hMaxY], [hMaxX, hMaxY],
            ];

            op.selHandleStroke.setStrokeWidth(1.0 / this.zoom);

            for (const [hx, hy] of handlePositions) {
                canvas.drawRect(this.ck.LTRBRect(hx - hSize, hy - hSize, hx + hSize, hy + hSize), op.selHandleFill);
                canvas.drawRect(this.ck.LTRBRect(hx - hSize, hy - hSize, hx + hSize, hy + hSize), op.selHandleStroke);
            }
        }

        // Draw corner radius handles for single selection (Rect only — skip in node-editing mode)
        if (selection.length === 1 && !live && !isNodeEditing) {
            const id = selection[0];
            const node = this.scene.getNode(id);
            if (node && node.geometry.Rect) {
                const style = node.style;
                const rect = node.geometry.Rect;
                const radius = style.corner_radius || 0;
                const transform = this.scene.getTransform(id);

                canvas.save();
                canvas.concat(transform);
                
                // Draw 4 handles inside the corners
                // Use a minimum visual offset so they are always draggable
                const visualMin = 14 / this.zoom;
                const rx = Math.min(Math.max(radius, visualMin), rect.width / 2);
                const ry = Math.min(Math.max(radius, visualMin), rect.height / 2);
                
                const handlePos = [
                    [rx, ry],
                    [rect.width - rx, ry],
                    [rect.width - rx, rect.height - ry],
                    [rx, rect.height - ry]
                ];

                const hSize = 3.5 / this.zoom;
                for (const [hx, hy] of handlePos) {
                    canvas.drawCircle(hx, hy, hSize, op.selHandleFill);
                    canvas.drawCircle(hx, hy, hSize, op.selHandleStroke);
                }
                canvas.restore();
            }
        }

        canvas.restore();
    }

    calculatePathBounds(path: { subpaths: Array<{ points: Array<{ x: number; y: number; cp1: [number, number]; cp2: [number, number] }>; closed: boolean }> }) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let hasPoints = false;
        for (const sp of path.subpaths) {
            const pts = sp.points;
            const n = pts.length;
            if (n === 0) continue;
            // Include the first anchor
            hasPoints = true;
            minX = Math.min(minX, pts[0].x);
            minY = Math.min(minY, pts[0].y);
            maxX = Math.max(maxX, pts[0].x);
            maxY = Math.max(maxY, pts[0].y);
            // Flatten each cubic segment and include sampled points
            for (let i = 1; i < n; i++) {
                const a = pts[i - 1];
                const b = pts[i];
                this.flattenCubicBounds(
                    a.x, a.y, a.cp2[0], a.cp2[1],
                    b.cp1[0], b.cp1[1], b.x, b.y,
                    (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
                );
            }
            if (sp.closed && n >= 2) {
                const a = pts[n - 1];
                const b = pts[0];
                this.flattenCubicBounds(
                    a.x, a.y, a.cp2[0], a.cp2[1],
                    b.cp1[0], b.cp1[1], b.x, b.y,
                    (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
                );
            }
        }
        return hasPoints ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }

    /** Subdivide a cubic Bézier and call cb for sampled points along the curve. */
    private flattenCubicBounds(
        x0: number, y0: number, x1: number, y1: number,
        x2: number, y2: number, x3: number, y3: number,
        cb: (x: number, y: number) => void
    ) {
        // Adaptive subdivision: split until segments are flat enough
        const stack: [number, number, number, number, number, number, number, number][] =
            [[x0, y0, x1, y1, x2, y2, x3, y3]];
        const tolerance = 0.5;
        while (stack.length > 0) {
            const [ax, ay, bx, by, cx, cy, dx, dy] = stack.pop()!;
            // Flatness test: max distance of control points from the line a→d
            const ux = 3 * bx - 2 * ax - dx;
            const uy = 3 * by - 2 * ay - dy;
            const vx = 3 * cx - ax - 2 * dx;
            const vy = 3 * cy - ay - 2 * dy;
            const maxDist = Math.max(ux * ux, vx * vx) + Math.max(uy * uy, vy * vy);
            if (maxDist <= 16 * tolerance * tolerance) {
                cb(dx, dy);
            } else {
                // De Casteljau split at t=0.5
                const abx = (ax + bx) / 2, aby = (ay + by) / 2;
                const bcx = (bx + cx) / 2, bcy = (by + cy) / 2;
                const cdx = (cx + dx) / 2, cdy = (cy + dy) / 2;
                const abcx = (abx + bcx) / 2, abcy = (aby + bcy) / 2;
                const bcdx = (bcx + cdx) / 2, bcdy = (bcy + cdy) / 2;
                const mx = (abcx + bcdx) / 2, my = (abcy + bcdy) / 2;
                // Push second half first so first half is processed next
                stack.push([mx, my, bcdx, bcdy, cdx, cdy, dx, dy]);
                stack.push([ax, ay, abx, aby, abcx, abcy, mx, my]);
            }
        }
    }

    private drawGrid(canvas: Canvas, dpr: number) {
        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const op = this.ensureOverlayPaints();
        op.gridPaint.setStrokeWidth(0.5 / this.zoom);

        // Compute visible area in world coords
        const w = this.canvas.width / dpr;
        const h = this.canvas.height / dpr;
        const startX = Math.floor(-this.pan.x / this.zoom / 50) * 50;
        const startY = Math.floor(-this.pan.y / this.zoom / 50) * 50;
        const endX = startX + w / this.zoom + 100;
        const endY = startY + h / this.zoom + 100;

        for (let x = startX; x <= endX; x += 50) {
            canvas.drawLine(x, startY, x, endY, op.gridPaint);
        }
        for (let y = startY; y <= endY; y += 50) {
            canvas.drawLine(startX, y, endX, y, op.gridPaint);
        }

        canvas.restore();
    }

    drawArtboard(canvas: Canvas) {
        const op = this.ensureOverlayPaints();

        // Use dynamic document size from engine
        const w = this.scene.engine?.get_document_width() ?? 1000;
        const h = this.scene.engine?.get_document_height() ?? 1000;

        // Artboard is at world origin (0,0)
        canvas.drawRect(this.ck.LTRBRect(0, 0, w, h), op.artboardFill);
        
        // Artboard border
        op.artboardStroke.setStrokeWidth(1 / this.zoom);
        canvas.drawRect(this.ck.LTRBRect(0, 0, w, h), op.artboardStroke);
    }

    private drawDirectEditHandles(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (!im || !im.editingPoints || im.editingNodeId === null || !im.editingTransform) return;

        const points = im.editingPoints;
        const t = im.editingTransform;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const dotSize = 4 / this.zoom;
        const handleSize = 3.5 / this.zoom;
        const lineWidth = 1 / this.zoom;

        const linePaint = new this.ck.Paint();
        linePaint.setColor(this.ck.Color(150, 150, 150, 0.8));
        linePaint.setStyle(this.ck.PaintStyle.Stroke);
        linePaint.setStrokeWidth(lineWidth);

        const anchorFill = new this.ck.Paint();
        anchorFill.setColor(this.ck.Color(255, 255, 255, 1.0));
        anchorFill.setStyle(this.ck.PaintStyle.Fill);

        const anchorStroke = new this.ck.Paint();
        anchorStroke.setColor(this.ck.Color(0, 162, 255, 1.0));
        anchorStroke.setStyle(this.ck.PaintStyle.Stroke);
        anchorStroke.setStrokeWidth(lineWidth * 1.5);

        const selectedFill = new this.ck.Paint();
        selectedFill.setColor(this.ck.Color(0, 162, 255, 1.0));
        selectedFill.setStyle(this.ck.PaintStyle.Fill);

        const handleFill = new this.ck.Paint();
        handleFill.setColor(this.ck.Color(0, 162, 255, 1.0));
        handleFill.setStyle(this.ck.PaintStyle.Fill);

        // Draw hover segment highlight
        if (im.hoverSegment) {
            const h = im.hoverSegment;
            const sp = points[h.subpathIndex];
            const p1 = sp.points[h.segmentIndex];
            const p2 = sp.points[(h.segmentIndex + 1) % sp.points.length];
            
            // Only draw if not closed or not at the end
            if (sp.closed || h.segmentIndex < sp.points.length - 1) {
                const highlightPaint = new this.ck.Paint();
                highlightPaint.setColor(this.ck.Color(0, 162, 255, 0.4));
                highlightPaint.setStyle(this.ck.PaintStyle.Stroke);
                highlightPaint.setStrokeWidth(lineWidth * 3);

                const path = new this.ck.Path();
                const a1 = { x: t[0] * p1.x + t[1] * p1.y + t[2], y: t[3] * p1.x + t[4] * p1.y + t[5] };
                const c1 = { x: t[0] * p1.cp2[0] + t[1] * p1.cp2[1] + t[2], y: t[3] * p1.cp2[0] + t[4] * p1.cp2[1] + t[5] };
                const c2 = { x: t[0] * p2.cp1[0] + t[1] * p2.cp1[1] + t[2], y: t[3] * p2.cp1[0] + t[4] * p2.cp1[1] + t[5] };
                const a2 = { x: t[0] * p2.x + t[1] * p2.y + t[2], y: t[3] * p2.x + t[4] * p2.y + t[5] };
                
                path.moveTo(a1.x, a1.y);
                path.cubicTo(c1.x, c1.y, c2.x, c2.y, a2.x, a2.y);
                canvas.drawPath(path, highlightPaint);
                
                path.delete();
                highlightPaint.delete();
            }
        }

        for (let si = 0; si < points.length; si++) {
            const sp = points[si];
            for (let i = 0; i < sp.points.length; i++) {
                const p = sp.points[i];
                const ax = t[0] * p.x + t[1] * p.y + t[2];
                const ay = t[3] * p.x + t[4] * p.y + t[5];
                const c1x = t[0] * p.cp1[0] + t[1] * p.cp1[1] + t[2];
                const c1y = t[3] * p.cp1[0] + t[4] * p.cp1[1] + t[5];
                const c2x = t[0] * p.cp2[0] + t[1] * p.cp2[1] + t[2];
                const c2y = t[3] * p.cp2[0] + t[4] * p.cp2[1] + t[5];

                const isSmooth = Math.abs(c1x - ax) > 0.5 || Math.abs(c1y - ay) > 0.5;
                if (isSmooth) {
                    canvas.drawLine(ax, ay, c1x, c1y, linePaint);
                    canvas.drawLine(ax, ay, c2x, c2y, linePaint);
                    canvas.drawCircle(c1x, c1y, handleSize, handleFill);
                    canvas.drawCircle(c2x, c2y, handleSize, handleFill);
                }

                const isSelected = im.selectedPoints.has(`${si}:${i}`);
                canvas.drawCircle(ax, ay, dotSize, isSelected ? selectedFill : anchorFill);
                canvas.drawCircle(ax, ay, dotSize, anchorStroke);
            }
        }

        linePaint.delete();
        anchorFill.delete();
        anchorStroke.delete();
        handleFill.delete();
        canvas.restore();
    }

    /** Draw a preview dot for the scissors / add-point hover. */
    private drawScissorsPreview(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (!im || !im.scissorsHoverPoint) return;

        const { x, y } = im.scissorsHoverPoint;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const radius = 5 / this.zoom;
        const lineWidth = 1.5 / this.zoom;

        const fill = new this.ck.Paint();
        fill.setColor(this.ck.Color(0, 162, 255, 1.0));
        fill.setStyle(this.ck.PaintStyle.Fill);

        const stroke = new this.ck.Paint();
        stroke.setColor(this.ck.Color(255, 255, 255, 1.0));
        stroke.setStyle(this.ck.PaintStyle.Stroke);
        stroke.setStrokeWidth(lineWidth);

        canvas.drawCircle(x, y, radius, fill);
        canvas.drawCircle(x, y, radius, stroke);

        fill.delete();
        stroke.delete();
        canvas.restore();
    }

    private drawPreview(canvas: Canvas) {
        const preview = this.inputManager?.previewRect;
        if (!preview || preview.w < 1 || preview.h < 1) return;

        const { x, y, w, h, tool } = preview;
        const rect = this.ck.LTRBRect(x, y, x + w, y + h);
        const isCustomShape = tool !== 'rect' && tool !== 'ellipse';
        const shapePath = isCustomShape ? this.makePreviewPath(tool, x, y, w, h) : null;

        const fillPaint = new this.ck.Paint();
        fillPaint.setColor(this.ck.Color(100, 149, 237, 0.3));
        fillPaint.setStyle(this.ck.PaintStyle.Fill);

        if (tool === 'rect') canvas.drawRect(rect, fillPaint);
        else if (tool === 'ellipse') canvas.drawOval(rect, fillPaint);
        else canvas.drawPath(shapePath!, fillPaint);

        const strokePaint = new this.ck.Paint();
        strokePaint.setColor(this.ck.Color(0, 162, 255, 1.0));
        strokePaint.setStyle(this.ck.PaintStyle.Stroke);
        strokePaint.setStrokeWidth(1.5 / this.zoom);

        if (tool === 'rect') canvas.drawRect(rect, strokePaint);
        else if (tool === 'ellipse') canvas.drawOval(rect, strokePaint);
        else canvas.drawPath(shapePath!, strokePaint);

        shapePath?.delete();
        fillPaint.delete();
        strokePaint.delete();
    }

    private makePreviewPath(tool: string, x: number, y: number, w: number, h: number) {
        const cx = x + w / 2;
        const cy = y + h / 2;
        const r = Math.min(w, h) / 2;
        const path = new this.ck.Path();

        if (tool === 'polygon') {
            const sides = 6;
            for (let i = 0; i < sides; i++) {
                const angle = (i * 2 * Math.PI / sides) - Math.PI / 2;
                const px = cx + r * Math.cos(angle);
                const py = cy + r * Math.sin(angle);
                if (i === 0) path.moveTo(px, py);
                else path.lineTo(px, py);
            }
            path.close();
        } else {
            const points = 5;
            const outerR = r;
            const innerR = r * 0.4;
            for (let i = 0; i < points * 2; i++) {
                const angle = (i * Math.PI / points) - Math.PI / 2;
                const cr = i % 2 === 0 ? outerR : innerR;
                const px = cx + cr * Math.cos(angle);
                const py = cy + cr * Math.sin(angle);
                if (i === 0) path.moveTo(px, py);
                else path.lineTo(px, py);
            }
            path.close();
        }
        return path;
    }

    /** Magenta alignment guides for active snaps, spanning the viewport. */
    private drawSnapGuides(canvas: Canvas, minX: number, minY: number, maxX: number, maxY: number) {
        const guides = this.inputManager?.activeSnapGuides;
        if (!guides || guides.length === 0) return;

        const paint = new this.ck.Paint();
        paint.setColor(this.ck.Color(255, 51, 170, 0.9));
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1 / this.zoom);
        paint.setAntiAlias(true);

        for (const g of guides) {
            if (g.axis === 'x') {
                canvas.drawLine(g.pos, minY, g.pos, maxY, paint);
            } else {
                canvas.drawLine(minX, g.pos, maxX, g.pos, paint);
            }
        }
        paint.delete();
    }

    private drawMarquee(canvas: Canvas) {
        const marquee = this.inputManager?.marqueeRect;
        if (!marquee || marquee.w < 1 || marquee.h < 1) return;

        const { x, y, w, h } = marquee;
        const rect = this.ck.LTRBRect(x, y, x + w, y + h);

        const fillPaint = new this.ck.Paint();
        fillPaint.setColor(this.ck.Color(0, 120, 255, 0.08));
        fillPaint.setStyle(this.ck.PaintStyle.Fill);
        canvas.drawRect(rect, fillPaint);

        const strokePaint = new this.ck.Paint();
        strokePaint.setColor(this.ck.Color(0, 120, 255, 0.7));
        strokePaint.setStyle(this.ck.PaintStyle.Stroke);
        strokePaint.setStrokeWidth(1 / this.zoom);
        canvas.drawRect(rect, strokePaint);

        fillPaint.delete();
        strokePaint.delete();
    }

    private drawPenPreview(canvas: Canvas) {
        const points = this.inputManager?.currentPathPoints;
        if (!points || points.length === 0) return;

        const strokePaint = new this.ck.Paint();
        strokePaint.setColor(this.ck.Color(0, 162, 255, 1.0));
        strokePaint.setStyle(this.ck.PaintStyle.Stroke);
        strokePaint.setStrokeWidth(2 / this.zoom);

        if (points.length >= 2) {
            const path = new this.ck.Path();
            path.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) {
                const prev = points[i - 1];
                const p = points[i];
                path.cubicTo(prev.cp2x, prev.cp2y, p.cp1x, p.cp1y, p.x, p.y);
            }
            canvas.drawPath(path, strokePaint);
            path.delete();
        }

        const dotPaint = new this.ck.Paint();
        const handleLinePaint = new this.ck.Paint();
        handleLinePaint.setColor(this.ck.Color(150, 150, 150, 0.8));
        handleLinePaint.setStyle(this.ck.PaintStyle.Stroke);
        handleLinePaint.setStrokeWidth(1 / this.zoom);

        const handleDotPaint = new this.ck.Paint();
        handleDotPaint.setColor(this.ck.Color(0, 162, 255, 1.0));
        handleDotPaint.setStyle(this.ck.PaintStyle.Fill);

        dotPaint.setStyle(this.ck.PaintStyle.Fill);
        const dotSize = 4 / this.zoom;
        const handleSize = 3 / this.zoom;

        for (const p of points) {
            const hasCurve = Math.abs(p.cp1x - p.x) > 0.5 || Math.abs(p.cp1y - p.y) > 0.5;
            if (hasCurve) {
                canvas.drawLine(p.x, p.y, p.cp1x, p.cp1y, handleLinePaint);
                canvas.drawLine(p.x, p.y, p.cp2x, p.cp2y, handleLinePaint);
                canvas.drawCircle(p.cp1x, p.cp1y, handleSize, handleDotPaint);
                canvas.drawCircle(p.cp2x, p.cp2y, handleSize, handleDotPaint);
            }

            dotPaint.setColor(this.ck.Color(255, 255, 255, 1.0));
            dotPaint.setStyle(this.ck.PaintStyle.Fill);
            canvas.drawRect(this.ck.LTRBRect(p.x - dotSize, p.y - dotSize, p.x + dotSize, p.y + dotSize), dotPaint);
            dotPaint.setColor(this.ck.Color(0, 162, 255, 1.0));
            dotPaint.setStyle(this.ck.PaintStyle.Stroke);
            dotPaint.setStrokeWidth(1 / this.zoom);
            canvas.drawRect(this.ck.LTRBRect(p.x - dotSize, p.y - dotSize, p.x + dotSize, p.y + dotSize), dotPaint);
        }

        handleLinePaint.delete();
        handleDotPaint.delete();
        strokePaint.delete();
        dotPaint.delete();
    }

    private drawFilledFaces(canvas: Canvas) {
        if (!this.scene.engine) return;
        try {
            // Use cached faces data to avoid JSON.parse every frame
            if (!this._filledFacesCache) {
                const json = this.scene.engine.get_filled_faces();
                const parsed = JSON.parse(json);
                this._filledFacesCache = { data: parsed || [] };
            }
            const faces = this._filledFacesCache.data;
            if (faces.length === 0) return;

            if (!this.paint) this.paint = new this.ck.Paint();
            const paint = this.paint;
            paint.setStyle(this.ck.PaintStyle.Fill);
            paint.setAntiAlias(true);

            for (const face of faces) {
                const boundary = face.boundary;
                if (!boundary || boundary.length < 3) continue;

                const path = new this.ck.Path();
                path.moveTo(boundary[0][0], boundary[0][1]);
                for (let i = 1; i < boundary.length; i++) {
                    path.lineTo(boundary[i][0], boundary[i][1]);
                }
                path.close();

                const f = face.fill;
                paint.setColor(this.ck.Color(f.r * 255, f.g * 255, f.b * 255, f.a));
                canvas.drawPath(path, paint);
                path.delete();
            }
        } catch {}
    }

    private drawPaintBucketHover(canvas: Canvas) {
        if (this.hoverFaceId < 0 || !this.scene.engine) return;
        try {
            const json = this.scene.engine.get_face_boundary(this.hoverFaceId);
            const boundary = JSON.parse(json);
            if (!boundary || boundary.length < 3) return;

            const path = new this.ck.Path();
            path.moveTo(boundary[0][0], boundary[0][1]);
            for (let i = 1; i < boundary.length; i++) {
                path.lineTo(boundary[i][0], boundary[i][1]);
            }
            path.close();

            const paint = new this.ck.Paint();
            paint.setColor(this.ck.Color(66, 133, 244, 0.3));
            paint.setStyle(this.ck.PaintStyle.Fill);
            paint.setAntiAlias(true);
            canvas.drawPath(path, paint);

            paint.setColor(this.ck.Color(66, 133, 244, 0.8));
            paint.setStyle(this.ck.PaintStyle.Stroke);
            paint.setStrokeWidth(1.5 / this.zoom);
            canvas.drawPath(path, paint);

            path.delete();
            paint.delete();
        } catch {}
    }
}
