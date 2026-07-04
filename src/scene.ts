import type { CanvasKit, Canvas, Paint, InputColor } from 'canvaskit-wasm';
import { UIEngine } from './ui';

export interface SceneObject {
    render(canvas: Canvas, ck: CanvasKit): void;
    renderOutline?(canvas: Canvas, ck: CanvasKit, paint: Paint): void;
    getBounds(ck: CanvasKit): any;
    x?: number;
    y?: number;
    _cachedPath?: any;
    addObject?(obj: SceneObject): void;
    objects?: SceneObject[];
    name?: string;
}

export class Scene {
    ck: CanvasKit;
    objects: SceneObject[];
    selection: SceneObject[];
    ui: UIEngine | null;
    fillPaint: Paint;
    strokePaint: Paint;

    constructor(ck: CanvasKit) {
        this.ck = ck;
        this.objects = [];
        this.selection = [];
        this.ui = null; // Set by main
        
        // Default paints
        this.fillPaint = new ck.Paint();
        this.fillPaint.setStyle(ck.PaintStyle.Fill);
        this.fillPaint.setColor(ck.Color(100, 149, 237, 1.0)); // CornflowerBlue

        this.strokePaint = new ck.Paint();
        this.strokePaint.setStyle(ck.PaintStyle.Stroke);
        this.strokePaint.setColor(ck.Color(0, 0, 0, 1.0));
        this.strokePaint.setStrokeWidth(2);
    }

    addObject(obj: SceneObject) {
        this.objects.push(obj);
    }
    
    removeObject(obj: SceneObject) {
        const idx = this.objects.indexOf(obj);
        if (idx !== -1) {
            this.objects.splice(idx, 1);
        }
    }

    render(canvas: Canvas) {
        for (const obj of this.objects) {
            obj.render(canvas, this.ck);
        }

        // Draw selection highlight
        this.renderSelection(canvas);
    }

    renderSelection(canvas: Canvas) {
        if (this.selection.length === 0) return;

        const paint = new this.ck.Paint();
        paint.setColor(this.ck.Color(0, 162, 255, 1.0)); // Figma/Illustrator blue
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1.5);

        for (const obj of this.selection) {
            const bounds = obj.getBounds(this.ck);
            canvas.drawRect(bounds, paint);
            
            // Draw handles
            paint.setStyle(this.ck.PaintStyle.Fill);
            this.drawHandle(canvas, bounds.fLeft, bounds.fTop, paint);
            this.drawHandle(canvas, bounds.fRight, bounds.fTop, paint);
            this.drawHandle(canvas, bounds.fLeft, bounds.fBottom, paint);
            this.drawHandle(canvas, bounds.fRight, bounds.fBottom, paint);
        }
        paint.delete();
    }

    drawHandle(canvas: Canvas, x: number, y: number, paint: Paint) {
        const size = 6;
        canvas.drawRect(this.ck.LTRBRect(x - size/2, y - size/2, x + size/2, y + size/2), paint);
        
        // Inner white
        const whitePaint = new this.ck.Paint();
        whitePaint.setColor(this.ck.Color(255, 255, 255, 1.0));
        canvas.drawRect(this.ck.LTRBRect(x - size/2 + 1, y - size/2 + 1, x + size/2 - 1, y + size/2 - 1), whitePaint);
        whitePaint.delete();
    }
}

export class PathObject implements SceneObject {
    ck: CanvasKit;
    points: Array<{ x: number; y: number; cp1: { x: number; y: number }; cp2: { x: number; y: number } }>;
    isClosed: boolean;
    fill: InputColor;
    stroke: InputColor;
    strokeWidth: number = 2;
    opacity: number = 1.0;
    _cachedPath: any;
    x?: number;
    y?: number;

    constructor(ck: CanvasKit) {
        this.ck = ck;
        this.points = []; // {x, y, cp1, cp2}
        this.isClosed = false;
        this.fill = ck.Color(200, 200, 200, 0.5);
        this.stroke = ck.Color(0, 0, 0, 1.0);
        this._cachedPath = null;
    }

    addPoint(x: number, y: number) {
        this.points.push({ x, y, cp1: { x, y }, cp2: { x, y } });
    }

    private getPath(ck: CanvasKit): any {
        const path: any = this._cachedPath || new (ck as any).Path();
        if (!this._cachedPath && this.points.length >= 2) {
            path.moveTo(this.points[0].x, this.points[0].y);
            for (let i = 1; i < this.points.length; i++) {
                const p = this.points[i];
                const prev = this.points[i - 1];
                path.cubicTo(prev.cp2.x, prev.cp2.y, p.cp1.x, p.cp1.y, p.x, p.y);
            }
            if (this.isClosed) path.close();
        }
        return path;
    }

