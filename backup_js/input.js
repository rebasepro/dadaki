import { RectObject, PathObject, GroupObject } from './scene.js';
import { SmartPaint } from './smart_paint.js';

export class InputManager {
    constructor(canvas, scene, ui, renderer) {
        this.canvas = canvas;
        this.scene = scene;
        this.ui = ui;
        this.renderer = renderer;

        this.isMouseDown = false;
        this.startPos = { x: 0, y: 0 };
        this.currentPos = { x: 0, y: 0 };
        this.smartPaint = new SmartPaint(scene.ck, scene);

        this.init();
    }

    init() {
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        window.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('mouseup', (e) => this.onMouseUp(e));
        
        // Handle SVG Drop
        this.canvas.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        
        this.canvas.addEventListener('drop', (e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file && file.name.endsWith('.svg')) {
                this.handleSVGDrop(file);
            }
        });
        
        // Handle zoom and pan on window with capture to ensure priority over browser defaults
        window.addEventListener('wheel', (e) => this.onWheel(e), { passive: false, capture: true });

        // Safari-specific pinch-to-zoom prevention
        window.addEventListener('gesturestart', (e) => e.preventDefault(), { capture: true });
        window.addEventListener('gesturechange', (e) => e.preventDefault(), { capture: true });
        window.addEventListener('gestureend', (e) => e.preventDefault(), { capture: true });
    }

    async handleSVGDrop(file) {
        const text = await file.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'image/svg+xml');
        const paths = doc.querySelectorAll('path');
        
        const group = new GroupObject(this.scene.ck, file.name);
        
        paths.forEach(p => {
            const d = p.getAttribute('d');
            if (d) {
                const ckPath = this.scene.ck.Path.MakeFromSVGString(d);
                if (ckPath) {
                    const obj = new PathObject(this.scene.ck);
                    obj._cachedPath = ckPath;
                    
                    const fill = p.getAttribute('fill');
                    if (fill && fill !== 'none') {
                        if (fill.startsWith('#')) {
                            const r = parseInt(fill.slice(1,3), 16) / 255;
                            const g = parseInt(fill.slice(3,5), 16) / 255;
                            const b = parseInt(fill.slice(5,7), 16) / 255;
                            obj.fill = this.scene.ck.Color(r, g, b, 1.0);
                        }
                    } else if (fill === 'none') {
                        obj.fill = this.scene.ck.Color(0, 0, 0, 0);
                    }
                    
                    group.addObject(obj);
                }
            }
        });
        
        if (group.objects.length > 0) {
            this.scene.addObject(group);
            this.scene.selection = [group];
        }
    }

    getPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = (e.clientX - rect.left);
        const screenY = (e.clientY - rect.top);

        // Transform screen coordinates to world coordinates
        return {
            x: (screenX - this.renderer.pan.x) / this.renderer.zoom,
            y: (screenY - this.renderer.pan.y) / this.renderer.zoom
        };
    }

    onWheel(e) {
        e.preventDefault();

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (e.ctrlKey) {
            // Pinch-to-zoom
            const factor = Math.pow(0.99, e.deltaY);
            const oldZoom = this.renderer.zoom;
            const newZoom = Math.max(0.1, Math.min(20, oldZoom * factor));

            const worldX = (mouseX - this.renderer.pan.x) / oldZoom;
            const worldY = (mouseY - this.renderer.pan.y) / oldZoom;

            this.renderer.zoom = newZoom;
            this.renderer.pan.x = mouseX - worldX * newZoom;
            this.renderer.pan.y = mouseY - worldY * newZoom;
        } else {
            // Pan
            this.renderer.pan.x -= e.deltaX;
            this.renderer.pan.y -= e.deltaY;
        }
    }

    onMouseDown(e) {
        this.isMouseDown = true;
        
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        this.startPos = this.getPos(e);
        this.currentPos = { ...this.startPos };

        if (screenX < this.ui.toolbarWidth) {
            this.handleToolbarClick(screenY);
            return;
        }

        if (this.ui.activeTool === 'rect') {
            // Preview
        } else if (this.ui.activeTool === 'pen') {
            this.handlePenDown(this.startPos);
        } else if (this.ui.activeTool === 'smart-paint') {
            this.handleSmartPaint(this.startPos);
        } else if (this.ui.activeTool === 'selection') {
            this.handleSelection(this.startPos);
        }
    }

    handleToolbarClick(y) {
        const index = Math.floor((y - this.ui.headerHeight - 20) / 44);
        if (index >= 0 && index < this.ui.tools.length) {
            this.ui.activeTool = this.ui.tools[index].id;
            this.currentPath = null;
        }
    }

    handlePenDown(pos) {
        if (!this.currentPath) {
            this.currentPath = new PathObject(this.scene.ck);
            this.scene.addObject(this.currentPath);
        }
        this.currentPath.addPoint(pos.x, pos.y);
        this.isDraggingHandle = true;
    }

    handleSmartPaint(pos) {
        const path = this.smartPaint.findRegion(pos.x, pos.y, window.innerWidth, window.innerHeight);
        if (path) {
            const obj = new PathObject(this.scene.ck);
            this.scene.addObject(obj);
        }
    }

    handleSelection(pos) {
        this.scene.selection = [];
        for (let i = this.scene.objects.length - 1; i >= 0; i--) {
            const obj = this.scene.objects[i];
            const bounds = obj.getBounds(this.scene.ck);
            if (pos.x >= bounds.fLeft && pos.x <= bounds.fRight && 
                pos.y >= bounds.fTop && pos.y <= bounds.fBottom) {
                this.scene.selection = [obj];
                break;
            }
        }
    }

    onMouseMove(e) {
        if (!this.isMouseDown) return;
        this.currentPos = this.getPos(e);

        if (this.ui.activeTool === 'selection' && this.scene.selection.length > 0) {
            const dx = this.currentPos.x - this.startPos.x;
            const dy = this.currentPos.y - this.startPos.y;
            this.scene.selection[0].x += dx;
            this.scene.selection[0].y += dy;
            this.startPos = { ...this.currentPos };
        } else if (this.ui.activeTool === 'pen' && this.isDraggingHandle) {
            const lastPoint = this.currentPath.points[this.currentPath.points.length - 1];
            const dx = this.currentPos.x - lastPoint.x;
            const dy = this.currentPos.y - lastPoint.y;
            lastPoint.cp2 = { x: lastPoint.x + dx, y: lastPoint.y + dy };
            lastPoint.cp1 = { x: lastPoint.x - dx, y: lastPoint.y - dy };
        }
    }

    onMouseUp(e) {
        if (!this.isMouseDown) return;
        this.isMouseDown = false;
        this.isDraggingHandle = false;
        
        const endPos = this.getPos(e);

        if (this.ui.activeTool === 'rect') {
            const x = Math.min(this.startPos.x, endPos.x);
            const y = Math.min(this.startPos.y, endPos.y);
            const w = Math.abs(this.startPos.x - endPos.x);
            const h = Math.abs(this.startPos.y - endPos.y);
            
            if (w > 5 && h > 5) {
                const rect = new RectObject(this.scene.ck, x, y, w, h, 
                    this.scene.ck.Color(100/255, 149/255, 237/255, 1.0),
                    this.scene.ck.Color(0, 0, 0, 1.0)
                );
                this.scene.addObject(rect);
            }
        }
    }
}
