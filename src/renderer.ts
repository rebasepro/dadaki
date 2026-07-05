import type { CanvasKit, Surface, Canvas } from 'canvaskit-wasm';
import type { WasmScene } from './wasm_scene';
import type { InputManager } from './input';

export class Renderer {
    ck: CanvasKit;
    canvas: HTMLCanvasElement;
    scene: WasmScene;
    surface: Surface | null;
    context: any;
    grContext: any;
    isRunning: boolean;
    zoom: number;
    pan: { x: number; y: number };
    inputManager: InputManager | null = null;
    /** Face ID currently being hovered by the paint bucket tool (or -1). */
    hoverFaceId: number = -1;

    constructor(ck: CanvasKit, canvas: HTMLCanvasElement, scene: WasmScene) {
        this.ck = ck;
        this.canvas = canvas;
        this.scene = scene;
        this.surface = null;
        this.context = null;
        this.isRunning = false;

        this.zoom = 1.0;
        this.pan = { x: 0, y: 0 };

        this.init();
    }

    init() {
        this.context = (this.ck as any).GetWebGLContext(this.canvas);
        this.grContext = (this.ck as any).MakeGrContext(this.context);
        this.onResize();
        window.addEventListener('resize', () => this.onResize());
    }

    onResize() {
        try {
            const dpr = window.devicePixelRatio;
            this.canvas.width = this.canvas.clientWidth * dpr;
            this.canvas.height = this.canvas.clientHeight * dpr;
            
            if (this.surface) {
                this.surface.delete();
            }
            
            this.surface = (this.ck as any).MakeOnScreenGLSurface(
                this.grContext,
                this.canvas.width,
                this.canvas.height,
                (this.ck as any).ColorSpace.SRGB
            );
            
            // Fallback for different CanvasKit versions
            if (!this.surface && (this.ck as any).MakeRenderTarget) {
                this.surface = (this.ck as any).MakeRenderTarget(this.context, this.canvas.width, this.canvas.height);
            }
            if (!this.surface) {
                 this.surface = this.ck.MakeWebGLCanvasSurface(this.canvas, null as any, null as any);
            }
            
            this.render();
        } catch (e) {
            console.error("Resize Error:", e);
        }
    }

    start() {
        this.isRunning = true;
        this.loop();
    }

    stop() {
        this.isRunning = false;
    }

    loop() {
        if (!this.isRunning) return;
        this.render();
        requestAnimationFrame(() => this.loop());
    }

