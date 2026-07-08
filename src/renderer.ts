import type { Canvas, CanvasKit, Paint, Path, Surface } from 'canvaskit-wasm';

/** A Live Paint outline point: anchor + incoming/outgoing bézier handles. */
type OutlinePt = { x: number; y: number; cp1: number[]; cp2: number[] };
import { buildFontProvider, isFontLoaded, loadGoogleFontData, onFontLoaded } from './fonts';

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
import type { Artboard } from './types';

/** Resize-handle direction for an artboard. */
export type ArtboardHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

// Render protocol (see engine/src/lib.rs "Render Protocol"). These MUST match
// the RENDER_PROTOCOL_MAGIC / RENDER_PROTOCOL_VERSION constants the engine emits.
// Bump EXPECTED_RENDER_PROTOCOL_VERSION here in lockstep with any change to the
// render-buffer layout on either side; a mismatch means engine/pkg is stale
// (rebuild wasm) or renderer.ts is out of date.
const RENDER_PROTOCOL_MAGIC = 0x31434556; // ASCII "VEC1", little-endian
const EXPECTED_RENDER_PROTOCOL_VERSION = 10; // v10: in-stream Live Paint faces/edges (CMD 7/8)

/** One decoded effect record from the render buffer. */
interface EffectRecord {
    kind: number; // 0 = blur, 1 = drop shadow, 2 = color matrix
    radius: number; dx: number; dy: number;
    r: number; g: number; b: number; a: number;
    matrix?: number[]; // 20 floats, for kind 2
    linearRGB?: boolean; // for kind 2: apply matrix in linearRGB space
}

export class Renderer {
    /** Local-space bounding box of a text node's rendered glyphs, used for the
     *  selection frame. Measures with the Font glyph-width API (getGlyphPaths
     *  isn't available in this build). Falls back to an em-based estimate. */
    getTextLocalBounds(id: number): { x: number; y: number; w: number; h: number } | null {
        const node = this.scene.getNode(id);
        if (!node || !node.geometry.Text) return null;
        const geo = node.geometry.Text;
        const fontSize = geo.font_size;
        const lineHeight = geo.line_height || 1.2;
        const lines = (geo.content || '').split('\n');
        let width = 0;
        try {
            const font = new this.ck.Font(null, fontSize);
            for (const line of lines) {
                if (!line) continue;
                const widths = font.getGlyphWidths(font.getGlyphIDs(line));
                let w = 0;
                for (let k = 0; k < widths.length; k++) w += widths[k];
                if (w > width) width = w;
            }
            font.delete();
        } catch { width = 0; }
        if (width <= 0) width = Math.max(1, geo.content.length) * fontSize * 0.6;
        const h = fontSize + (lines.length - 1) * fontSize * lineHeight;
        // Alignment anchors the text around the origin (center → -w/2, right → -w).
        const offsetX = geo.text_align === 1 ? -width / 2 : geo.text_align === 2 ? -width : 0;
        return { x: offsetX, y: -fontSize, w: width, h };
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
    hoverEdgeId: number = -1;
    /** UI-level selected artboard (drawn highlighted with resize handles). */
    selectedArtboardId: number | null = null;

    // ─── Cached Resources (avoid per-frame allocation) ───
    private paint: Paint | null = null;

    // ─── Dirty-frame gating ───
    /** When false, the rAF loop skips rendering. Set to true by requestRender(). */
    private _needsRender = true;
    /** One-shot guard so a render-protocol desync logs once, not every frame. */
    private _protocolDesyncWarned = false;
    /** Node id of the text being edited inline (skipped while its overlay is up). */
    editingTextId: number | null = null;
    private get _editingTextId(): number | null { return this.editingTextId; }
    /** Dedicated SrcIn paint for compositing masked-content layers. */
    private _maskPaint: Paint | null = null;
    /** Stack of mask_type values (0 = alpha, 1 = luminance) matching the
     *  CMD_BEGIN_MASK / CMD_END_MASK nesting. */
    private _maskTypeStack: number[] = [];
    /** Dedicated paint with luminance→alpha color filter for luminance masks. */
    private _lumaPaint: Paint | null = null;
    /** True while rendering into an offscreen surface for PNG export. */
    private _exporting = false;
    /** World-space bounds to export (defaults to the primary artboard). */
    private _exportBounds: { x: number; y: number; w: number; h: number } | null = null;
    /** Solid background to fill behind exported content (null = transparent). */
    private _exportBackground: { r: number; g: number; b: number; a: number } | null = null;

    // ─── Path object cache (avoid rebuilding CanvasKit paths every frame) ───
    private _pathCache: Map<number, { path: ReturnType<CanvasKit['Path']['prototype']['copy']>; fillRule: number }> = new Map();

    // ─── Gradient shader cache ───
    private _gradientCache: Map<string, ReturnType<CanvasKit['Shader']['MakeLinearGradient']>> = new Map();
    // Decoded images keyed by engine image id. Images are immutable and
    // content-addressed, so an id maps to stable bytes for the life of a
    // document — the cache survives edits/undo and is only cleared on a full
    // document replacement (clearImageCache), where ids may be reused.
    private _imageCache: Map<number, ReturnType<CanvasKit['MakeImageFromEncoded']> | null> = new Map();
    private _imagePaint: Paint | null = null;
    // Repeating image shaders for pattern fills, keyed by pattern signature.
    private _patternShaderCache: Map<string, ReturnType<CanvasKit['Shader']['MakeLinearGradient']> | null> = new Map();
    // Effect (blur/shadow) ImageFilters, cached by effect signature — built once
    // and reused across frames (cleared on invalidateRenderCaches).
    private _effectFilterCache: Map<string, ReturnType<CanvasKit['ImageFilter']['MakeBlur']> | null> = new Map();
    private _effectPaint: Paint | null = null;

    // ─── Filled faces cache ───

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

    /** Subscribers notified whenever zoom/pan change (view transform changed).
     *  Used by the inline text-edit overlay to stay glued over the glyphs. */
    private viewChangeCbs: Array<() => void> = [];
    /** Register a callback fired on every zoom/pan change. */
    onViewChange(cb: () => void) { this.viewChangeCbs.push(cb); }
    /** Notify view-change subscribers. Call after mutating zoom/pan directly. */
    notifyViewChange() { for (const cb of this.viewChangeCbs) cb(); }

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

        // Clear effect filter cache
        for (const f of this._effectFilterCache.values()) {
            if (f) f.delete();
        }
        this._effectFilterCache.clear();

        // Clear pattern shaders (cheap to rebuild from the cached tile image).
        for (const sh of this._patternShaderCache.values()) if (sh) sh.delete();
        this._patternShaderCache.clear();

        this._needsRender = true;
    }

