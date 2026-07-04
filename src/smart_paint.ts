import type { CanvasKit } from 'canvaskit-wasm';
import { Scene } from './scene';

export class SmartPaint {
    ck: CanvasKit;
    scene: Scene;

    constructor(ck: CanvasKit, scene: Scene) {
        this.ck = ck;
        this.scene = scene;
    }

    // Finds the enclosed region at (x, y) and returns a new PathObject
    findRegion(x: number, y: number, width: number, height: number): any {
        // 1. Create an offscreen surface to render strokes
        const surface = (this.ck as any).MakeSurface(width, height);
        const canvas = surface.getCanvas();
        canvas.clear(this.ck.TRANSPARENT);

        // 2. Render all scene objects as thin black strokes
        const paint = new this.ck.Paint();
        paint.setColor(this.ck.BLACK);
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1);

        for (const obj of this.scene.objects) {
            obj.render(canvas, this.ck);
        }

        // 3. Read pixels to perform flood fill
        const image = surface.makeImageSnapshot();
        const pixels = (image as any).readPixels(0, 0, {
            width: width,
            height: height,
            colorType: this.ck.ColorType.RGBA_8888,
            alphaType: this.ck.AlphaType.Unpremul,
        });

        if (!pixels) return null;

        // 4. Perform Flood Fill on the alpha channel to find the region
        const mask = this.floodFill(pixels, Math.floor(x), Math.floor(y), width, height);
        
        if (!mask) return null;

        // 5. Trace the mask to create a vector path
        const path = this.traceContour(mask, width, height);
        
        // Cleanup
        image.delete();
        surface.delete();
        paint.delete();

        return path;
    }

    floodFill(pixels: Uint8Array, startX: number, startY: number, width: number, height: number): Uint8Array | null {
        const targetAlpha = pixels[startY * width * 4 + startX * 4 + 3];
        if (targetAlpha > 10) return null; // Clicked on a stroke

        const mask = new Uint8Array(width * height);
        const queue: number[][] = [[startX, startY]];
        const visited = new Uint8Array(width * height);
        
        visited[startY * width + startX] = 1;
        mask[startY * width + startX] = 1;

        let count = 0;
        const maxPixels = width * height * 0.8; // Safety break

        while (queue.length > 0 && count < maxPixels) {
            const [cx, cy] = queue.shift()!;
            count++;

            const neighbors = [[cx+1, cy], [cx-1, cy], [cx, cy+1], [cx, cy-1]];
            for (const [nx, ny] of neighbors) {
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    const idx = ny * width + nx;
                    const pIdx = idx * 4;
                    if (!visited[idx] && pixels[pIdx + 3] < 10) {
                        visited[idx] = 1;
                        mask[idx] = 1;
                        queue.push([nx, ny]);
                    }
                }
            }
        }

        return count > 10 ? mask : null;
    }

    traceContour(mask: Uint8Array, width: number, height: number): any {
        // Simple bounding box for now, in a real tool we'd use Marching Squares
        const path: any = new (this.ck as any).Path();
        
        // Find first pixel
        let startPixel: { x: number; y: number } | null = null;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (mask[y * width + x]) {
                    startPixel = {x, y};
                    break;
                }
            }
            if (startPixel) break;
        }

        if (!startPixel) return null;

        path.moveTo(startPixel.x, startPixel.y);
        
        // Dummy region for now: a rect encompassing the filled area
        let minX = startPixel.x, minY = startPixel.y, maxX = startPixel.x, maxY = startPixel.y;
        for(let i=0; i<mask.length; i++) {
            if(mask[i]) {
                const x = i % width;
                const y = Math.floor(i / width);
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
        path.addRect(this.ck.LTRBRect(minX, minY, maxX, maxY));
        
        return path;
    }
}
