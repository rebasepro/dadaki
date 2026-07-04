export class Renderer {
    constructor(ck, canvas, scene) {
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
        this.context = this.ck.GetWebGLContext(this.canvas);
        this.surface = this.ck.MakeWebGLCanvasSurface(this.canvas, null, null);
        
        if (!this.surface) {
            throw new Error('Failed to create CanvasKit surface');
        }

        window.addEventListener('resize', () => this.onResize());
        this.onResize();
    }

    onResize() {
        this.canvas.width = window.innerWidth * window.devicePixelRatio;
        this.canvas.height = window.innerHeight * window.devicePixelRatio;
        this.surface.reportBackendType(); // Refresh
        this.render();
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
        const canvas = this.surface.getCanvas();
        const dpr = window.devicePixelRatio;

        canvas.clear(this.ck.Color(43/255, 43/255, 43/255, 1.0)); // Dark grey background (#2b2b2b)
        
        canvas.save();
        canvas.scale(dpr, dpr);

        // Apply View Transformations
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        // 1. Draw Artboard
        this.drawArtboard(canvas);

        // 2. Draw Scene Objects
        this.scene.render(canvas);

        canvas.restore();

        // 3. Draw UI Chrome (stays fixed)
        canvas.save();
        canvas.scale(dpr, dpr);
        this.scene.ui.render(canvas, window.innerWidth, window.innerHeight);
        canvas.restore();

        this.surface.flush();
    }

    drawArtboard(canvas) {
        const paint = new this.ck.Paint();
        paint.setColor(this.ck.Color(1.0, 1.0, 1.0, 1.0));
        paint.setStyle(this.ck.PaintStyle.Fill);

        // Center artboard (1000x1000 default)
        const size = 1000;
        const x = (window.innerWidth - size) / 2;
        const y = (window.innerHeight - size) / 2;

        canvas.drawRect(this.ck.LTRBRect(x, y, x + size, y + size), paint);
        
        // Artboard border
        paint.setColor(this.ck.Color(80/255, 80/255, 80/255, 1.0));
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1);
        canvas.drawRect(this.ck.LTRBRect(x, y, x + size, y + size), paint);

        paint.delete();
    }
}