    /** Build (or fetch a cached) ImageFilter chain for a node's effects.
     *  Effects stack: each filter takes the previous as input. */
    private getEffectFilter(effects: EffectRecord[]): ReturnType<CanvasKit['ImageFilter']['MakeBlur']> | null {
        const key = effects.map(e => `${e.kind}:${e.radius},${e.dx},${e.dy},${e.r},${e.g},${e.b},${e.a},${e.matrix?.join(',') ?? ''},${e.linearRGB ? 'L' : 'S'}`).join('|');
        const cached = this._effectFilterCache.get(key);
        if (cached !== undefined) return cached;
        let filter: ReturnType<CanvasKit['ImageFilter']['MakeBlur']> | null = null;
        for (const e of effects) {
            if (e.kind === 0) {
                const s = Math.max(0, e.radius);
                filter = this.ck.ImageFilter.MakeBlur(s, s, this.ck.TileMode.Decal, filter);
            } else if (e.kind === 1) {
                const s = Math.max(0, e.radius);
                const color = this.ck.Color4f(e.r, e.g, e.b, e.a);
                filter = this.ck.ImageFilter.MakeDropShadow(e.dx, e.dy, s, s, color, filter);
            } else if (e.kind === 2 && e.matrix && e.matrix.length === 20) {
                const cf = this.ck.ColorFilter.MakeMatrix(e.matrix);
                if (e.linearRGB) {
                    // SVG default: apply matrix in linearRGB space.
                    // Compose: sRGB→linear → matrix → linear→sRGB
                    const toLinear = this.ck.ColorFilter.MakeSRGBToLinearGamma();
                    const toSRGB = this.ck.ColorFilter.MakeLinearToSRGBGamma();
                    const linearMatrix = this.ck.ColorFilter.MakeCompose(toSRGB, this.ck.ColorFilter.MakeCompose(cf, toLinear));
                    filter = this.ck.ImageFilter.MakeColorFilter(linearMatrix, filter);
                } else {
                    filter = this.ck.ImageFilter.MakeColorFilter(cf, filter);
                }
            }
        }
        this._effectFilterCache.set(key, filter);
        return filter;
    }

    /** Drop all decoded images. Call when a different document is loaded (image
     *  ids may be reused for different bytes). Not called on ordinary edits. */
    clearImageCache() {
        for (const img of this._imageCache.values()) {
            if (img) img.delete();
        }
        this._imageCache.clear();
        for (const sh of this._patternShaderCache.values()) if (sh) sh.delete();
        this._patternShaderCache.clear();
        this._needsRender = true;
    }

    /** Decode (and cache) an engine image id into a CanvasKit Image, or null. */
    private getImage(imageId: number): ReturnType<CanvasKit['MakeImageFromEncoded']> | null {
        let img = this._imageCache.get(imageId);
        if (img === undefined) {
            const bytes = this.scene.engine?.get_image_bytes(imageId);
            img = (bytes && bytes.length > 0) ? this.ck.MakeImageFromEncoded(bytes) : null;
            this._imageCache.set(imageId, img ?? null);
        }
        return img;
    }

    /** Repeating image shader for a pattern fill: tiles the image over
     *  `width`×`height` local units, then applies the pattern transform
     *  ([a,b,c,d,e,f]) as the shader's local matrix. Cached by signature. */
    private getPatternShader(imageId: number, width: number, height: number, transform: number[]): ReturnType<CanvasKit['Shader']['MakeLinearGradient']> | null {
        const key = `${imageId}|${width}|${height}|${transform.join(',')}`;
        const cached = this._patternShaderCache.get(key);
        if (cached !== undefined) return cached;
        const img = this.getImage(imageId);
        let shader: ReturnType<CanvasKit['Shader']['MakeLinearGradient']> | null = null;
        if (img && img.width() > 0 && img.height() > 0 && width > 0 && height > 0) {
            const sx = width / img.width(), sy = height / img.height();
            const [a, b, c, d, e, f] = transform;
            // localMatrix = patternTransform · scale(image px → tile units), row-major 3x3.
            const m = [a * sx, c * sy, e, b * sx, d * sy, f, 0, 0, 1];
            shader = img.makeShaderOptions(
                this.ck.TileMode.Repeat, this.ck.TileMode.Repeat,
                this.ck.FilterMode.Linear, this.ck.MipmapMode.None, m,
            );
        }
        this._patternShaderCache.set(key, shader);
        return shader;
    }

