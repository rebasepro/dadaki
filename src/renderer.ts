import type { Canvas, CanvasKit, Paint, Surface } from 'canvaskit-wasm';

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

export class Renderer {
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

    constructor(ck: CanvasKit, canvas: HTMLCanvasElement, scene: WasmScene) {
        this.ck = ck;
        this.canvas = canvas;
        this.scene = scene;
        this.surface = null;
        this.isRunning = false;

        this.zoom = 1.0;
        this.pan = { x: 0, y: 0 };

        this.initGL();
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
        this.render();
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
        
        const commandCount = reader.u32();
        if (!this.paint) this.paint = new this.ck.Paint();
        const p = this.paint;
        p.setAntiAlias(true);

        for (let i = 0; i < commandCount; i++) {
            const cmdType = reader.u32();
            reader.u32(); // skip id

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
                
                // Style (13 x f32 — must match write_node_recursive in lib.rs)
                const fr = reader.f32(); const fg = reader.f32(); const fb = reader.f32(); const fa = reader.f32();
                const sr = reader.f32(); const sg = reader.f32(); const sb = reader.f32(); const sa = reader.f32();
                const strokeWidth = reader.f32();
                const cornerRadius = reader.f32();
                const dashOn = reader.f32();
                const dashOff = reader.f32();
                const dashPhase = reader.f32();

                canvas.save();
                canvas.concat(matrix);

                const startGeoOffset = reader.offset;
                const geoSize = reader.view.getUint32(startGeoOffset, true);

                // Fill Pass
                if (fa > 0) {
                    p.setColor(this.ck.Color4f(fr, fg, fb, fa));
                    p.setStyle(this.ck.PaintStyle.Fill);
                    this.drawBinaryGeometry(canvas, nodeType, reader, p, cornerRadius);
                } else {
                    reader.offset += 4 + geoSize;
                }

                // Stroke Pass
                if (sa > 0 && strokeWidth > 0) {
                    reader.offset = startGeoOffset; // Rewind
                    p.setColor(this.ck.Color4f(sr, sg, sb, sa));
                    p.setStyle(this.ck.PaintStyle.Stroke);
                    p.setStrokeWidth(strokeWidth);
                    let dashEffect = null;
                    if (dashOn > 0) {
                        dashEffect = this.ck.PathEffect.MakeDash([dashOn, dashOff], dashPhase);
                        p.setPathEffect(dashEffect);
                    }
                    this.drawBinaryGeometry(canvas, nodeType, reader, p, cornerRadius);
                    if (dashEffect) {
                        p.setPathEffect(null);
                        dashEffect.delete();
                    }
                } else {
                    if (reader.offset === startGeoOffset) {
                        reader.offset += 4 + geoSize;
                    }
                }

                canvas.restore();
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

        this.surface.flush();
    }

    private drawBinaryGeometry(canvas: Canvas, type: number, reader: BinaryReader, paint: Paint, cornerRadius: number = 0) {
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
            canvas.drawPath(path, paint);
            path.delete();
        } else if (type === 4) { // Text
            const fontSize = reader.f32();
            const content = reader.string();
            const font = new this.ck.Font(null, fontSize);
            const blob = this.ck.TextBlob.MakeFromText(content, font);
            if (blob) {
                canvas.drawTextBlob(blob, 0, 0, paint);
                blob.delete();
            }
            font.delete();
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

        const paint = new this.ck.Paint();
        paint.setColor(this.ck.Color(0, 162, 255, 0.55));
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1.5 / this.zoom);
        paint.setAntiAlias(true);
        canvas.drawRect(this.ck.LTRBRect(b[0], b[1], b[2], b[3]), paint);
        paint.delete();
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

        const outlinePaint = new this.ck.Paint();
        outlinePaint.setColor(this.ck.Color(0, 162, 255, 1.0));
        outlinePaint.setStyle(this.ck.PaintStyle.Stroke);
        outlinePaint.setStrokeWidth(1.0 / this.zoom);

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
                canvas.drawRect(this.ck.LTRBRect(gMinX, gMinY, gMaxX, gMaxY), outlinePaint);
            } else {
                const transform = this.scene.getTransform(id);
                canvas.save();
                canvas.concat(transform);
                
                const geo = this.scene.getNodeGeometry(id);
                if (geo.Rect) {
                    canvas.drawRect(this.ck.LTRBRect(0, 0, geo.Rect.width, geo.Rect.height), outlinePaint);
                } else if (geo.Ellipse) {
                    canvas.drawOval(this.ck.LTRBRect(-geo.Ellipse.radius_x, -geo.Ellipse.radius_y, geo.Ellipse.radius_x, geo.Ellipse.radius_y), outlinePaint);
                } else if (geo.Path) {
                    const pathBounds = this.calculatePathBounds(geo.Path);
                    canvas.drawRect(this.ck.LTRBRect(pathBounds.minX, pathBounds.minY, pathBounds.maxX, pathBounds.maxY), outlinePaint);
                } else if (geo.Text) {
                    const approxW = geo.Text.content.length * geo.Text.font_size * 0.6;
                    canvas.drawRect(this.ck.LTRBRect(0, -geo.Text.font_size, approxW, 0), outlinePaint);
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

        // Draw global bounding box and handles
        if (hMaxX > hMinX && hMaxY > hMinY) {
            if (selection.length > 1 || live) {
                canvas.drawRect(this.ck.LTRBRect(hMinX, hMinY, hMaxX, hMaxY), outlinePaint);
            }

            const hSize = 4 / this.zoom;
            const midX = (hMinX + hMaxX) / 2;
            const midY = (hMinY + hMaxY) / 2;

            const handlePositions = [
                [hMinX, hMinY], [midX, hMinY], [hMaxX, hMinY],
                [hMinX, midY],                 [hMaxX, midY],
                [hMinX, hMaxY], [midX, hMaxY], [hMaxX, hMaxY],
            ];

            const handleFill = new this.ck.Paint();
            handleFill.setColor(this.ck.Color(255, 255, 255, 1.0));
            handleFill.setStyle(this.ck.PaintStyle.Fill);

            const handleStroke = new this.ck.Paint();
            handleStroke.setColor(this.ck.Color(0, 162, 255, 1.0));
            handleStroke.setStyle(this.ck.PaintStyle.Stroke);
            handleStroke.setStrokeWidth(1.0 / this.zoom);

            for (const [hx, hy] of handlePositions) {
                canvas.drawRect(this.ck.LTRBRect(hx - hSize, hy - hSize, hx + hSize, hy + hSize), handleFill);
                canvas.drawRect(this.ck.LTRBRect(hx - hSize, hy - hSize, hx + hSize, hy + hSize), handleStroke);
            }

            handleFill.delete();
            handleStroke.delete();
        }

        outlinePaint.delete();
        canvas.restore();
    }

    private calculatePathBounds(path: { subpaths: Array<{ points: Array<{ x: number; y: number; cp1: [number, number]; cp2: [number, number] }>; closed: boolean }> }) {
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

        const gridPaint = new this.ck.Paint();
        gridPaint.setColor(this.ck.Color(255, 255, 255, 0.04));
        gridPaint.setStyle(this.ck.PaintStyle.Stroke);
        gridPaint.setStrokeWidth(0.5 / this.zoom);

        // Compute visible area in world coords
        const w = this.canvas.width / dpr;
        const h = this.canvas.height / dpr;
        const startX = Math.floor(-this.pan.x / this.zoom / 50) * 50;
        const startY = Math.floor(-this.pan.y / this.zoom / 50) * 50;
        const endX = startX + w / this.zoom + 100;
        const endY = startY + h / this.zoom + 100;

        for (let x = startX; x <= endX; x += 50) {
            canvas.drawLine(x, startY, x, endY, gridPaint);
        }
        for (let y = startY; y <= endY; y += 50) {
            canvas.drawLine(startX, y, endX, y, gridPaint);
        }

        gridPaint.delete();
        canvas.restore();
    }

    drawArtboard(canvas: Canvas) {
        const paint = new this.ck.Paint();
        paint.setColor(this.ck.Color(255, 255, 255, 1.0));
        paint.setStyle(this.ck.PaintStyle.Fill);

        // Use dynamic document size from engine
        const w = this.scene.engine?.get_document_width() ?? 1000;
        const h = this.scene.engine?.get_document_height() ?? 1000;

        // Artboard is at world origin (0,0)
        canvas.drawRect(this.ck.LTRBRect(0, 0, w, h), paint);
        
        // Artboard border
        paint.setColor(this.ck.Color(80, 80, 80, 1.0));
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1 / this.zoom);
        canvas.drawRect(this.ck.LTRBRect(0, 0, w, h), paint);

        paint.delete();
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

        const handleFill = new this.ck.Paint();
        handleFill.setColor(this.ck.Color(0, 162, 255, 1.0));
        handleFill.setStyle(this.ck.PaintStyle.Fill);

        for (const sp of points) {
            for (const p of sp.points) {
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

                canvas.drawRect(this.ck.LTRBRect(
                    ax - dotSize, ay - dotSize, ax + dotSize, ay + dotSize
                ), anchorFill);
                canvas.drawRect(this.ck.LTRBRect(
                    ax - dotSize, ay - dotSize, ax + dotSize, ay + dotSize
                ), anchorStroke);
            }
        }

        linePaint.delete();
        anchorFill.delete();
        anchorStroke.delete();
        handleFill.delete();
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
            const json = this.scene.engine.get_filled_faces();
            const faces = JSON.parse(json);
            if (!faces || faces.length === 0) return;

            const paint = new this.ck.Paint();
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
            paint.delete();
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
