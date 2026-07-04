import type { CanvasKit, Canvas } from 'canvaskit-wasm';
import { Scene, GroupObject, PathObject, RectObject, EllipseObject, PolygonObject, StarObject } from './scene';

export class UIEngine {
    ck: CanvasKit;
    scene: Scene;
    activeTool: string = 'selection';
    
    // DOM Elements
    fillInput: HTMLInputElement;
    strokeInput: HTMLInputElement;
    weightInput: HTMLInputElement;
    opacityInput: HTMLInputElement;
    layerList: HTMLElement;
    zoomText: HTMLElement;

    constructor(ck: CanvasKit, scene: Scene) {
        this.ck = ck;
        this.scene = scene;
        this.scene.ui = this;

        // Initialize DOM refs
        this.fillInput = document.getElementById('fill-color') as HTMLInputElement;
        this.strokeInput = document.getElementById('stroke-color') as HTMLInputElement;
        this.weightInput = document.getElementById('stroke-weight') as HTMLInputElement;
        this.opacityInput = document.getElementById('opacity') as HTMLInputElement;
        this.layerList = document.getElementById('layer-list') as HTMLElement;
        this.zoomText = document.getElementById('zoom-level') as HTMLElement;

        this.initEvents();
    }

    private initEvents() {
        // Toolbar
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.id.startsWith('tool-')) {
                    const toolId = btn.id.replace('tool-', '');
                    this.setActiveTool(toolId);
                }
            });
        });

        // Properties
        this.fillInput.addEventListener('input', () => this.updateSelectedProperties());
        this.strokeInput.addEventListener('input', () => this.updateSelectedProperties());
        this.weightInput.addEventListener('input', () => this.updateSelectedProperties());
        this.opacityInput.addEventListener('input', () => this.updateSelectedProperties());

        // Export
        document.getElementById('export-svg')?.addEventListener('click', () => this.exportSVG());
    }

    setActiveTool(toolId: string) {
        this.activeTool = toolId;
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.classList.toggle('active', btn.id === `tool-${toolId}`);
        });
    }

    updateSelectedProperties() {
        if (this.scene.selection.length === 0) return;

        const fill = this.hexToColor(this.fillInput.value);
        const stroke = this.hexToColor(this.strokeInput.value);
        const weight = parseFloat(this.weightInput.value);
        const opacity = parseFloat(this.opacityInput.value) / 100;

        for (const obj of this.scene.selection) {
            obj.fill = fill;
            obj.stroke = stroke;
            obj.strokeWidth = weight;
            obj.opacity = opacity;
        }
    }

    syncWithSelection() {
        if (this.scene.selection.length === 0) return;
        const obj = this.scene.selection[0];
        
        if (obj.fill) this.fillInput.value = this.colorToHex(obj.fill);
        if (obj.stroke) this.strokeInput.value = this.colorToHex(obj.stroke);
        this.weightInput.value = (obj.strokeWidth !== undefined ? obj.strokeWidth : 1).toString();
        this.opacityInput.value = ((obj.opacity !== undefined ? obj.opacity : 1) * 100).toString();
        
        this.updateLayerList();
    }

    updateLayerList() {
        this.layerList.innerHTML = '';
        this.scene.objects.slice().reverse().forEach(obj => {
            const item = document.createElement('div');
            item.className = 'layer-item';
            if (this.scene.selection.includes(obj)) item.classList.add('selected');
            
            item.innerHTML = `
                <span class="icon">${obj instanceof GroupObject ? '📁' : '⬡'}</span>
                <span>${obj.name}</span>
            `;
            
            item.addEventListener('click', (e) => {
                if (!e.shiftKey) this.scene.selection = [];
                this.scene.selection.push(obj);
                this.syncWithSelection();
            });
            
            this.layerList.appendChild(item);
        });
    }

    setZoom(level: number) {
        this.zoomText.innerText = `${Math.round(level * 100)}%`;
    }

    exportSVG() {
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">`;
        
        for (const obj of this.scene.objects) {
            if (obj._cachedPath) {
                const path = obj._cachedPath;
                const fill = this.colorToHex(obj.fill);
                const stroke = this.colorToHex(obj.stroke);
                const sw = obj.strokeWidth;
                const op = obj.opacity;
                const d = path.toSVGString();
                svg += `\n  <path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" fill-opacity="${op}" stroke-opacity="${op}" transform="translate(${obj.x}, ${obj.y}) rotate(${obj.rotation}) scale(${obj.scaleX}, ${obj.scaleY})" />`;
            } else if (obj instanceof RectObject) {
                const fill = this.colorToHex(obj.fill);
                const stroke = this.colorToHex(obj.stroke);
                svg += `\n  <rect x="${obj.x}" y="${obj.y}" width="${obj.w}" height="${obj.h}" fill="${fill}" stroke="${stroke}" stroke-width="${obj.strokeWidth}" fill-opacity="${obj.opacity}" />`;
            } else if (obj instanceof EllipseObject) {
                const fill = this.colorToHex(obj.fill);
                const stroke = this.colorToHex(obj.stroke);
                svg += `\n  <ellipse cx="${obj.x}" cy="${obj.y}" rx="${obj.rx}" ry="${obj.ry}" fill="${fill}" stroke="${stroke}" stroke-width="${obj.strokeWidth}" fill-opacity="${obj.opacity}" />`;
            } else if (obj instanceof PolygonObject || obj instanceof StarObject) {
                // To export polygons/stars, we just re-render their path and export it
                const fill = this.colorToHex(obj.fill);
                const stroke = this.colorToHex(obj.stroke);
                
                let d = "";
                if (obj instanceof PolygonObject) {
                    const step = (Math.PI * 2) / obj.sides;
                    for (let i = 0; i < obj.sides; i++) {
                        const px = obj.x + obj.radius * Math.cos(i * step - Math.PI / 2);
                        const py = obj.y + obj.radius * Math.sin(i * step - Math.PI / 2);
                        d += (i === 0 ? "M " : "L ") + `${px} ${py} `;
                    }
                    d += "Z";
                } else {
                    const step = Math.PI / obj.points;
                    for (let i = 0; i < obj.points * 2; i++) {
                        const r = (i % 2 === 0) ? obj.outerRadius : obj.innerRadius;
                        const px = obj.x + r * Math.cos(i * step - Math.PI / 2);
                        const py = obj.y + r * Math.sin(i * step - Math.PI / 2);
                        d += (i === 0 ? "M " : "L ") + `${px} ${py} `;
                    }
                    d += "Z";
                }
                svg += `\n  <path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${obj.strokeWidth}" fill-opacity="${obj.opacity}" />`;
            }
        }

        svg += `\n</svg>`;
        
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'export.svg';
        a.click();
        URL.revokeObjectURL(url);
    }

    private hexToColor(hex: string): any {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return this.ck.Color(r, g, b, 1.0);
    }

    private colorToHex(color: any): string {
        const r = Math.round(color[0] * 255).toString(16).padStart(2, '0');
        const g = Math.round(color[1] * 255).toString(16).padStart(2, '0');
        const b = Math.round(color[2] * 255).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
    }

    render(canvas: Canvas, width: number, height: number) {
        // No longer drawing UI on canvas
    }
}
