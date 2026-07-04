export class Scene {
    constructor(ck) {
        this.ck = ck;
        this.objects = [];
        this.selection = [];
        this.ui = null; // Set by main
        
        // Default paints
        this.fillPaint = new ck.Paint();
        this.fillPaint.setStyle(ck.PaintStyle.Fill);
        this.fillPaint.setColor(ck.Color(100/255, 149/255, 237/255, 1.0)); // CornflowerBlue

        this.strokePaint = new ck.Paint();
        this.strokePaint.setStyle(ck.PaintStyle.Stroke);
        this.strokePaint.setColor(ck.Color(0, 0, 0, 1.0));
        this.strokePaint.setStrokeWidth(2);
    }

    addObject(obj) {
        this.objects.push(obj);
    }

    render(canvas) {
        for (const obj of this.objects) {
            obj.render(canvas, this.ck);
        }

        // Draw selection highlight
        this.renderSelection(canvas);
    }

    renderSelection(canvas) {
        if (this.selection.length === 0) return;

        const paint = new this.ck.Paint();
        paint.setColor(this.ck.Color(0, 162/255, 255/255, 1.0)); // Figma/Illustrator blue
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

    drawHandle(canvas, x, y, paint) {
        const size = 6;
        canvas.drawRect(this.ck.LTRBRect(x - size/2, y - size/2, x + size/2, y + size/2), paint);
        
        // Inner white
        const whitePaint = new this.ck.Paint();
        whitePaint.setColor(this.ck.Color(1.0, 1.0, 1.0, 1.0));
        canvas.drawRect(this.ck.LTRBRect(x - size/2 + 1, y - size/2 + 1, x + size/2 - 1, y + size/2 - 1), whitePaint);
        whitePaint.delete();
    }
}

export class PathObject {
    constructor(ck) {
        this.ck = ck;
        this.points = []; // {x, y, cp1, cp2}
        this.isClosed = false;
        this.fill = ck.Color(200/255, 200/255, 200/255, 0.5);
        this.stroke = ck.Color(0, 0, 0, 1.0);
    }

    addPoint(x, y) {
        this.points.push({ x, y, cp1: { x, y }, cp2: { x, y } });
    }

    render(canvas, ck) {
        const path = this._cachedPath || new ck.Path();
        if (!this._cachedPath) {
            if (this.points.length < 2) return;
            path.moveTo(this.points[0].x, this.points[0].y);
            for (let i = 1; i < this.points.length; i++) {
                const p = this.points[i];
                const prev = this.points[i - 1];
                path.cubicTo(prev.cp2.x, prev.cp2.y, p.cp1.x, p.cp1.y, p.x, p.y);
            }
            if (this.isClosed) path.close();
        }

        const paint = new ck.Paint();
        if (this.isClosed || this._cachedPath) {
            paint.setColor(this.fill);
            paint.setStyle(ck.PaintStyle.Fill);
            canvas.drawPath(path, paint);
        }

        paint.setColor(this.stroke);
        paint.setStyle(ck.PaintStyle.Stroke);
        paint.setStrokeWidth(2);
        canvas.drawPath(path, paint);

        if (!this._cachedPath) path.delete();
        paint.delete();
    }

    getBounds(ck) {
        if (this._cachedPath) return this._cachedPath.getBounds();
        const path = new ck.Path();
        if (this.points.length > 0) {
            path.moveTo(this.points[0].x, this.points[0].y);
            for (let i = 1; i < this.points.length; i++) {
                const p = this.points[i];
                const prev = this.points[i-1];
                path.cubicTo(prev.cp2.x, prev.cp2.y, p.cp1.x, p.cp1.y, p.x, p.y);
            }
        }
        const bounds = path.getBounds();
        path.delete();
        return bounds;
    }
}

export class RectObject {
    constructor(ck, x, y, w, h, fill, stroke) {
        this.ck = ck;
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.fill = fill;
        this.stroke = stroke;
    }

    render(canvas, ck) {
        const paint = new ck.Paint();
        paint.setColor(this.fill);
        paint.setStyle(ck.PaintStyle.Fill);
        canvas.drawRect(ck.LTRBRect(this.x, this.y, this.x + this.w, this.y + this.h), paint);
        
        paint.setColor(this.stroke);
        paint.setStyle(ck.PaintStyle.Stroke);
        paint.setStrokeWidth(2);
        canvas.drawRect(ck.LTRBRect(this.x, this.y, this.x + this.w, this.y + this.h), paint);
        
        paint.delete();
    }

    getBounds(ck) {
        return ck.LTRBRect(this.x, this.y, this.x + this.w, this.y + this.h);
    }
}

export class GroupObject {
    constructor(ck, name) {
        this.ck = ck;
        this.name = name;
        this.objects = [];
    }

    addObject(obj) {
        this.objects.push(obj);
    }

    render(canvas, ck) {
        for (const obj of this.objects) {
            obj.render(canvas, ck);
        }
    }

    getBounds(ck) {
        if (this.objects.length === 0) return ck.LTRBRect(0,0,0,0);
        let bounds = this.objects[0].getBounds(ck);
        for (let i = 1; i < this.objects.length; i++) {
            const b = this.objects[i].getBounds(ck);
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