    /** Draw a raster image node at (0,0,w,h) in the current (local) space. */
    private drawImageNode(canvas: Canvas, imageId: number, w: number, h: number, alpha: number) {
        const img = this.getImage(imageId);
        if (!this._imagePaint) this._imagePaint = new this.ck.Paint();
        const ip = this._imagePaint;
        ip.setShader(null);
        ip.setStyle(this.ck.PaintStyle.Fill);
        const dst = this.ck.XYWHRect(0, 0, w, h);
        if (img) {
            ip.setColor(this.ck.Color4f(1, 1, 1, 1));
            ip.setAlphaf(alpha);
            const src = this.ck.XYWHRect(0, 0, img.width(), img.height());
            canvas.drawImageRect(img, src, dst, ip);
        } else {
            // Decode failed / missing bytes — draw a magenta placeholder.
            ip.setColor(this.ck.Color4f(1, 0, 1, 0.6 * alpha));
            canvas.drawRect(dst, ip);
        }
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

    zoomToFit(docW: number, docH: number, originX = 0, originY = 0) {
        const viewW = this.canvas.clientWidth;
        const viewH = this.canvas.clientHeight;
        if (viewW <= 0 || viewH <= 0) return;

        const margin = 48; // css px on each side
        const scale = Math.min(
            (viewW - margin * 2) / docW,
            (viewH - margin * 2) / docH,
        );
        this.zoom = Math.max(0.02, Math.min(4, scale));
        // Center the content bounds (which may start at a non-zero origin when
        // there are multiple artboards) in the viewport.
        this.pan.x = (viewW - docW * this.zoom) / 2 - originX * this.zoom;
        this.pan.y = (viewH - docH * this.zoom) / 2 - originY * this.zoom;
        this.notifyViewChange();
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
        this.notifyViewChange();
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
        this.notifyViewChange();
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
        // Fit the union of all artboards (name kept for API stability). Explicit
        // dims still override (used by callers that know the page size).
        if (docW !== undefined && docH !== undefined) {
            this.zoomToFit(docW, docH);
        } else {
            const b = this.getArtboardsBounds();
            this.zoomToFit(b.w, b.h, b.x, b.y);
        }
        this.render();
    }

    render() {
        if (!this.surface || !this.scene.engine) return;
        const canvas = this.surface.getCanvas();
        // In export mode we render into an offscreen surface at 1:1 (the export
        // scale is folded into this.zoom) with a transparent background and no
        // editor chrome (grid, artboard, selection, guides).
        const exporting = this._exporting;
        const dpr = exporting ? 1 : (window.devicePixelRatio || 1);

        if (exporting) {
            canvas.clear(this.ck.TRANSPARENT);
        } else {
            canvas.clear(this.ck.Color(43, 43, 43, 1.0));
            this.drawGrid(canvas, dpr);
        }

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        if (exporting && this._exportBackground && this._exportBounds) {
            const bg = this._exportBackground;
            const eb = this._exportBounds;
            const p = new this.ck.Paint();
            p.setColor(this.ck.Color(
                Math.round(bg.r * 255), Math.round(bg.g * 255), Math.round(bg.b * 255), bg.a,
            ));
            p.setStyle(this.ck.PaintStyle.Fill);
            canvas.drawRect(this.ck.LTRBRect(eb.x, eb.y, eb.x + eb.w, eb.y + eb.h), p);
            p.delete();
        }
        if (!exporting) this.drawArtboards(canvas);

        // Compute viewport in document space for culling. Export culls to the
        // export bounds (a specific artboard, or the whole canvas) so content
        // renders regardless of screen size or artboard origin.
        let viewportMinX: number, viewportMinY: number, viewportMaxX: number, viewportMaxY: number;
        if (exporting) {
            const b = this._exportBounds ?? { x: 0, y: 0, w: this.scene.engine.get_document_width(), h: this.scene.engine.get_document_height() };
            viewportMinX = b.x;
            viewportMinY = b.y;
            viewportMaxX = b.x + b.w;
            viewportMaxY = b.y + b.h;
        } else {
            viewportMinX = -this.pan.x / this.zoom;
            viewportMinY = -this.pan.y / this.zoom;
            viewportMaxX = (this.canvas.width / dpr - this.pan.x) / this.zoom;
            viewportMaxY = (this.canvas.height / dpr - this.pan.y) / this.zoom;
        }

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
        // No dimming in export output.
        const dimTarget = exporting ? null : (this.inputManager?.getEditingDimTarget() ?? null);

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
            } else if (cmdType === 4) { // CMD_BEGIN_MASK
                // Read mask_type: 0 = alpha, 1 = luminance (v8+).
                const maskType = reader.u32();
                this._maskTypeStack.push(maskType);
                if (maskType === 1) {
                    // Luminance mask: 3-layer protocol.
                    // Layer 0 (outer): collects the final masked result.
                    canvas.saveLayer();
                    // Layer 1 (luma): mask shapes are drawn here. On restore,
                    // the luminance→alpha color filter converts RGB to alpha.
                    if (!this._lumaPaint) {
                        this._lumaPaint = new this.ck.Paint();
                        // SVG luminance mask: A' = 0.2126·R + 0.7152·G + 0.0722·B
                        // (R,G,B are premultiplied, so we also account for source alpha).
                        const lumaMatrix = [
                            0, 0, 0, 0, 0,
                            0, 0, 0, 0, 0,
                            0, 0, 0, 0, 0,
                            0.2126, 0.7152, 0.0722, 0, 0,
                        ];
                        this._lumaPaint.setColorFilter(
                            this.ck.ColorFilter.MakeMatrix(lumaMatrix));
                    }
                    canvas.saveLayer(this._lumaPaint);
                } else {
                    // Alpha mask: 2-layer protocol (original).
                    // Isolated layer accumulating the mask shape's coverage.
                    canvas.saveLayer();
                }
            } else if (cmdType === 5) { // CMD_BEGIN_MASKED_CONTENT
                const maskType = this._maskTypeStack.length > 0
                    ? this._maskTypeStack[this._maskTypeStack.length - 1] : 0;
                if (maskType === 1) {
                    // Restore the luma layer: mask shapes are composited through
                    // the luminance→alpha filter into the outer layer.
                    canvas.restore();
                }
                // Content layer: on restore it composites into the mask/outer
                // layer with SrcIn, so content survives only where the mask has
                // coverage (alpha for alpha-masks, luminance-derived alpha for
                // luminance masks).
                if (!this._maskPaint) this._maskPaint = new this.ck.Paint();
                this._maskPaint.setBlendMode(this.ck.BlendMode.SrcIn);
                canvas.saveLayer(this._maskPaint);
            } else if (cmdType === 6) { // CMD_END_MASK
                if (this._maskTypeStack.length > 0) this._maskTypeStack.pop();
                canvas.restore(); // content → mask/outer layer (SrcIn)
                canvas.restore(); // masked result → canvas
            } else if (cmdType === 7) { // CMD_LP_FACES (Live Paint face fills)
                const faceCount = reader.u32();
                p.setStyle(this.ck.PaintStyle.Fill);
                p.setShader(null);
                p.setAntiAlias(true);
                for (let fi = 0; fi < faceCount; fi++) {
                    const r = reader.f32(), gg = reader.f32(), bb = reader.f32(), aa = reader.f32();
                    const path = this.readOutlinePath(reader, true);
                    p.setColor(this.ck.Color4f(r, gg, bb, aa));
                    canvas.drawPath(path, p);
                    path.delete();
                }
            } else if (cmdType === 8) { // CMD_LP_EDGES (Live Paint painted edges)
                const edgeCount = reader.u32();
                p.setStyle(this.ck.PaintStyle.Stroke);
                p.setShader(null);
                p.setAntiAlias(true);
                p.setStrokeCap(this.ck.StrokeCap.Round);
                p.setStrokeJoin(this.ck.StrokeJoin.Round);
                for (let ei = 0; ei < edgeCount; ei++) {
                    const r = reader.f32(), gg = reader.f32(), bb = reader.f32(), aa = reader.f32();
                    const width = reader.f32();
                    const path = this.readOutlinePath(reader, false);
                    p.setColor(this.ck.Color4f(r, gg, bb, aa));
                    p.setStrokeWidth(width > 0 ? width : 2);
                    canvas.drawPath(path, p);
                    path.delete();
                }
                p.setStrokeCap(this.ck.StrokeCap.Butt);
                p.setStrokeJoin(this.ck.StrokeJoin.Miter);
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
                            end: [reader.f32(), reader.f32()],
                            spread: reader.u32(),
                            focal: [reader.f32(), reader.f32(), reader.f32()], // fx, fy, fr
                        });
                    } else if (fillType === 4) { // Pattern
                        fills.push({
                            type: 4,
                            imageId: reader.u32(),
                            width: reader.f32(),
                            height: reader.f32(),
                            transform: [reader.f32(), reader.f32(), reader.f32(), reader.f32(), reader.f32(), reader.f32()],
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
                            end: [reader.f32(), reader.f32()],
                            spread: reader.u32(),
                            focal: [reader.f32(), reader.f32(), reader.f32()], // fx, fy, fr
                        };
                    } else if (strokeType === 4) { // Pattern
                        paint = {
                            type: 4,
                            imageId: reader.u32(),
                            width: reader.f32(),
                            height: reader.f32(),
                            transform: [reader.f32(), reader.f32(), reader.f32(), reader.f32(), reader.f32(), reader.f32()],
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

                // Effects block: count + self-describing records (payload size
                // fixed per kind). Read before geometry so offsets stay aligned.
                const effectCount = reader.u32();
                const effects: EffectRecord[] = [];
                for (let e = 0; e < effectCount; e++) {
                    const kind = reader.u32();
                    if (kind === 0) { // Blur
                        effects.push({ kind, radius: reader.f32(), dx: 0, dy: 0, r: 0, g: 0, b: 0, a: 0 });
                    } else if (kind === 1) { // DropShadow: dx,dy,blur,r,g,b,a
                        const dx = reader.f32(), dy = reader.f32(), radius = reader.f32();
                        effects.push({ kind, radius, dx, dy, r: reader.f32(), g: reader.f32(), b: reader.f32(), a: reader.f32() });
                    } else if (kind === 2) { // ColorMatrix: 20 floats + 1 u32 (linearRGB flag)
                        const matrix: number[] = [];
                        for (let i = 0; i < 20; i++) matrix.push(reader.f32());
                        const linearRGB = reader.u32() !== 0;
                        effects.push({ kind, radius: 0, dx: 0, dy: 0, r: 0, g: 0, b: 0, a: 0, matrix, linearRGB });
                    }
                }

                canvas.save();
                canvas.concat(matrix);

                // Wrap the node's drawing in a filtered layer so blur/shadow
                // apply to the composited result (fills + strokes + image).
                let effectLayerOpen = false;
                if (effects.length > 0) {
                    const filter = this.getEffectFilter(effects);
                    if (filter) {
                        if (!this._effectPaint) this._effectPaint = new this.ck.Paint();
                        this._effectPaint.setImageFilter(filter);
                        canvas.saveLayer(this._effectPaint);
                        effectLayerOpen = true;
                    }
                }

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

                // Image nodes (type 5) carry no fills/strokes — draw the raster
                // and skip the fill/stroke passes.
                if (nodeType === 5) {
                    reader.offset = startGeoOffset + 4; // skip the geometry size u32
                    const iw = reader.f32();
                    const ih = reader.f32();
                    const imageId = reader.u32();
                    this.drawImageNode(canvas, imageId, iw, ih, nodeAlpha);
                    reader.offset = startGeoOffset + 4 + geoSize;
                } else
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
                                fill.type, fill.stops, fill.start, fill.end, nodeAlpha, fill.spread, fill.focal
                            );
                            p.setShader(fillShader);
                        } else if (fill.type === 4) {
                            p.setColor(this.ck.Color4f(1, 1, 1, nodeAlpha)); // alpha via color
                            p.setShader(this.getPatternShader(fill.imageId, fill.width, fill.height, fill.transform));
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
                                st.paint.type, st.paint.stops, st.paint.start, st.paint.end, nodeAlpha, st.paint.spread, st.paint.focal
                            );
                            p.setShader(strokeShader);
                        } else if (st.paint.type === 4) {
                            p.setColor(this.ck.Color4f(1, 1, 1, nodeAlpha));
                            p.setShader(this.getPatternShader(st.paint.imageId, st.paint.width, st.paint.height, st.paint.transform));
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

                if (effectLayerOpen) canvas.restore(); // composite the filtered layer
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

        // Live Paint faces/edges are no longer drawn here — they're emitted
        // in-stream at the group's z (CMD_LP_FACES/EDGES) so members' strokes
        // sit on top, like Illustrator.

        // Editor overlays — never part of exported output.
        if (!exporting) {
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
        }

        canvas.restore();

        if (!exporting) {
            // Draw hover outline (shape under cursor, selection tool)
            this.drawHoverOutline(canvas, dpr);
            // Draw selection overlay
            this.renderSelectionOverlay(canvas, dpr);
            // Draw gradient editing handles (axis + stops on the shape)
            this.drawGradientOverlay(canvas, dpr);
            // Draw direct selection edit handles
            this.drawDirectEditHandles(canvas, dpr);
            // Draw scissors / add-point hover dot
            this.drawScissorsPreview(canvas, dpr);
        }

        this.surface.flush();
    }

    /**
     * Render the whole document to a PNG at `scale`× (1 world unit → `scale`
     * pixels). Renders into an offscreen raster surface with a transparent
     * background and no editor chrome, reusing the normal draw path via the
     * `_exporting` flag. Returns a PNG Blob (or null if the surface can't be
     * created).
     */
    exportPNG(
        scale = 2,
        bounds?: { x: number; y: number; w: number; h: number },
        background?: { r: number; g: number; b: number; a: number },
    ): Blob | null {
        if (!this.scene.engine || !this.surface) return null;
        const b = bounds ?? { x: 0, y: 0, w: this.scene.engine.get_document_width(), h: this.scene.engine.get_document_height() };
        const W = Math.max(1, Math.round(b.w * scale));
        const H = Math.max(1, Math.round(b.h * scale));

        const surface = this.ck.MakeSurface(W, H);
        if (!surface) return null;

        // Swap in export state and reuse render(), then restore. The pan offsets
        // the export origin so an off-origin artboard is cropped correctly.
        const savedSurface = this.surface;
        const savedZoom = this.zoom;
        const savedPan = { x: this.pan.x, y: this.pan.y };
        this.surface = surface as unknown as Surface;
        this.zoom = scale;
        this.pan = { x: -b.x * scale, y: -b.y * scale };
        this._exporting = true;
        this._exportBounds = b;
        this._exportBackground = background ?? null;

        let blob: Blob | null = null;
        try {
            this.render();
            const img = surface.makeImageSnapshot();
            const bytes = img.encodeToBytes(); // defaults to PNG
            img.delete();
            // Cast: CanvasKit's Uint8Array<ArrayBufferLike> isn't inferred as a
            // BlobPart under newer TS libs, but it is a valid one at runtime.
            if (bytes) blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' });
        } finally {
            this._exporting = false;
            this._exportBounds = null;
            this._exportBackground = null;
            this.surface = savedSurface;
            this.zoom = savedZoom;
            this.pan = savedPan;
            surface.delete();
            this.requestRender(); // repaint the on-screen surface
        }
        return blob;
    }

    /** Build a cache key for a gradient and return a cached or newly created shader. */
    private getOrCreateGradientShader(
        gradType: number,
        stops: { offset: number; r: number; g: number; b: number; a: number }[],
        start: [number, number],
        end: [number, number],
        nodeAlpha: number = 1.0,
        /** spreadMethod: 0 = pad, 1 = repeat, 2 = reflect. */
        spread: number = 0,
        /** Radial focal point [fx, fy, fr]; defaults to the center circle. */
        focal: [number, number, number] = [start[0], start[1], 0],
    ): ReturnType<CanvasKit['Shader']['MakeLinearGradient']> {
        // Build a compact cache key from gradient parameters
        let key = `${gradType}|${start[0]},${start[1]}|${end[0]},${end[1]}|${nodeAlpha}|${spread}|${focal.join(',')}`;
        for (const s of stops) {
            key += `|${s.offset},${s.r},${s.g},${s.b},${s.a}`;
        }
        const cached = this._gradientCache.get(key);
        if (cached) return cached;

        // spreadMethod → Skia TileMode: pad→Clamp, repeat→Repeat, reflect→Mirror.
        const tileMode = spread === 1 ? this.ck.TileMode.Repeat
            : spread === 2 ? this.ck.TileMode.Mirror
            : this.ck.TileMode.Clamp;
        const colors = stops.map(s => this.ck.Color4f(s.r, s.g, s.b, s.a * nodeAlpha));
        const offsets = stops.map(s => s.offset);
        let shader: ReturnType<CanvasKit['Shader']['MakeLinearGradient']>;
        if (gradType === 2) { // Linear
            shader = this.ck.Shader.MakeLinearGradient(
                start, end, colors, offsets, tileMode,
            );
        } else { // Radial — focal point is the start circle (fx, fy, fr), the
            // center circle is (start, radius). Concentric when focal = center.
            const radius = Math.hypot(end[0] - start[0], end[1] - start[1]);
            shader = this.ck.Shader.MakeTwoPointConicalGradient(
                [focal[0], focal[1]], focal[2], start, radius, colors, offsets, tileMode,
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
            reader.u32(); // fontWeight
            reader.u32(); // italic
            reader.f32(); // letterSpacing
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
            const fontWeight = reader.u32();  // 100–900
            const italic = reader.u32() !== 0;
            const letterSpacing = reader.f32();
            const fontFamily = reader.string();
            const content = reader.string();

            // While a text node is being edited inline, the HTML overlay stands
            // in for it — skip drawing the underlying node so it isn't doubled.
            if (this._editingTextId === nodeId) return;

            // Map text_align to CanvasKit TextAlign enum
            const ckTextAlign = textAlign === 1 ? this.ck.TextAlign.Center
                : textAlign === 2 ? this.ck.TextAlign.Right
                : this.ck.TextAlign.Left;

            // Map font weight/style to CanvasKit enums (falls back gracefully
            // when the loaded font lacks the requested variant).
            const ckWeight = fontWeight >= 700 ? this.ck.FontWeight.Bold
                : fontWeight >= 600 ? this.ck.FontWeight.SemiBold
                : fontWeight >= 500 ? this.ck.FontWeight.Medium
                : fontWeight <= 300 ? this.ck.FontWeight.Light
                : this.ck.FontWeight.Normal;
            const ckSlant = italic ? this.ck.FontSlant.Italic : this.ck.FontSlant.Upright;

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
                        fontStyle: { weight: ckWeight, slant: ckSlant },
                        letterSpacing: letterSpacing,
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

        const live = this.inputManager?.liveResizeBounds ?? this.inputManager?.liveFrame;

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

        // Selection frame: oriented box for a single node (rotates/skews with
        // the shape), axis-aligned union for multi-selection. During drags the
        // input manager returns the live frame for zero-lag feedback.
        let frame = this.inputManager?.getSelectionFrame() ?? null;
        if (!frame && totalMaxX > totalMinX && totalMaxY > totalMinY) {
            frame = {
                w: totalMaxX - totalMinX, h: totalMaxY - totalMinY,
                m: { a: 1, b: 0, c: 0, d: 1, e: totalMinX, f: totalMinY },
            };
        }

        // Draw frame box and handles (skip in node-editing mode — anchors replace resize handles)
        const isNodeEditing = this.inputManager?.editingNodeId != null;
        if (frame && frame.w > 0 && frame.h > 0 && !isNodeEditing) {
            const m = frame.m;
            const pt = (fx: number, fy: number) => ({ x: m.a * fx + m.c * fy + m.e, y: m.b * fx + m.d * fy + m.f });
            const corners = [pt(0, 0), pt(frame.w, 0), pt(frame.w, frame.h), pt(0, frame.h)];

            if (selection.length > 1 || live) {
                const box = new this.ck.Path();
                box.moveTo(corners[0].x, corners[0].y);
                for (let i = 1; i < 4; i++) box.lineTo(corners[i].x, corners[i].y);
                box.close();
                canvas.drawPath(box, op.selOutline);
                box.delete();
            }

            const hSize = 4 / this.zoom;
            const midW = frame.w / 2, midH = frame.h / 2;
            const handlePositions = [
                pt(0, 0), pt(midW, 0), pt(frame.w, 0),
                pt(0, midH),           pt(frame.w, midH),
                pt(0, frame.h), pt(midW, frame.h), pt(frame.w, frame.h),
            ];
            // Handle squares tilt with the frame
            const angleDeg = Math.atan2(m.b, m.a) * (180 / Math.PI);

            op.selHandleStroke.setStrokeWidth(1.0 / this.zoom);

            for (const { x: hx, y: hy } of handlePositions) {
                canvas.save();
                canvas.rotate(angleDeg, hx, hy);
                canvas.drawRect(this.ck.LTRBRect(hx - hSize, hy - hSize, hx + hSize, hy + hSize), op.selHandleFill);
                canvas.drawRect(this.ck.LTRBRect(hx - hSize, hy - hSize, hx + hSize, hy + hSize), op.selHandleStroke);
                canvas.restore();
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

    /**
     * On-canvas gradient editing overlay (Figma-style): the gradient axis with
     * a start ring, an end square, and color-filled stop dots along the line.
     * Radial gradients additionally show the radius circle in node space.
     * State lives in ui.gradientEdit; only drawn for the selection tool.
     */
    private drawGradientOverlay(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (!im || im.ui.activeTool !== 'selection' || im.editingNodeId !== null) return;
        const ge = im.ui.gradientEdit;
        if (!ge || !ge.isActive()) return;
        const selection = this.scene.getSelection();
        if (selection.length !== 1 || selection[0] !== ge.nodeId) return;
        const grad = ge.gradient();
        if (!grad) return;

        const { p0, p1 } = ge.endpoints(grad);
        const z = this.zoom;
        const ck = this.ck;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(z, z);

        const halo = new ck.Paint();
        halo.setColor(ck.Color(0, 0, 0, 0.35));
        halo.setStyle(ck.PaintStyle.Stroke);
        halo.setAntiAlias(true);

        const white = new ck.Paint();
        white.setColor(ck.Color(255, 255, 255, 1));
        white.setStyle(ck.PaintStyle.Stroke);
        white.setAntiAlias(true);

        const fill = new ck.Paint();
        fill.setStyle(ck.PaintStyle.Fill);
        fill.setAntiAlias(true);

        const accent = new ck.Paint();
        accent.setColor(ck.Color(0, 162, 255, 1));
        accent.setStyle(ck.PaintStyle.Stroke);
        accent.setAntiAlias(true);

        // Radius circle for radial gradients — drawn in node space so it
        // follows the node's rotation/scale.
        if (grad.gradient_type === 'Radial') {
            const t = this.scene.getTransform(ge.nodeId!);
            const r = Math.hypot(grad.end_x - grad.start_x, grad.end_y - grad.start_y);
            if (r > 1e-6) {
                canvas.save();
                canvas.concat(t);
                // Approximate screen-constant stroke width in node space
                const sx = Math.hypot(t[0], t[3]) || 1;
                halo.setStrokeWidth(2.5 / (z * sx));
                white.setStrokeWidth(1 / (z * sx));
                canvas.drawCircle(grad.start_x, grad.start_y, r, halo);
                canvas.drawCircle(grad.start_x, grad.start_y, r, white);
                canvas.restore();
            }
        }

        // Axis line
        halo.setStrokeWidth(3 / z);
        white.setStrokeWidth(1.5 / z);
        canvas.drawLine(p0.x, p0.y, p1.x, p1.y, halo);
        canvas.drawLine(p0.x, p0.y, p1.x, p1.y, white);

        // Stop dots: white backing disc + stop color + dark outline
        halo.setStrokeWidth(1 / z);
        for (let i = 0; i < grad.stops.length; i++) {
            const s = grad.stops[i];
            const x = p0.x + (p1.x - p0.x) * s.offset;
            const y = p0.y + (p1.y - p0.y) * s.offset;
            const selected = i === ge.stopIndex;
            const r = (selected ? 5.5 : 4.5) / z;
            fill.setColor(ck.Color4f(1, 1, 1, 1));
            canvas.drawCircle(x, y, r, fill);
            fill.setColor(ck.Color4f(s.color.r, s.color.g, s.color.b, s.color.a ?? 1));
            canvas.drawCircle(x, y, r, fill);
            canvas.drawCircle(x, y, r, halo);
            if (selected) {
                accent.setStrokeWidth(1.5 / z);
                canvas.drawCircle(x, y, r + 1.5 / z, accent);
            }
        }

        // Start handle: larger ring (radial: the center)
        white.setStrokeWidth(2 / z);
        halo.setStrokeWidth(3.5 / z);
        canvas.drawCircle(p0.x, p0.y, 8 / z, halo);
        canvas.drawCircle(p0.x, p0.y, 8 / z, white);

        // End handle: square, rotated to the axis (radial: the radius handle)
        const angleDeg = Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180 / Math.PI;
        const hs = 6 / z;
        canvas.save();
        canvas.rotate(angleDeg, p1.x, p1.y);
        canvas.drawRect(ck.LTRBRect(p1.x - hs, p1.y - hs, p1.x + hs, p1.y + hs), halo);
        canvas.drawRect(ck.LTRBRect(p1.x - hs, p1.y - hs, p1.x + hs, p1.y + hs), white);
        canvas.restore();

        halo.delete();
        white.delete();
        fill.delete();
        accent.delete();

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

    /** Screen-constant size (world units) for artboard resize handles. */
    private artboardHandleWorld(): number { return 4 / this.zoom; }

    drawArtboards(canvas: Canvas) {
        const op = this.ensureOverlayPaints();
        const artboards = this.scene.getArtboards();

        for (const ab of artboards) {
            // Background fill (per-artboard color).
            op.artboardFill.setColor(this.ck.Color(
                Math.round(ab.background.r * 255),
                Math.round(ab.background.g * 255),
                Math.round(ab.background.b * 255),
                ab.background.a,
            ));
            canvas.drawRect(this.ck.LTRBRect(ab.x, ab.y, ab.x + ab.w, ab.y + ab.h), op.artboardFill);

            // Border — accent when selected, gray otherwise.
            const selected = ab.id === this.selectedArtboardId;
            const border = selected ? op.selOutline : op.artboardStroke;
            border.setStrokeWidth(1 / this.zoom);
            canvas.drawRect(this.ck.LTRBRect(ab.x, ab.y, ab.x + ab.w, ab.y + ab.h), border);

            // Name label above the top-left corner, at screen-constant size.
            this.drawArtboardLabel(canvas, ab, selected);

            // Resize handles when selected.
            if (selected) this.drawArtboardHandles(canvas, ab);
        }
    }

    private drawArtboardLabel(canvas: Canvas, ab: Artboard, selected: boolean) {
        const px = 11;
        const size = px / this.zoom;
        const font = new this.ck.Font(null, size);
        const paint = new this.ck.Paint();
        paint.setColor(selected ? this.ck.Color(0, 162, 255, 1.0) : this.ck.Color(150, 150, 150, 1.0));
        paint.setAntiAlias(true);
        const blob = this.ck.TextBlob.MakeFromText(ab.name, font);
        if (blob) {
            canvas.drawTextBlob(blob, ab.x, ab.y - 5 / this.zoom, paint);
            blob.delete();
        }
        font.delete();
        paint.delete();
    }

    private drawArtboardHandles(canvas: Canvas, ab: Artboard) {
        const op = this.ensureOverlayPaints();
        const s = this.artboardHandleWorld();
        op.selHandleStroke.setStrokeWidth(1 / this.zoom);
        for (const [hx, hy] of this.artboardHandlePositions(ab)) {
            const r = this.ck.LTRBRect(hx - s, hy - s, hx + s, hy + s);
            canvas.drawRect(r, op.selHandleFill);
            canvas.drawRect(r, op.selHandleStroke);
        }
    }

    /** The 8 resize-handle centers (world space): NW,N,NE,E,SE,S,SW,W. */
    private artboardHandlePositions(ab: Artboard): [number, number][] {
        const { x, y, w, h } = ab;
        const cx = x + w / 2, cy = y + h / 2;
        return [
            [x, y], [cx, y], [x + w, y],
            [x + w, cy], [x + w, y + h], [cx, y + h],
            [x, y + h], [x, cy],
        ];
    }

    private static HANDLE_DIRS: ArtboardHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

    /** Hit-test the resize handles of the selected artboard. */
    artboardHandleHitTest(wx: number, wy: number): { id: number; handle: ArtboardHandle } | null {
        if (this.selectedArtboardId === null) return null;
        const ab = this.scene.getArtboards().find(a => a.id === this.selectedArtboardId);
        if (!ab) return null;
        const s = this.artboardHandleWorld() * 1.8; // a bit more forgiving than the visual
        const pos = this.artboardHandlePositions(ab);
        for (let i = 0; i < pos.length; i++) {
            if (Math.abs(wx - pos[i][0]) <= s && Math.abs(wy - pos[i][1]) <= s) {
                return { id: ab.id, handle: Renderer.HANDLE_DIRS[i] };
            }
        }
        return null;
    }

    /** Hit-test artboard name labels; returns the artboard id or null. */
    artboardLabelHitTest(wx: number, wy: number): number | null {
        const px = 11;
        const size = px / this.zoom;
        const font = new this.ck.Font(null, size);
        let hit: number | null = null;
        for (const ab of this.scene.getArtboards()) {
            const blob = this.ck.TextBlob.MakeFromText(ab.name, font);
            // Approximate label width; MakeFromText has no measure, so estimate.
            const wApprox = ab.name.length * size * 0.6;
            if (blob) blob.delete();
            const labelTop = ab.y - 5 / this.zoom - size;
            const labelBottom = ab.y - 5 / this.zoom + size * 0.25;
            if (wx >= ab.x && wx <= ab.x + wApprox && wy >= labelTop && wy <= labelBottom) {
                hit = ab.id; // last (topmost) wins
            }
        }
        font.delete();
        return hit;
    }

    /** Union AABB of all artboards, or a default page if none. */
    getArtboardsBounds(): { x: number; y: number; w: number; h: number } {
        const arts = this.scene.getArtboards();
        if (arts.length === 0) return { x: 0, y: 0, w: 1000, h: 1000 };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const a of arts) {
            minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
            maxX = Math.max(maxX, a.x + a.w); maxY = Math.max(maxY, a.y + a.h);
        }
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
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
        // Artboards preview as a plain rectangle (like the rect tool).
        const rectLike = tool === 'rect' || tool === 'artboard';
        const isCustomShape = !rectLike && tool !== 'ellipse';
        const shapePath = isCustomShape ? this.makePreviewPath(tool, x, y, w, h) : null;

        const fillPaint = new this.ck.Paint();
        fillPaint.setColor(this.ck.Color(100, 149, 237, 0.3));
        fillPaint.setStyle(this.ck.PaintStyle.Fill);

        if (rectLike) canvas.drawRect(rect, fillPaint);
        else if (tool === 'ellipse') canvas.drawOval(rect, fillPaint);
        else canvas.drawPath(shapePath!, fillPaint);

        const strokePaint = new this.ck.Paint();
        strokePaint.setColor(this.ck.Color(0, 162, 255, 1.0));
        strokePaint.setStyle(this.ck.PaintStyle.Stroke);
        strokePaint.setStrokeWidth(1.5 / this.zoom);

        if (rectLike) canvas.drawRect(rect, strokePaint);
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

    /** Read a bézier outline from the render buffer (`[count][x,y,cp1x,cp1y,
     *  cp2x,cp2y]×N`) and build a CanvasKit path. Matches `write_outline_points`. */
    private readOutlinePath(reader: BinaryReader, closed: boolean): Path {
        const n = reader.u32();
        const pts: OutlinePt[] = [];
        for (let i = 0; i < n; i++) {
            pts.push({ x: reader.f32(), y: reader.f32(), cp1: [reader.f32(), reader.f32()], cp2: [reader.f32(), reader.f32()] });
        }
        return this.pathFromOutline(pts, closed);
    }

    /** Reconstruct a CanvasKit path from an anchor+handles outline (the same
     *  cubic reconstruction the binary geometry reader uses). */
    private pathFromOutline(outline: OutlinePt[], closed: boolean): Path {
        const path = new this.ck.Path();
        if (!outline.length) return path;
        path.moveTo(outline[0].x, outline[0].y);
        for (let i = 0; i < outline.length - 1; i++) {
            const a = outline[i], b = outline[i + 1];
            path.cubicTo(a.cp2[0], a.cp2[1], b.cp1[0], b.cp1[1], b.x, b.y);
        }
        if (closed && outline.length >= 2) {
            const a = outline[outline.length - 1], b = outline[0];
            path.cubicTo(a.cp2[0], a.cp2[1], b.cp1[0], b.cp1[1], b.x, b.y);
            path.close();
        }
        return path;
    }

    private drawPaintBucketHover(canvas: Canvas) {
        // Only while the Live Paint tool is armed — avoids a stale highlight
        // lingering after the user switches tools.
        if (this.inputManager?.ui?.activeTool !== 'paint-bucket') return;
        // Edge hover takes precedence — the cursor is over a line, not a region.
        if (this.hoverEdgeId >= 0 && this.scene.engine) {
            this.drawEdgeHover(canvas);
            return;
        }
        if (this.hoverFaceId < 0 || !this.scene.engine) return;
        try {
            const outline = JSON.parse(this.scene.engine.get_face_boundary(this.hoverFaceId)) as OutlinePt[];
            if (!outline || outline.length < 2) return;
            const path = this.pathFromOutline(outline, true);

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

    private drawEdgeHover(canvas: Canvas) {
        try {
            const outline = JSON.parse(this.scene.engine!.get_edge_polyline(this.hoverEdgeId)) as OutlinePt[];
            if (!outline || outline.length < 2) return;
            const path = this.pathFromOutline(outline, false);

            const paint = new this.ck.Paint();
            paint.setStyle(this.ck.PaintStyle.Stroke);
            paint.setStrokeCap(this.ck.StrokeCap.Round);
            paint.setStrokeJoin(this.ck.StrokeJoin.Round);
            paint.setAntiAlias(true);
            paint.setColor(this.ck.Color(66, 133, 244, 0.9));
            paint.setStrokeWidth(4 / this.zoom);
            canvas.drawPath(path, paint);

            path.delete();
            paint.delete();
        } catch {}
    }
}