    render(canvas: Canvas, ck: CanvasKit) {
        if (this.points.length < 2 && !this._cachedPath) return;
        const path = this.getPath(ck);

        const paint = new ck.Paint();
        if (this.opacity < 1.0) paint.setAlphaf(this.opacity);

        if (this.isClosed || this._cachedPath) {
            paint.setColor(this.fill);
            paint.setStyle(ck.PaintStyle.Fill);
            canvas.drawPath(path, paint);
        }

        paint.setColor(this.stroke);
        paint.setStyle(ck.PaintStyle.Stroke);
        paint.setStrokeWidth(this.strokeWidth);
        canvas.drawPath(path, paint);

        if (!this._cachedPath) path.delete();
        paint.delete();
    }

    renderOutline(canvas: Canvas, ck: CanvasKit, paint: Paint) {
        if (this.points.length < 2 && !this._cachedPath) return;
        const path = this.getPath(ck);
        canvas.drawPath(path, paint);
        if (!this._cachedPath) path.delete();
    }

    getBounds(ck: CanvasKit): any {
        if (this._cachedPath) return this._cachedPath.getBounds();
        const path = this.getPath(ck);
        const bounds = path.getBounds();
        path.delete();
        return bounds;
    }
}

export class RectObject implements SceneObject {
    ck: CanvasKit;
    x: number;
    y: number;
    w: number;
    h: number;
    fill: InputColor;
    stroke: InputColor;
    strokeWidth: number = 2;
    opacity: number = 1.0;

    constructor(ck: CanvasKit, x: number, y: number, w: number, h: number, fill: InputColor, stroke: InputColor) {
        this.ck = ck;
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.fill = fill;
        this.stroke = stroke;
    }

    render(canvas: Canvas, ck: CanvasKit) {
        const paint = new ck.Paint();
        if (this.opacity < 1.0) paint.setAlphaf(this.opacity);
        paint.setColor(this.fill);
        paint.setStyle(ck.PaintStyle.Fill);
        canvas.drawRect(ck.LTRBRect(this.x, this.y, this.x + this.w, this.y + this.h), paint);
        
        paint.setColor(this.stroke);
        paint.setStyle(ck.PaintStyle.Stroke);
        paint.setStrokeWidth(this.strokeWidth);
        canvas.drawRect(ck.LTRBRect(this.x, this.y, this.x + this.w, this.y + this.h), paint);
        
        paint.delete();
    }

    renderOutline(canvas: Canvas, ck: CanvasKit, paint: Paint) {
        canvas.drawRect(ck.LTRBRect(this.x, this.y, this.x + this.w, this.y + this.h), paint);
    }

    getBounds(ck: CanvasKit): any {
        return ck.LTRBRect(this.x, this.y, this.x + this.w, this.y + this.h);
    }
}

export class EllipseObject implements SceneObject {
    ck: CanvasKit;
    x: number;
    y: number;
    rx: number;
    ry: number;
    fill: InputColor;
    stroke: InputColor;
    rotation: number = 0;
    scaleX: number = 1;
    scaleY: number = 1;
    opacity: number = 1;
    strokeWidth: number = 2;

    constructor(ck: CanvasKit, cx: number, cy: number, rx: number, ry: number, fill: InputColor, stroke: InputColor) {
        this.ck = ck;
        this.x = cx;
        this.y = cy;
        this.rx = rx;
        this.ry = ry;
        this.fill = fill;
        this.stroke = stroke;
    }

    render(canvas: Canvas, ck: CanvasKit) {
        const paint = new ck.Paint();
        if (this.opacity < 1.0) paint.setAlphaf(this.opacity);

        paint.setColor(this.fill);
        paint.setStyle(ck.PaintStyle.Fill);
        canvas.drawOval(ck.LTRBRect(this.x - this.rx, this.y - this.ry, this.x + this.rx, this.y + this.ry), paint);
        
        paint.setColor(this.stroke);
        paint.setStyle(ck.PaintStyle.Stroke);
        paint.setStrokeWidth(this.strokeWidth);
        canvas.drawOval(ck.LTRBRect(this.x - this.rx, this.y - this.ry, this.x + this.rx, this.y + this.ry), paint);
        
        paint.delete();
    }

    renderOutline(canvas: Canvas, ck: CanvasKit, paint: Paint) {
        canvas.drawOval(ck.LTRBRect(this.x - this.rx, this.y - this.ry, this.x + this.rx, this.y + this.ry), paint);
    }

    getBounds(ck: CanvasKit): any {
        return ck.LTRBRect(this.x - this.rx, this.y - this.ry, this.x + this.rx, this.y + this.ry);
    }
}

export class PolygonObject implements SceneObject {
    ck: CanvasKit;
    x: number;
    y: number;
    radius: number;
    sides: number = 6;
    fill: InputColor;
    stroke: InputColor;
    rotation: number = 0;
    scaleX: number = 1;
    scaleY: number = 1;
    opacity: number = 1;
    strokeWidth: number = 2;
    name: string = 'Polygon';

    constructor(ck: CanvasKit, cx: number, cy: number, radius: number, fill: InputColor, stroke: InputColor) {
        this.ck = ck;
        this.x = cx;
        this.y = cy;
        this.radius = radius;
        this.fill = fill;
        this.stroke = stroke;
    }

