import type { CanvasKit, Surface, Canvas } from 'canvaskit-wasm';
import { Scene } from './scene';

export class Renderer {
    ck: CanvasKit;
    canvas: HTMLCanvasElement;
    scene: Scene;
    surface: Surface | null;
    context: any;
    grContext: any;
    isRunning: boolean;
    zoom: number;
    pan: { x: number; y: number };

    constructor(ck: CanvasKit, canvas: HTMLCanvasElement, scene: Scene) {
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
        if (!this.surface) return;
        const canvas = this.surface.getCanvas();
        const dpr = window.devicePixelRatio;

        canvas.clear(this.ck.Color(43, 43, 43, 1.0)); // Dark grey background (#2b2b2b)
        
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
        if (this.scene.ui) {
            this.scene.ui.render(canvas, window.innerWidth, window.innerHeight);
        }
        canvas.restore();

        this.surface.flush();
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
}
