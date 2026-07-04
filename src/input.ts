import { RectObject, PathObject, GroupObject, Scene, EllipseObject, PolygonObject, StarObject } from './scene';
import { SmartPaint } from './smart_paint';
import { UIEngine } from './ui';
import { Renderer } from './renderer';
import { Pathfinder, PathfinderOp } from './pathfinder';

export class InputManager {
    canvas: HTMLCanvasElement;
    scene: Scene;
    ui: UIEngine;
    renderer: Renderer;
    pathfinder: Pathfinder;
    isMouseDown: boolean;
    startPos: { x: number; y: number };
    currentPos: { x: number; y: number };
    smartPaint: SmartPaint;
    currentPath: PathObject | null;
    isDraggingHandle: boolean;
    dragMode: 'move' | 'none' = 'none';
    previewObject: SceneObject | null = null;

    constructor(canvas: HTMLCanvasElement, scene: Scene, ui: UIEngine, renderer: Renderer) {
        this.canvas = canvas;
        this.scene = scene;
        this.ui = ui;
        this.renderer = renderer;
        this.pathfinder = new Pathfinder(scene.ck);

        this.isMouseDown = false;
        this.startPos = { x: 0, y: 0 };
        this.currentPos = { x: 0, y: 0 };
        this.smartPaint = new SmartPaint(scene.ck, scene);
        this.currentPath = null;
        this.isDraggingHandle = false;

        this.init();
        this.initPathfinderEvents();
    }

    init() {
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        window.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('mouseup', (e) => this.onMouseUp(e));
        
        // Keyboard shortcuts
        window.addEventListener('keydown', (e) => this.onKeyDown(e));

        // Panning/Zooming
        window.addEventListener('wheel', (e) => this.onWheel(e), { passive: false, capture: true });
    }

    initPathfinderEvents() {
        const ops = {
            'op-union': PathfinderOp.Union,
            'op-subtract': PathfinderOp.Difference,
            'op-intersect': PathfinderOp.Intersect,
            'op-xor': PathfinderOp.Xor
        };

        Object.entries(ops).forEach(([id, op]) => {
            document.getElementById(id)?.addEventListener('click', () => {
                if (this.scene.selection.length >= 2) {
                    const result = this.pathfinder.apply(this.scene.selection, op);
                    if (result) {
                        // Remove old objects
                        this.scene.selection.forEach(obj => this.scene.removeObject(obj));
                        this.scene.addObject(result);
                        this.scene.selection = [result];
                        this.ui.updateLayerList();
                    }
                }
            });
        });
    }

    onKeyDown(e: KeyboardEvent) {
        if (e.key === 'v' || e.key === 'V') this.ui.setActiveTool('selection');
        if (e.key === 'a' || e.key === 'A') this.ui.setActiveTool('direct');
        if (e.key === 'p' || e.key === 'P') this.ui.setActiveTool('pen');
        if (e.key === 'm' || e.key === 'M') this.ui.setActiveTool('rect');
        if (e.key === 'l' || e.key === 'L') this.ui.setActiveTool('ellipse');
        if (e.key === 'k' || e.key === 'K') this.ui.setActiveTool('smart-paint');
        
        if (e.key === 'Backspace' || e.key === 'Delete') {
            this.scene.selection.forEach(obj => this.scene.removeObject(obj));
            this.scene.selection = [];
            this.ui.updateLayerList();
        }
    }

    getPos(e: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = (e.clientX - rect.left);
        const screenY = (e.clientY - rect.top);

        return {
            x: (screenX - this.renderer.pan.x) / this.renderer.zoom,
            y: (screenY - this.renderer.pan.y) / this.renderer.zoom
        };
    }

    onWheel(e: WheelEvent) {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (e.ctrlKey || e.metaKey) {
            const factor = Math.pow(0.99, e.deltaY);
            const oldZoom = this.renderer.zoom;
            const newZoom = Math.max(0.01, Math.min(100, oldZoom * factor));
            const worldX = (mouseX - this.renderer.pan.x) / oldZoom;
            const worldY = (mouseY - this.renderer.pan.y) / oldZoom;
            this.renderer.zoom = newZoom;
            this.renderer.pan.x = mouseX - worldX * newZoom;
            this.renderer.pan.y = mouseY - worldY * newZoom;
            this.ui.setZoom(newZoom);
        } else {
            this.renderer.pan.x -= e.deltaX;
            this.renderer.pan.y -= e.deltaY;
        }
    }