    private getPath(ck: CanvasKit): any {
        const path = new ck.Path();
        const step = (Math.PI * 2) / this.sides;
        for (let i = 0; i < this.sides; i++) {
            const px = this.x + this.radius * Math.cos(i * step - Math.PI / 2);
            const py = this.y + this.radius * Math.sin(i * step - Math.PI / 2);
            if (i === 0) path.moveTo(px, py);
            else path.lineTo(px, py);
        }
        path.close();
        return path;
    }

    render(canvas: Canvas, ck: CanvasKit) {
        if (this.radius <= 0) return;
        const path = this.getPath(ck);

        const paint = new ck.Paint();
        if (this.opacity < 1.0) paint.setAlphaf(this.opacity);

        paint.setColor(this.fill);
        paint.setStyle(ck.PaintStyle.Fill);
        canvas.drawPath(path, paint);

        paint.setColor(this.stroke);
        paint.setStyle(ck.PaintStyle.Stroke);
        paint.setStrokeWidth(this.strokeWidth);
        canvas.drawPath(path, paint);

        paint.delete();
        path.delete();
    }

    renderOutline(canvas: Canvas, ck: CanvasKit, paint: Paint) {
        if (this.radius <= 0) return;
        const path = this.getPath(ck);
        canvas.drawPath(path, paint);
        path.delete();
    }

    getBounds(ck: CanvasKit): any {
        return ck.LTRBRect(this.x - this.radius, this.y - this.radius, this.x + this.radius, this.y + this.radius);
    }
}

export class StarObject implements SceneObject {
    ck: CanvasKit;
    x: number;
    y: number;
    outerRadius: number;
    innerRadius: number;
    points: number = 5;
    fill: InputColor;
    stroke: InputColor;
    rotation: number = 0;
    scaleX: number = 1;
    scaleY: number = 1;
    opacity: number = 1;
    strokeWidth: number = 2;
    name: string = 'Star';

    constructor(ck: CanvasKit, cx: number, cy: number, outerRadius: number, innerRadius: number, fill: InputColor, stroke: InputColor) {
        this.ck = ck;
        this.x = cx;
        this.y = cy;
        this.outerRadius = outerRadius;
        this.innerRadius = innerRadius;
        this.fill = fill;
        this.stroke = stroke;
    }

    private getPath(ck: CanvasKit): any {
        const path = new ck.Path();
        const step = Math.PI / this.points;
        for (let i = 0; i < this.points * 2; i++) {
            const r = (i % 2 === 0) ? this.outerRadius : this.innerRadius;
            const px = this.x + r * Math.cos(i * step - Math.PI / 2);
            const py = this.y + r * Math.sin(i * step - Math.PI / 2);
            if (i === 0) path.moveTo(px, py);
            else path.lineTo(px, py);
        }
        path.close();
        return path;
    }

    render(canvas: Canvas, ck: CanvasKit) {
        if (this.outerRadius <= 0) return;
        const path = this.getPath(ck);

        const paint = new ck.Paint();
        if (this.opacity < 1.0) paint.setAlphaf(this.opacity);

        paint.setColor(this.fill);
        paint.setStyle(ck.PaintStyle.Fill);
        canvas.drawPath(path, paint);

        paint.setColor(this.stroke);
        paint.setStyle(ck.PaintStyle.Stroke);
        paint.setStrokeWidth(this.strokeWidth);
        canvas.drawPath(path, paint);

        paint.delete();
        path.delete();
    }

    renderOutline(canvas: Canvas, ck: CanvasKit, paint: Paint) {
        if (this.outerRadius <= 0) return;
        const path = this.getPath(ck);
        canvas.drawPath(path, paint);
        path.delete();
    }

    getBounds(ck: CanvasKit): any {
        return ck.LTRBRect(this.x - this.outerRadius, this.y - this.outerRadius, this.x + this.outerRadius, this.y + this.outerRadius);
    }
}

export class GroupObject implements SceneObject {
    ck: CanvasKit;
    name: string;
    objects: SceneObject[];
    x?: number;
    y?: number;

    constructor(ck: CanvasKit, name = "Group") {
        this.ck = ck;
        this.name = name;
        this.objects = [];
    }

    addObject(obj: SceneObject) {
        this.objects.push(obj);
    }

    render(canvas: Canvas, ck: CanvasKit) {
        for (const obj of this.objects) {
            obj.render(canvas, ck);
        }
    }

    renderOutline(canvas: Canvas, ck: CanvasKit, paint: Paint) {
        for (const obj of this.objects) {
            if (obj.renderOutline) {
                obj.renderOutline(canvas, ck, paint);
            }
        }
    }

    getBounds(ck: CanvasKit): any {
        if (this.objects.length === 0) return ck.LTRBRect(0,0,0,0);
        let bounds: any = this.objects[0].getBounds(ck);
        for (let i = 1; i < this.objects.length; i++) {
            const b: any = this.objects[i].getBounds(ck);
            bounds = ck.LTRBRect(
                Math.min(bounds.fLeft, b.fLeft),
                Math.min(bounds.fTop, b.fTop),
                Math.max(bounds.fRight, b.fRight),
                Math.max(bounds.fBottom, b.fBottom)
            );
        }
        return bounds;
    }
}
