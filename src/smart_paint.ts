import type { CanvasKit } from 'canvaskit-wasm';
import type { WasmScene } from './wasm_scene';

export class SmartPaint {
    ck: CanvasKit;
    scene: WasmScene;

    constructor(ck: CanvasKit, scene: WasmScene) {
        this.ck = ck;
        this.scene = scene;
    }

    // Finds the enclosed region at (screenX, screenY) in screen coordinates
    // and returns a CanvasKit Path in world coordinates
    findRegion(screenX: number, screenY: number, width: number, height: number, dpr: number, pan: {x: number, y: number}, zoom: number): ReturnType<CanvasKit['Path']['prototype']> | null {
        try {
            // 1. Create an offscreen surface to render strokes
            const surface = (this.ck as any).MakeSurface(width, height);
            if (!surface) {
                console.error("SmartPaint: MakeSurface failed");
                return null;
            }
            
            const canvas = surface.getCanvas();
            canvas.clear(this.ck.TRANSPARENT);
            
            // Apply camera transform to match screen
            canvas.save();
            canvas.scale(dpr, dpr);
            canvas.translate(pan.x, pan.y);
            canvas.scale(zoom, zoom);

            // 2. Render all WASM engine nodes as thin black strokes
            const paint = new this.ck.Paint();
            paint.setColor(this.ck.BLACK);
            paint.setStyle(this.ck.PaintStyle.Stroke);
            paint.setStrokeWidth(1 / zoom);

            const sceneData = this.scene.getSceneData();
            const nodes = sceneData.nodes;

            for (const idStr of Object.keys(nodes)) {
                const id = Number(idStr);
                const node = nodes[id];
                if (!node || !node.visible) continue;

                // Get the pre-computed global transform from WASM
                const transform = this.scene.getTransform(id);

                canvas.save();
                canvas.concat(transform);

                const geom = node.geometry;
                if (geom.Rect) {
                    canvas.drawRect(
                        this.ck.LTRBRect(0, 0, geom.Rect.width, geom.Rect.height),
                        paint
                    );
                } else if (geom.Ellipse) {
                    const { radius_x, radius_y } = geom.Ellipse;
                    canvas.drawOval(
                        this.ck.LTRBRect(-radius_x, -radius_y, radius_x, radius_y),
                        paint
                    );
                }
                // Path geometry could be added here in the future

                canvas.restore();
            }
            
            canvas.restore();
            paint.delete();

            // 3. Read pixels to perform flood fill
            const image = surface.makeImageSnapshot();
            const pixels = (image as any).readPixels(0, 0, {
                width: width,
                height: height,
                colorType: this.ck.ColorType.RGBA_8888,
                alphaType: this.ck.AlphaType.Unpremul,
                colorSpace: this.ck.ColorSpace.SRGB
            });

            if (!pixels) {
                console.error("SmartPaint: readPixels failed");
                image.delete();
                surface.delete();
                return null;
            }

            // 4. Perform Flood Fill on the alpha channel to find the region
            const startX = Math.floor(screenX * dpr);
            const startY = Math.floor(screenY * dpr);
            
            if (startX < 0 || startX >= width || startY < 0 || startY >= height) {
                console.error("SmartPaint: Click outside of canvas bounds", startX, startY);
                image.delete();
                surface.delete();
                return null;
            }

            const mask = this.floodFill(pixels, startX, startY, width, height);
            
            if (!mask) {
                console.error("SmartPaint: floodFill returned null (clicked on stroke or region too small)");
                image.delete();
                surface.delete();
                return null;
            }

            // 5. Trace the mask to create a vector path
            const path = this.traceContour(mask, width, height, dpr, pan, zoom);
            
            // Cleanup
            image.delete();
            surface.delete();

            return path;
        } catch (e) {
            console.error("SmartPaint Error:", e);
            return null;
        }
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

    traceContour(mask: Uint8Array, width: number, height: number, dpr: number, pan: {x: number, y: number}, zoom: number): any {
        // Simple bounding box for now, in a real tool we'd use Marching Squares
        const path: any = new (this.ck as any).Path();
        
        // Find bounding box of mask
        let minX = width, minY = height, maxX = 0, maxY = 0;
        let found = false;
        for (let i = 0; i < mask.length; i++) {
            if (mask[i]) {
                const x = i % width;
                const y = Math.floor(i / width);
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
                found = true;
            }
        }

        if (!found) return null;
        
        // Convert screen physical pixels to world coordinates
        const worldMinX = (minX / dpr - pan.x) / zoom;
        const worldMinY = (minY / dpr - pan.y) / zoom;
        const worldMaxX = (maxX / dpr - pan.x) / zoom;
        const worldMaxY = (maxY / dpr - pan.y) / zoom;
        
        path.addRect(this.ck.LTRBRect(worldMinX, worldMinY, worldMaxX, worldMaxY));
        
        return path;
    }
}