    onMouseDown(e: MouseEvent) {
        this.isMouseDown = true;
        this.startPos = this.getPos(e);
        this.currentPos = { ...this.startPos };

        if (this.ui.activeTool === 'selection') {
            this.handleSelection(this.startPos, e.shiftKey);
            if (this.scene.selection.length > 0) {
                this.dragMode = 'move';
            }
        } else if (this.ui.activeTool === 'pen') {
            this.handlePenDown(this.startPos);
        } else if (this.ui.activeTool === 'smart-paint') {
            this.handleSmartPaint(e);
        } else if (this.ui.activeTool === 'rect') {
            this.previewObject = new RectObject(this.scene.ck, this.startPos.x, this.startPos.y, 0, 0,
                this.scene.ck.Color(204, 204, 204, 0.5),
                this.scene.ck.Color(0, 0, 0, 1.0)
            );
            this.scene.addObject(this.previewObject);
        } else if (this.ui.activeTool === 'ellipse') {
            this.previewObject = new EllipseObject(this.scene.ck, this.startPos.x, this.startPos.y, 0, 0,
                this.scene.ck.Color(204, 204, 204, 0.5),
                this.scene.ck.Color(0, 0, 0, 1.0)
            );
            this.scene.addObject(this.previewObject);
        } else if (this.ui.activeTool === 'polygon') {
            this.previewObject = new PolygonObject(this.scene.ck, this.startPos.x, this.startPos.y, 0,
                this.scene.ck.Color(204, 204, 204, 0.5),
                this.scene.ck.Color(0, 0, 0, 1.0)
            );
            this.scene.addObject(this.previewObject);
        } else if (this.ui.activeTool === 'star') {
            this.previewObject = new StarObject(this.scene.ck, this.startPos.x, this.startPos.y, 0, 0,
                this.scene.ck.Color(204, 204, 204, 0.5),
                this.scene.ck.Color(0, 0, 0, 1.0)
            );
            this.scene.addObject(this.previewObject);
        }
    }

    handlePenDown(pos: { x: number; y: number }) {
        if (!this.currentPath) {
            this.currentPath = new PathObject(this.scene.ck);
            this.scene.addObject(this.currentPath);
            this.ui.updateLayerList();
        }
        this.currentPath.addPoint(pos.x, pos.y);
        this.isDraggingHandle = true;
    }

    handleSmartPaint(e: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const dpr = window.devicePixelRatio;

        const path = this.smartPaint.findRegion(
            screenX, screenY, 
            this.canvas.width, this.canvas.height,
            dpr, this.renderer.pan, this.renderer.zoom
        );
        
        if (path) {
            const obj = new PathObject(this.scene.ck);
            obj._cachedPath = path;
            obj.fill = this.scene.ck.Color(100, 149, 237, 1.0);
            this.scene.addObject(obj);
            this.ui.updateLayerList();
        }
    }

    handleSelection(pos: { x: number; y: number }, isShift: boolean) {
        let hit = null;
        for (let i = this.scene.objects.length - 1; i >= 0; i--) {
            const obj = this.scene.objects[i];
            const bounds: any = obj.getBounds(this.scene.ck);
            if (pos.x >= bounds.fLeft && pos.x <= bounds.fRight && 
                pos.y >= bounds.fTop && pos.y <= bounds.fBottom) {
                hit = obj;
                break;
            }
        }

        if (hit) {
            if (isShift) {
                if (this.scene.selection.includes(hit)) {
                    this.scene.selection = this.scene.selection.filter(o => o !== hit);
                } else {
                    this.scene.selection.push(hit);
                }
            } else {
                if (!this.scene.selection.includes(hit)) {
                    this.scene.selection = [hit];
                }
            }
        } else if (!isShift) {
            this.scene.selection = [];
        }
        this.ui.syncWithSelection();
    }

