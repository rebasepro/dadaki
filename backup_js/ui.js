import { GroupObject } from './scene.js';

export class UIEngine {
    constructor(ck, scene) {
        this.ck = ck;
        this.scene = scene;
        this.scene.ui = this;
        
        this.activeTool = 'selection';
        this.toolbarWidth = 48;
        this.panelWidth = 260;
        this.headerHeight = 40;

        this.tools = [
            { id: 'selection', icon: 'V', name: 'Selection Tool' },
            { id: 'direct', icon: 'A', name: 'Direct Selection' },
            { id: 'pen', icon: 'P', name: 'Pen Tool' },
            { id: 'rect', icon: 'M', name: 'Rectangle' },
            { id: 'ellipse', icon: 'L', name: 'Ellipse' },
            { id: 'smart-paint', icon: 'K', name: 'Smart Paint' }
        ];
    }

    render(canvas, width, height) {
        this.drawToolbar(canvas, height);
        this.drawPropertiesPanel(canvas, width, height);
        this.drawMenubar(canvas, width);
    }

    drawToolbar(canvas, height) {
        const bgPaint = new this.ck.Paint();
        bgPaint.setColor(this.ck.Color(60/255, 60/255, 60/255, 1.0));
        canvas.drawRect(this.ck.LTRBRect(0, this.headerHeight, this.toolbarWidth, height), bgPaint);

        const borderPaint = new this.ck.Paint();
        borderPaint.setColor(this.ck.Color(40/255, 40/255, 40/255, 1.0));
        borderPaint.setStyle(this.ck.PaintStyle.Stroke);
        canvas.drawLine(this.toolbarWidth, 0, this.toolbarWidth, height, borderPaint);

        // Draw Tool Buttons
        const textPaint = new this.ck.Paint();
        textPaint.setColor(this.ck.Color(200/255, 200/255, 200/255, 1.0));
        const font = new this.ck.Font(null, 14);

        this.tools.forEach((tool, i) => {
            const y = this.headerHeight + 20 + i * 44;
            const isActive = this.activeTool === tool.id;

            if (isActive) {
                const activePaint = new this.ck.Paint();
                activePaint.setColor(this.ck.Color(0, 120/255, 215/255, 1.0));
                canvas.drawRRect(this.ck.RRectXY(this.ck.LTRBRect(6, y - 6, this.toolbarWidth - 6, y + 26), 4, 4), activePaint);
                textPaint.setColor(this.ck.Color(1.0, 1.0, 1.0, 1.0));
                activePaint.delete();
            } else {
                textPaint.setColor(this.ck.Color(200/255, 200/255, 200/255, 1.0));
            }

            canvas.drawText(tool.icon, 18, y + 14, textPaint, font);
        });

        bgPaint.delete();
        borderPaint.delete();
        textPaint.delete();
        font.delete();
    }

    drawPropertiesPanel(canvas, width, height) {
        const x = width - this.panelWidth;
        const bgPaint = new this.ck.Paint();
        bgPaint.setColor(this.ck.Color(60/255, 60/255, 60/255, 1.0));
        canvas.drawRect(this.ck.LTRBRect(x, this.headerHeight, width, height), bgPaint);

        const borderPaint = new this.ck.Paint();
        borderPaint.setColor(this.ck.Color(40/255, 40/255, 40/255, 1.0));
        borderPaint.setStyle(this.ck.PaintStyle.Stroke);
        canvas.drawLine(x, 0, x, height, borderPaint);

        // Panel Title
        const textPaint = new this.ck.Paint();
        textPaint.setColor(this.ck.Color(1.0, 1.0, 1.0, 1.0));
        const font = new this.ck.Font(null, 12);
        canvas.drawText('LAYERS', x + 16, this.headerHeight + 24, textPaint, font);

        // Draw Layer Tree
        let y = this.headerHeight + 50;
        this.scene.objects.forEach(obj => {
            if (obj instanceof GroupObject) {
                canvas.drawText(`▼ ${obj.name}`, x + 16, y, textPaint, font);
                y += 20;
                obj.objects.forEach(child => {
                    canvas.drawText(`  • ${child.constructor.name}`, x + 32, y, textPaint, font);
                    y += 20;
                });
            } else {
                canvas.drawText(`• ${obj.constructor.name}`, x + 16, y, textPaint, font);
                y += 20;
            }
        });

        bgPaint.delete();
        borderPaint.delete();
        textPaint.delete();
        font.delete();
    }

    drawMenubar(canvas, width) {
        const bgPaint = new this.ck.Paint();
        bgPaint.setColor(this.ck.Color(45/255, 45/255, 45/255, 1.0));
        canvas.drawRect(this.ck.LTRBRect(0, 0, width, this.headerHeight), bgPaint);

        const borderPaint = new this.ck.Paint();
        borderPaint.setColor(this.ck.Color(30/255, 30/255, 30/255, 1.0));
        borderPaint.setStyle(this.ck.PaintStyle.Stroke);
        canvas.drawLine(0, this.headerHeight, width, this.headerHeight, borderPaint);

        bgPaint.delete();
        borderPaint.delete();
    }
}