    render() {
        if (!this.surface || !this.scene.engine) return;
        const canvas = this.surface.getCanvas();
        const dpr = window.devicePixelRatio;

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

        // Draw Scene Objects from WASM using Spatial Index
        const visibleIds = this.scene.getVisibleNodes(viewportMinX, viewportMinY, viewportMaxX, viewportMaxY);
        const sceneData = this.scene.getSceneData();
        const nodes = sceneData.nodes;

        for (const id of visibleIds) {
            this.renderNode(canvas, id, nodes);
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

        canvas.restore();

        // Draw selection overlay
        this.renderSelectionOverlay(canvas, dpr, nodes);

        // Draw direct selection edit handles
        this.drawDirectEditHandles(canvas, dpr);

        this.surface.flush();
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

        // Handle line paint (thin gray lines from anchor to control points)
        const linePaint = new this.ck.Paint();
        linePaint.setColor(this.ck.Color(150, 150, 150, 0.8));
        linePaint.setStyle(this.ck.PaintStyle.Stroke);
        linePaint.setStrokeWidth(lineWidth);

        // Anchor fill (white) and stroke (blue)
        const anchorFill = new this.ck.Paint();
        anchorFill.setColor(this.ck.Color(255, 255, 255, 1.0));
        anchorFill.setStyle(this.ck.PaintStyle.Fill);

        const anchorStroke = new this.ck.Paint();
        anchorStroke.setColor(this.ck.Color(0, 162, 255, 1.0));
        anchorStroke.setStyle(this.ck.PaintStyle.Stroke);
        anchorStroke.setStrokeWidth(lineWidth * 1.5);

        // Control handle fill (blue circle)
        const handleFill = new this.ck.Paint();
        handleFill.setColor(this.ck.Color(0, 162, 255, 1.0));
        handleFill.setStyle(this.ck.PaintStyle.Fill);

        for (const p of points) {
            // Transform to world
            const ax = t[0] * p.x + t[1] * p.y + t[2];
            const ay = t[3] * p.x + t[4] * p.y + t[5];
            const c1x = t[0] * p.cp1[0] + t[1] * p.cp1[1] + t[2];
            const c1y = t[3] * p.cp1[0] + t[4] * p.cp1[1] + t[5];
            const c2x = t[0] * p.cp2[0] + t[1] * p.cp2[1] + t[2];
            const c2y = t[3] * p.cp2[0] + t[4] * p.cp2[1] + t[5];

            // Draw handle lines (anchor → cp1, anchor → cp2)
            const isSmooth = Math.abs(c1x - ax) > 0.5 || Math.abs(c1y - ay) > 0.5;
            if (isSmooth) {
                canvas.drawLine(ax, ay, c1x, c1y, linePaint);
                canvas.drawLine(ax, ay, c2x, c2y, linePaint);
                // Draw cp1 handle circle
                canvas.drawCircle(c1x, c1y, handleSize, handleFill);
                // Draw cp2 handle circle
                canvas.drawCircle(c2x, c2y, handleSize, handleFill);
            }

            // Draw anchor point (white square with blue border)
            canvas.drawRect(this.ck.LTRBRect(
                ax - dotSize, ay - dotSize, ax + dotSize, ay + dotSize
            ), anchorFill);
            canvas.drawRect(this.ck.LTRBRect(
                ax - dotSize, ay - dotSize, ax + dotSize, ay + dotSize
            ), anchorStroke);
        }

        linePaint.delete();
        anchorFill.delete();
        anchorStroke.delete();
        handleFill.delete();
        canvas.restore();
    }

    private renderNode(canvas: Canvas, id: number, nodes: any) {
        const node = nodes[id];
        if (!node || !node.visible) return;

        const transform = this.scene.getTransform(id);
        const style = node.style;
        
        canvas.save();
        canvas.concat(transform);

        // Extended blend mode map (16 modes)
        const blendModes = [
            this.ck.BlendMode.SrcOver,    // 0: normal
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
            this.ck.BlendMode.Luminosity,  // 15
        ];

        const paint = new this.ck.Paint();
        paint.setAntiAlias(true);

        const blendMode = blendModes[style.blend_mode || 0] || blendModes[0];
        paint.setBlendMode(blendMode);

        // Fill pass
        if (style.fill) {
            const f = style.fill;
            // Apply both global opacity and fill_opacity
            const fillAlpha = (style.opacity ?? 1.0) * (style.fill_opacity ?? 1.0);
            paint.setAlphaf(fillAlpha);
            paint.setColor(this.ck.Color(f.r * 255, f.g * 255, f.b * 255, f.a));
            paint.setStyle(this.ck.PaintStyle.Fill);
            this.drawGeometry(canvas, node.geometry, paint, style.corner_radius || 0, style.fill_rule || 0);
        }

        // Stroke pass
        if (style.stroke) {
            const s = style.stroke;
            // Stroke uses only global opacity
            paint.setAlphaf(style.opacity ?? 1.0);
            paint.setColor(this.ck.Color(s.r * 255, s.g * 255, s.b * 255, s.a));
            paint.setStyle(this.ck.PaintStyle.Stroke);
            paint.setStrokeWidth(style.stroke_width);

            // Stroke cap
            const caps = [this.ck.StrokeCap.Butt, this.ck.StrokeCap.Round, this.ck.StrokeCap.Square];
            paint.setStrokeCap(caps[style.stroke_cap || 0] || caps[0]);

            // Stroke join
            const joins = [this.ck.StrokeJoin.Miter, this.ck.StrokeJoin.Round, this.ck.StrokeJoin.Bevel];
            paint.setStrokeJoin(joins[style.stroke_join || 0] || joins[0]);

            // Miter limit
            const miterLimit = style.miter_limit ?? 4;
            paint.setStrokeMiter(miterLimit);

            // Dash pattern
            if (style.dash_array && style.dash_array.length >= 2) {
                const dashEffect = this.ck.PathEffect.MakeDash(style.dash_array, style.dash_offset || 0);
                if (dashEffect) {
                    paint.setPathEffect(dashEffect);
                }
            }

            this.drawGeometry(canvas, node.geometry, paint, style.corner_radius || 0, 0);

            // Clear dash effect
            paint.setPathEffect(null);
        }
        paint.delete();

        canvas.restore();
    }

    private drawGeometry(canvas: Canvas, geometry: any, paint: any, cornerRadius: number = 0, fillRule: number = 0) {
        if (geometry.Rect) {
            const { width, height } = geometry.Rect;
            if (cornerRadius > 0) {
                canvas.drawRRect(this.ck.RRectXY(this.ck.LTRBRect(0, 0, width, height), cornerRadius, cornerRadius), paint);
            } else {
                canvas.drawRect(this.ck.LTRBRect(0, 0, width, height), paint);
            }
        } else if (geometry.Ellipse) {
            const { radius_x, radius_y } = geometry.Ellipse;
            canvas.drawOval(this.ck.LTRBRect(-radius_x, -radius_y, radius_x, radius_y), paint);
        } else if (geometry.Path) {
            const points = geometry.Path.points;
            if (points && points.length >= 2) {
                const path = new this.ck.Path();
                // Apply fill rule
                if (fillRule === 1) {
                    path.setFillType(this.ck.FillType.EvenOdd);
                }
                path.moveTo(points[0].x, points[0].y);
                for (let i = 1; i < points.length; i++) {
                    const prev = points[i - 1];
                    const p = points[i];
                    path.cubicTo(prev.cp2[0], prev.cp2[1], p.cp1[0], p.cp1[1], p.x, p.y);
                }
                // Detect closed path (last point == first point) and close properly
                const last = points[points.length - 1];
                const first = points[0];
                if (Math.abs(last.x - first.x) < 0.01 && Math.abs(last.y - first.y) < 0.01) {
                    path.close();
                }
                canvas.drawPath(path, paint);
                path.delete();
            }
        } else if (geometry.Text) {
            const { content, font_size } = geometry.Text;
            const font = new this.ck.Font(null, font_size);
            const blob = this.ck.TextBlob.MakeFromText(content, font);
            if (blob) {
                canvas.drawTextBlob(blob, 0, 0, paint);
                blob.delete();
            }
            font.delete();
        }
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
            // star – 5 points, inner radius 40%
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

    private drawPreview(canvas: Canvas) {
        const preview = this.inputManager?.previewRect;
        if (!preview || preview.w < 1 || preview.h < 1) return;

        const { x, y, w, h, tool } = preview;
        const rect = this.ck.LTRBRect(x, y, x + w, y + h);

        // Semi-transparent fill
        const fillPaint = new this.ck.Paint();
        fillPaint.setColor(this.ck.Color(100, 149, 237, 0.3));
        fillPaint.setStyle(this.ck.PaintStyle.Fill);

        if (tool === 'rect') {
            canvas.drawRect(rect, fillPaint);
        } else if (tool === 'ellipse') {
            canvas.drawOval(rect, fillPaint);
        } else {
            const path = this.makePreviewPath(tool, x, y, w, h);
            canvas.drawPath(path, fillPaint);
            path.delete();
        }

        // Blue outline
        const strokePaint = new this.ck.Paint();
        strokePaint.setColor(this.ck.Color(0, 162, 255, 1.0));
        strokePaint.setStyle(this.ck.PaintStyle.Stroke);
        strokePaint.setStrokeWidth(1.5 / this.zoom);

        if (tool === 'rect') {
            canvas.drawRect(rect, strokePaint);
        } else if (tool === 'ellipse') {
            canvas.drawOval(rect, strokePaint);
        } else {
            const path = this.makePreviewPath(tool, x, y, w, h);
            canvas.drawPath(path, strokePaint);
            path.delete();
        }

        fillPaint.delete();
        strokePaint.delete();
    }

    private drawMarquee(canvas: Canvas) {
        const marquee = this.inputManager?.marqueeRect;
        if (!marquee || marquee.w < 1 || marquee.h < 1) return;

        const { x, y, w, h } = marquee;
        const rect = this.ck.LTRBRect(x, y, x + w, y + h);

        // Semi-transparent blue fill
        const fillPaint = new this.ck.Paint();
        fillPaint.setColor(this.ck.Color(0, 120, 255, 0.08));
        fillPaint.setStyle(this.ck.PaintStyle.Fill);
        canvas.drawRect(rect, fillPaint);

        // Blue dashed outline
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

        // Draw the path so far
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

        // Draw anchor points and handle lines
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

            // Draw handle lines and dots for curved points
            if (hasCurve) {
                canvas.drawLine(p.x, p.y, p.cp1x, p.cp1y, handleLinePaint);
                canvas.drawLine(p.x, p.y, p.cp2x, p.cp2y, handleLinePaint);
                canvas.drawCircle(p.cp1x, p.cp1y, handleSize, handleDotPaint);
                canvas.drawCircle(p.cp2x, p.cp2y, handleSize, handleDotPaint);
            }

            // White fill with blue border for anchor
            dotPaint.setColor(this.ck.Color(255, 255, 255, 1.0));
            dotPaint.setStyle(this.ck.PaintStyle.Fill);
            canvas.drawRect(this.ck.LTRBRect(
                p.x - dotSize, p.y - dotSize, p.x + dotSize, p.y + dotSize
            ), dotPaint);
            dotPaint.setColor(this.ck.Color(0, 162, 255, 1.0));
            dotPaint.setStyle(this.ck.PaintStyle.Stroke);
            dotPaint.setStrokeWidth(1 / this.zoom);
            canvas.drawRect(this.ck.LTRBRect(
                p.x - dotSize, p.y - dotSize, p.x + dotSize, p.y + dotSize
            ), dotPaint);
        }

        handleLinePaint.delete();
        handleDotPaint.delete();

        // Draw preview line from last point to current mouse position
        if (points.length > 0 && this.inputManager) {
            const last = points[points.length - 1];
            const mousePos = this.inputManager.currentPos;
            if (mousePos) {
                const dashPaint = new this.ck.Paint();
                dashPaint.setColor(this.ck.Color(0, 162, 255, 0.5));
                dashPaint.setStyle(this.ck.PaintStyle.Stroke);
                dashPaint.setStrokeWidth(1 / this.zoom);
                canvas.drawLine(last.x, last.y, mousePos.x, mousePos.y, dashPaint);
                dashPaint.delete();
            }
        }

        strokePaint.delete();
        dotPaint.delete();
    }
    private renderSelectionOverlay(canvas: Canvas, dpr: number, nodes: any) {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const paint = new this.ck.Paint();
        paint.setColor(this.ck.Color(0, 162, 255, 1.0));
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1.5 / this.zoom);

        for (const id of selection) {
            const node = nodes[id];
            if (!node) continue;

            const transform = this.scene.getTransform(id);
            canvas.save();
            canvas.concat(transform);

            if (node.geometry.Rect) {
                const { width, height } = node.geometry.Rect;
                canvas.drawRect(this.ck.LTRBRect(0, 0, width, height), paint);
            } else if (node.geometry.Ellipse) {
                const { radius_x, radius_y } = node.geometry.Ellipse;
                canvas.drawOval(this.ck.LTRBRect(-radius_x, -radius_y, radius_x, radius_y), paint);
            } else if (node.geometry.Path) {
                const points = node.geometry.Path.points;
                if (points && points.length >= 2) {
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    for (const p of points) {
                        // Include anchor
                        minX = Math.min(minX, p.x);
                        minY = Math.min(minY, p.y);
                        maxX = Math.max(maxX, p.x);
                        maxY = Math.max(maxY, p.y);
                        // Include control points
                        minX = Math.min(minX, p.cp1[0], p.cp2[0]);
                        minY = Math.min(minY, p.cp1[1], p.cp2[1]);
                        maxX = Math.max(maxX, p.cp1[0], p.cp2[0]);
                        maxY = Math.max(maxY, p.cp1[1], p.cp2[1]);
                    }
                    canvas.drawRect(this.ck.LTRBRect(minX, minY, maxX, maxY), paint);
                }
            } else if (node.geometry.Text) {
                const { content, font_size } = node.geometry.Text;
                const approxW = content.length * font_size * 0.6;
                canvas.drawRect(this.ck.LTRBRect(0, -font_size, approxW, 0), paint);
            }

            canvas.restore();
        }

        paint.delete();

        // Draw resize handles
        if (selection.length === 1) {
            const bounds = this.scene.getNodeBounds(selection[0]);
            const [minX, minY, maxX, maxY] = bounds;
            const hSize = 4 / this.zoom;
            const midX = (minX + maxX) / 2;
            const midY = (minY + maxY) / 2;

            const handlePositions = [
                [minX, minY], [midX, minY], [maxX, minY],
                [minX, midY],               [maxX, midY],
                [minX, maxY], [midX, maxY], [maxX, maxY],
            ];

            const handleFill = new this.ck.Paint();
            handleFill.setColor(this.ck.Color(255, 255, 255, 1.0));
            handleFill.setStyle(this.ck.PaintStyle.Fill);

            const handleStroke = new this.ck.Paint();
            handleStroke.setColor(this.ck.Color(0, 162, 255, 1.0));
            handleStroke.setStyle(this.ck.PaintStyle.Stroke);
            handleStroke.setStrokeWidth(1 / this.zoom);

            for (const [hx, hy] of handlePositions) {
                canvas.drawRect(
                    this.ck.LTRBRect(hx - hSize, hy - hSize, hx + hSize, hy + hSize),
                    handleFill
                );
                canvas.drawRect(
                    this.ck.LTRBRect(hx - hSize, hy - hSize, hx + hSize, hy + hSize),
                    handleStroke
                );
            }

            handleFill.delete();
            handleStroke.delete();
        }

        canvas.restore();
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

        // Center artboard (1000x1000 default)
        const size = 1000;
        const x = (this.canvas.clientWidth - size) / 2;
        const y = (this.canvas.clientHeight - size) / 2;

        canvas.drawRect(this.ck.LTRBRect(x, y, x + size, y + size), paint);
        
        // Artboard border
        paint.setColor(this.ck.Color(80, 80, 80, 1.0));
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1);
        canvas.drawRect(this.ck.LTRBRect(x, y, x + size, y + size), paint);

        paint.delete();
    }

    // ─── Live Paint Rendering ───────────────────────────────────────────────

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
        } catch {
            // Silently ignore parse errors
        }
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

            // Semi-transparent blue preview
            const paint = new this.ck.Paint();
            paint.setColor(this.ck.Color(66, 133, 244, 0.3));
            paint.setStyle(this.ck.PaintStyle.Fill);
            paint.setAntiAlias(true);
            canvas.drawPath(path, paint);

            // Thin blue outline
            paint.setColor(this.ck.Color(66, 133, 244, 0.8));
            paint.setStyle(this.ck.PaintStyle.Stroke);
            paint.setStrokeWidth(1.5 / this.zoom);
            canvas.drawPath(path, paint);

            path.delete();
            paint.delete();
        } catch {
            // Silently ignore
        }
    }
}