    onMouseMove(e: MouseEvent) {
        if (!this.isMouseDown) return;
        const lastPos = this.currentPos;
        this.currentPos = this.getPos(e);
        const dx = this.currentPos.x - lastPos.x;
        const dy = this.currentPos.y - lastPos.y;

        if (this.ui.activeTool === 'selection' && this.dragMode === 'move') {
            for (const obj of this.scene.selection) {
                obj.x += dx;
                obj.y += dy;
            }
        } else if (this.ui.activeTool === 'pen' && this.isDraggingHandle && this.currentPath) {
            const lastPoint = this.currentPath.points[this.currentPath.points.length - 1];
            const hdx = this.currentPos.x - lastPoint.x;
            const hdy = this.currentPos.y - lastPoint.y;
            lastPoint.cp2 = { x: lastPoint.x + hdx, y: lastPoint.y + hdy };
            lastPoint.cp1 = { x: lastPoint.x - hdx, y: lastPoint.y - hdy };
            this.currentPath._cachedPath = null;
        } else if (this.previewObject) {
            if (this.ui.activeTool === 'rect') {
                const rect = this.previewObject as RectObject;
                rect.x = Math.min(this.startPos.x, this.currentPos.x);
                rect.y = Math.min(this.startPos.y, this.currentPos.y);
                rect.w = Math.abs(this.startPos.x - this.currentPos.x);
                rect.h = Math.abs(this.startPos.y - this.currentPos.y);
            } else if (this.ui.activeTool === 'ellipse') {
                const ellipse = this.previewObject as EllipseObject;
                ellipse.x = (this.startPos.x + this.currentPos.x) / 2;
                ellipse.y = (this.startPos.y + this.currentPos.y) / 2;
                ellipse.rx = Math.abs(this.startPos.x - this.currentPos.x) / 2;
                ellipse.ry = Math.abs(this.startPos.y - this.currentPos.y) / 2;
            } else if (this.ui.activeTool === 'polygon') {
                const polygon = this.previewObject as PolygonObject;
                polygon.x = this.startPos.x;
                polygon.y = this.startPos.y;
                polygon.radius = Math.hypot(this.currentPos.x - this.startPos.x, this.currentPos.y - this.startPos.y);
            } else if (this.ui.activeTool === 'star') {
                const star = this.previewObject as StarObject;
                star.x = this.startPos.x;
                star.y = this.startPos.y;
                star.outerRadius = Math.hypot(this.currentPos.x - this.startPos.x, this.currentPos.y - this.startPos.y);
                star.innerRadius = star.outerRadius * 0.5;
            }
        }
    }

    onMouseUp(e: MouseEvent) {
        if (!this.isMouseDown) return;
        this.isMouseDown = false;
        this.isDraggingHandle = false;
        this.dragMode = 'none';
        
        const endPos = this.getPos(e);
        
        if (this.previewObject) {
            this.scene.removeObject(this.previewObject);
            this.previewObject = null;
        }

        const dist = Math.hypot(endPos.x - this.startPos.x, endPos.y - this.startPos.y);

        if (dist > 5) {
            if (this.ui.activeTool === 'rect') {
                const x = Math.min(this.startPos.x, endPos.x);
                const y = Math.min(this.startPos.y, endPos.y);
                const w = Math.abs(this.startPos.x - endPos.x);
                const h = Math.abs(this.startPos.y - endPos.y);
                const rect = new RectObject(this.scene.ck, x, y, w, h, 
                    this.scene.ck.Color(204, 204, 204, 1.0),
                    this.scene.ck.Color(0, 0, 0, 1.0)
                );
                this.scene.addObject(rect);
                this.ui.updateLayerList();
            } else if (this.ui.activeTool === 'ellipse') {
                const cx = (this.startPos.x + endPos.x) / 2;
                const cy = (this.startPos.y + endPos.y) / 2;
                const rx = Math.abs(this.startPos.x - endPos.x) / 2;
                const ry = Math.abs(this.startPos.y - endPos.y) / 2;
                const ellipse = new EllipseObject(this.scene.ck, cx, cy, rx, ry,
                    this.scene.ck.Color(204, 204, 204, 1.0),
                    this.scene.ck.Color(0, 0, 0, 1.0)
                );
                this.scene.addObject(ellipse);
                this.ui.updateLayerList();
            } else if (this.ui.activeTool === 'polygon') {
                const radius = Math.hypot(endPos.x - this.startPos.x, endPos.y - this.startPos.y);
                const polygon = new PolygonObject(this.scene.ck, this.startPos.x, this.startPos.y, radius,
                    this.scene.ck.Color(204, 204, 204, 1.0),
                    this.scene.ck.Color(0, 0, 0, 1.0)
                );
                this.scene.addObject(polygon);
                this.ui.updateLayerList();
            } else if (this.ui.activeTool === 'star') {
                const outerRadius = Math.hypot(endPos.x - this.startPos.x, endPos.y - this.startPos.y);
                const star = new StarObject(this.scene.ck, this.startPos.x, this.startPos.y, outerRadius, outerRadius * 0.5,
                    this.scene.ck.Color(204, 204, 204, 1.0),
                    this.scene.ck.Color(0, 0, 0, 1.0)
                );
                this.scene.addObject(star);
                this.ui.updateLayerList();
            }
        }
    }
}
