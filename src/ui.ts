import type { CanvasKit, Canvas } from 'canvaskit-wasm';
import type { WasmScene } from './wasm_scene';
import { FileIO } from './file_io';

export class UIEngine {
    ck: CanvasKit;
    scene: WasmScene;
    activeTool: string = 'selection';
    
    // DOM Elements — basic
    fillInput: HTMLInputElement;
    strokeInput: HTMLInputElement;
    weightInput: HTMLInputElement;
    opacityInput: HTMLInputElement;
    layerList: HTMLElement;
    zoomText: HTMLElement;

    // DOM Elements — extended
    fillEnabled: HTMLInputElement;
    strokeEnabled: HTMLInputElement;
    strokeCap: HTMLSelectElement;
    strokeJoin: HTMLSelectElement;
    strokeDash: HTMLSelectElement;
    blendMode: HTMLSelectElement;
    cornerRadius: HTMLInputElement;
    propX: HTMLInputElement;
    propY: HTMLInputElement;
    propW: HTMLInputElement;
    propH: HTMLInputElement;
    propRotation: HTMLInputElement;

    // DOM Elements — new SVG properties
    fillOpacity: HTMLInputElement;
    fillRule: HTMLSelectElement;
    dashOffset: HTMLInputElement;
    miterLimit: HTMLInputElement;
    toggleVisible: HTMLButtonElement;
    toggleLocked: HTMLButtonElement;

    // Context menu
    contextMenuEl: HTMLElement;
    private _contextMenuCallback: ((action: string) => void) | null = null;
    private _dismissContextMenu: ((e: MouseEvent) => void) | null = null;
    private _dismissContextMenuKey: ((e: KeyboardEvent) => void) | null = null;

    constructor(ck: CanvasKit, scene: WasmScene) {
        this.ck = ck;
        this.scene = scene;

        // Initialize DOM refs — basic
        this.fillInput = document.getElementById('fill-color') as HTMLInputElement;
        this.strokeInput = document.getElementById('stroke-color') as HTMLInputElement;
        this.weightInput = document.getElementById('stroke-weight') as HTMLInputElement;
        this.opacityInput = document.getElementById('opacity') as HTMLInputElement;
        this.layerList = document.getElementById('layer-list') as HTMLElement;
        this.zoomText = document.getElementById('zoom-level') as HTMLElement;

        // Initialize DOM refs — extended
        this.fillEnabled = document.getElementById('fill-enabled') as HTMLInputElement;
        this.strokeEnabled = document.getElementById('stroke-enabled') as HTMLInputElement;
        this.strokeCap = document.getElementById('stroke-cap') as HTMLSelectElement;
        this.strokeJoin = document.getElementById('stroke-join') as HTMLSelectElement;
        this.strokeDash = document.getElementById('stroke-dash') as HTMLSelectElement;
        this.blendMode = document.getElementById('blend-mode') as HTMLSelectElement;
        this.cornerRadius = document.getElementById('prop-corner-radius') as HTMLInputElement;
        this.propX = document.getElementById('prop-x') as HTMLInputElement;
        this.propY = document.getElementById('prop-y') as HTMLInputElement;
        this.propW = document.getElementById('prop-w') as HTMLInputElement;
        this.propH = document.getElementById('prop-h') as HTMLInputElement;
        this.propRotation = document.getElementById('prop-rotation') as HTMLInputElement;

        // Initialize DOM refs — new SVG properties
        this.fillOpacity = document.getElementById('fill-opacity') as HTMLInputElement;
        this.fillRule = document.getElementById('fill-rule') as HTMLSelectElement;
        this.dashOffset = document.getElementById('stroke-dash-offset') as HTMLInputElement;
        this.miterLimit = document.getElementById('stroke-miter-limit') as HTMLInputElement;
        this.toggleVisible = document.getElementById('toggle-visible') as HTMLButtonElement;
        this.toggleLocked = document.getElementById('toggle-locked') as HTMLButtonElement;

        // Context menu
        this.contextMenuEl = document.getElementById('context-menu') as HTMLElement;

        this.initEvents();
        this.initCollapsibleSections();
    }

    private initCollapsibleSections() {
        document.querySelectorAll('.panel-section-header').forEach(header => {
            header.addEventListener('click', () => {
                const sectionName = (header as HTMLElement).dataset.section;
                if (!sectionName) return;
                const body = document.querySelector(`[data-section-body="${sectionName}"]`);
                const chevron = header.querySelector('.chevron');
                if (!body || !chevron) return;

                body.classList.toggle('collapsed');
                chevron.classList.toggle('collapsed');
            });
        });
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

        // Style properties — all trigger updateSelectedProperties
        const styleInputs = [
            this.fillInput, this.strokeInput, this.weightInput, this.opacityInput,
            this.fillEnabled, this.strokeEnabled, this.strokeCap, this.strokeJoin,
            this.strokeDash, this.blendMode, this.cornerRadius,
            this.fillOpacity, this.fillRule, this.dashOffset, this.miterLimit,
        ];
        for (const el of styleInputs) {
            if (el) el.addEventListener('input', () => this.updateSelectedProperties());
            if (el) el.addEventListener('change', () => this.updateSelectedProperties());
        }

        // Transform properties
        const transformInputs = [this.propX, this.propY, this.propW, this.propH, this.propRotation];
        for (const el of transformInputs) {
            if (el) el.addEventListener('change', () => this.updateTransform());
        }

        // Visibility toggle
        this.toggleVisible?.addEventListener('click', () => {
            this.toggleNodeVisibility();
        });

        // Locked toggle
        this.toggleLocked?.addEventListener('click', () => {
            this.toggleNodeLocked();
        });

        // Export
        document.getElementById('export-svg')?.addEventListener('click', () => this.exportSVG());

        // Import SVG
        document.getElementById('import-svg')?.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.svg,image/svg+xml';
            input.onchange = () => {
                const file = input.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => this.parseSVG(reader.result as string);
                reader.readAsText(file);
            };
            input.click();
        });
    }

    setActiveTool(toolId: string) {
        this.activeTool = toolId;
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.classList.toggle('active', btn.id === `tool-${toolId}`);
        });

        // Set cursor on canvas based on tool
        const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement;
        if (canvas) {
            const cursorMap: Record<string, string> = {
                'selection': 'default',
                'direct': 'default',
                'pen': 'crosshair',
                'rect': 'crosshair',
                'ellipse': 'crosshair',
                'polygon': 'crosshair',
                'star': 'crosshair',
                'text': 'text',
                
                'paint-bucket': 'crosshair',
            };
            canvas.style.cursor = cursorMap[toolId] || 'default';
        }
    }

    /** Get the current fill color from the UI as {r, g, b, a} in 0-1 range. */
    getActiveFillColor(): { r: number; g: number; b: number; a: number } {
        const hex = this.fillInput?.value || '#4285F4';
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return { r, g, b, a: 1.0 };
    }

    private toggleNodeVisibility() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;

        const sceneData = this.scene.getSceneData();
        const node = sceneData.nodes[selection[0]];
        if (!node) return;

        const newVisible = !node.visible;
        for (const id of selection) {
            this.scene.setNodeVisible(id, newVisible);
        }

        // Update button visual
        this.toggleVisible.classList.toggle('active', newVisible);
    }

    private toggleNodeLocked() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;

        const sceneData = this.scene.getSceneData();
        const node = sceneData.nodes[selection[0]];
        if (!node) return;

        const newLocked = !node.locked;
        for (const id of selection) {
            this.scene.setNodeLocked(id, newLocked);
        }

        this.toggleLocked.classList.toggle('active', newLocked);
    }

    updateSelectedProperties() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;

        const fillOn = this.fillEnabled ? this.fillEnabled.checked : true;
        const strokeOn = this.strokeEnabled ? this.strokeEnabled.checked : true;

        const fill = fillOn ? this.hexToRgb(this.fillInput.value) : null;
        const stroke = strokeOn ? this.hexToRgb(this.strokeInput.value) : null;
        const strokeWidth = parseFloat(this.weightInput.value) || 1;
        const opacity = (parseFloat(this.opacityInput.value) || 100) / 100;
        const strokeCap = this.strokeCap ? parseInt(this.strokeCap.value) || 0 : 0;
        const strokeJoin = this.strokeJoin ? parseInt(this.strokeJoin.value) || 0 : 0;
        const blendMode = this.blendMode ? parseInt(this.blendMode.value) || 0 : 0;
        const cornerRadius = this.cornerRadius ? parseFloat(this.cornerRadius.value) || 0 : 0;

        // New SVG properties
        const fillOpacity = this.fillOpacity ? (parseFloat(this.fillOpacity.value) || 100) / 100 : 1;
        const fillRule = this.fillRule ? parseInt(this.fillRule.value) || 0 : 0;
        const dashOffset = this.dashOffset ? parseFloat(this.dashOffset.value) || 0 : 0;
        const miterLimit = this.miterLimit ? parseFloat(this.miterLimit.value) || 4 : 4;

        // Parse dash pattern
        let dashArray: number[] = [];
        if (this.strokeDash && this.strokeDash.value) {
            dashArray = this.strokeDash.value.split(',').map(Number).filter(n => !isNaN(n));
        }

        const style = {
            fill,
            stroke,
            stroke_width: strokeWidth,
            opacity,
            stroke_cap: strokeCap,
            stroke_join: strokeJoin,
            dash_array: dashArray,
            dash_offset: dashOffset,
            corner_radius: cornerRadius,
            blend_mode: blendMode,
            fill_rule: fillRule,
            miter_limit: miterLimit,
            fill_opacity: fillOpacity,
        };

        const styleJson = JSON.stringify(style);
        for (const id of selection) {
            this.scene.setNodeStyle(id, styleJson);
        }
    }

    updateTransform() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;

        const id = selection[0];
        const sceneData = this.scene.getSceneData();
        const node = sceneData.nodes[id];
        if (!node) return;

        this.scene.saveMoveHistory();

        // Position
        const currentT = this.scene.getTransform(id);
        const newX = parseFloat(this.propX?.value) || 0;
        const newY = parseFloat(this.propY?.value) || 0;
        if (Math.abs(newX - currentT[2]) > 0.01 || Math.abs(newY - currentT[5]) > 0.01) {
            this.scene.setNodePosition(id, newX, newY);
        }

        // Size (W/H)
        const newW = parseFloat(this.propW?.value) || 0;
        const newH = parseFloat(this.propH?.value) || 0;
        if (newW > 0 && newH > 0) {
            this.scene.resizeNode(id, newW, newH);
        }

        // Rotation
        if (this.propRotation) {
            const newAngleDeg = parseFloat(this.propRotation.value) || 0;
            const newAngleRad = newAngleDeg * (Math.PI / 180);
            this.scene.rotateNode(id, newAngleRad);
        }

        this.scene.invalidateCache();
        this.ui_syncSelection();
    }

    /** Internal sync helper to avoid recursion. */
    private ui_syncSelection() {
        // Lightweight sync that doesn't trigger updateTransform again
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;
        const sceneData = this.scene.getSceneData();
        const node = sceneData.nodes[selection[0]];
        if (!node) return;
        this.updateLayerList();
    }

    syncWithSelection() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;
        
        const sceneData = this.scene.getSceneData();
        const node = sceneData.nodes[selection[0]];
        if (!node) return;
        const style = node.style;

        // Fill
        if (style.fill) {
            this.fillInput.value = this.rgbToHex(style.fill);
            if (this.fillEnabled) this.fillEnabled.checked = true;
        } else {
            if (this.fillEnabled) this.fillEnabled.checked = false;
        }

        // Stroke
        if (style.stroke) {
            this.strokeInput.value = this.rgbToHex(style.stroke);
            if (this.strokeEnabled) this.strokeEnabled.checked = true;
        } else {
            if (this.strokeEnabled) this.strokeEnabled.checked = false;
        }

        // Weight, opacity
        this.weightInput.value = (style.stroke_width !== undefined ? style.stroke_width : 1).toString();
        this.opacityInput.value = ((style.opacity !== undefined ? style.opacity : 1) * 100).toFixed(0);

        // Stroke cap, join
        if (this.strokeCap) this.strokeCap.value = (style.stroke_cap || 0).toString();
        if (this.strokeJoin) this.strokeJoin.value = (style.stroke_join || 0).toString();

        // Dash
        if (this.strokeDash) {
            const dashStr = (style.dash_array || []).join(',');
            // Try to match a preset
            const options = Array.from(this.strokeDash.options);
            const match = options.find(o => o.value === dashStr);
            this.strokeDash.value = match ? dashStr : '';
        }

        // Blend mode
        if (this.blendMode) this.blendMode.value = (style.blend_mode || 0).toString();

        // Corner radius
        if (this.cornerRadius) this.cornerRadius.value = (style.corner_radius || 0).toString();

        // New SVG properties
        if (this.fillOpacity) this.fillOpacity.value = ((style.fill_opacity !== undefined ? style.fill_opacity : 1) * 100).toFixed(0);
        if (this.fillRule) this.fillRule.value = (style.fill_rule || 0).toString();
        if (this.dashOffset) this.dashOffset.value = (style.dash_offset || 0).toString();
        if (this.miterLimit) this.miterLimit.value = (style.miter_limit !== undefined ? style.miter_limit : 4).toString();

        // Visibility / Locked
        if (this.toggleVisible) this.toggleVisible.classList.toggle('active', node.visible !== false);
        if (this.toggleLocked) this.toggleLocked.classList.toggle('active', node.locked === true);

        // Transform — read position and size
        const t = this.scene.getTransform(selection[0]);
        if (this.propX) this.propX.value = Math.round(t[2]).toString();
        if (this.propY) this.propY.value = Math.round(t[5]).toString();

        // Width/Height from geometry
        if (node.geometry.Rect) {
            if (this.propW) this.propW.value = Math.round(node.geometry.Rect.width).toString();
            if (this.propH) this.propH.value = Math.round(node.geometry.Rect.height).toString();
        } else if (node.geometry.Ellipse) {
            if (this.propW) this.propW.value = Math.round(node.geometry.Ellipse.radius_x * 2).toString();
            if (this.propH) this.propH.value = Math.round(node.geometry.Ellipse.radius_y * 2).toString();
        } else if (node.geometry.Path) {
            const pts = node.geometry.Path.points;
            if (pts && pts.length > 0) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const p of pts) {
                    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
                    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
                }
                if (this.propW) this.propW.value = Math.round(maxX - minX).toString();
                if (this.propH) this.propH.value = Math.round(maxY - minY).toString();
            }
        }

        // Rotation from transform matrix
        if (this.propRotation) {
            const angle = Math.atan2(t[3], t[0]) * (180 / Math.PI);
            this.propRotation.value = Math.round(angle).toString();
        }

        this.updateLayerList();
    }

    updateLayerList() {
        this.layerList.innerHTML = '';
        const sceneData = this.scene.getSceneData();
        const nodes = sceneData.nodes;
        const selection = this.scene.engine!.get_selection();

        // Iterate through root nodes in reverse order for layer list (top-to-bottom)
        sceneData.root_nodes.slice().reverse().forEach((id: number) => {
            const node = nodes[id];
            if (!node) return;
            const item = document.createElement('div');
            item.className = 'layer-item';
            if (selection.includes(id)) item.classList.add('selected');
            
            item.innerHTML = `
                <span class="icon">${node.node_type === 'Group' ? '📁' : node.geometry?.Rect ? '⬜' : node.geometry?.Ellipse ? '⭕' : node.geometry?.Path ? '✏️' : '⬡'}</span>
                <span>${node.name || `Node ${id}`}</span>
            `;
            
            item.addEventListener('click', (e) => {
                this.scene.selectNode(id, e.shiftKey);
                this.syncWithSelection();
            });
            
            this.layerList.appendChild(item);
        });
    }

    setZoom(level: number) {
        this.zoomText.innerText = `${Math.round(level * 100)}%`;
    }

    exportSVG() {
        const sceneData = this.scene.getSceneData();
        const nodes = sceneData.nodes;
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">`;
        
        for (const idStr of Object.keys(nodes)) {
            const id = Number(idStr);
            const node = nodes[id];
            if (!node) continue;
            
            const t = this.scene.getTransform(id);
            const mat = `matrix(${t[0]},${t[3]},${t[1]},${t[4]},${t[2]},${t[5]})`;
            const fill = node.style.fill ? this.rgbToHex(node.style.fill) : 'none';
            const stroke = node.style.stroke ? this.rgbToHex(node.style.stroke) : 'none';
            const sw = node.style.stroke_width;
            const op = node.style.opacity;

            // Common SVG attributes
            const capMap = ['butt', 'round', 'square'];
            const joinMap = ['miter', 'round', 'bevel'];
            let attrs = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"`;
            attrs += ` stroke-linecap="${capMap[node.style.stroke_cap || 0]}"`;
            attrs += ` stroke-linejoin="${joinMap[node.style.stroke_join || 0]}"`;

            // Dash array and offset
            if (node.style.dash_array && node.style.dash_array.length > 0) {
                attrs += ` stroke-dasharray="${node.style.dash_array.join(',')}"`;
                if (node.style.dash_offset) attrs += ` stroke-dashoffset="${node.style.dash_offset}"`;
            }

            // Miter limit
            if (node.style.miter_limit !== undefined && node.style.miter_limit !== 4) {
                attrs += ` stroke-miterlimit="${node.style.miter_limit}"`;
            }

            // Fill opacity
            if (node.style.fill_opacity !== undefined && node.style.fill_opacity !== 1) {
                attrs += ` fill-opacity="${node.style.fill_opacity}"`;
            }

            // Fill rule
            const fillRuleMap = ['nonzero', 'evenodd'];
            if (node.style.fill_rule && node.style.fill_rule > 0) {
                attrs += ` fill-rule="${fillRuleMap[node.style.fill_rule]}"`;
            }

            // Visibility
            if (node.visible === false) {
                attrs += ` visibility="hidden"`;
            }

            attrs += ` transform="${mat}"`;

            if (node.geometry.Rect) {
                const { width, height } = node.geometry.Rect;
                const rx = node.style.corner_radius || 0;
                svg += `\n  <rect width="${width}" height="${height}" ${rx > 0 ? `rx="${rx}" ry="${rx}" ` : ''}${attrs} />`;
            } else if (node.geometry.Ellipse) {
                const { radius_x, radius_y } = node.geometry.Ellipse;
                svg += `\n  <ellipse rx="${radius_x}" ry="${radius_y}" ${attrs} />`;
            } else if (node.geometry.Path) {
                const points = node.geometry.Path.points;
                if (points && points.length >= 2) {
                    let d = `M ${points[0].x} ${points[0].y}`;
                    for (let i = 1; i < points.length; i++) {
                        const prev = points[i - 1];
                        const p = points[i];
                        d += ` C ${prev.cp2[0]} ${prev.cp2[1]} ${p.cp1[0]} ${p.cp1[1]} ${p.x} ${p.y}`;
                    }
                    // Close path if last point == first point
                    const last = points[points.length - 1];
                    const first = points[0];
                    if (Math.abs(last.x - first.x) < 0.01 && Math.abs(last.y - first.y) < 0.01) {
                        d += ' Z';
                    }
                    svg += `\n  <path d="${d}" ${attrs} />`;
                }
            }
        }

        svg += `\n</svg>`;

        // Embed protobuf payload for lossless re-importing
        if (this.scene.engine) {
            svg = FileIO.embedPayloadInSVG(this.scene.engine, svg);
        }
        
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'export.svg';
        a.click();
        URL.revokeObjectURL(url);
    }

    private hexToRgb(hex: string): { r: number; g: number; b: number; a: number } {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return { r, g, b, a: 1.0 };
    }

    private rgbToHex(color: { r: number; g: number; b: number }): string {
        const r = Math.round((color.r || 0) * 255).toString(16).padStart(2, '0');
        const g = Math.round((color.g || 0) * 255).toString(16).padStart(2, '0');
        const b = Math.round((color.b || 0) * 255).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
    }

    render(_canvas: Canvas, _width: number, _height: number) {
        // No longer drawing UI on canvas
    }

    parseSVG(svgText: string) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, 'image/svg+xml');
        const svg = doc.querySelector('svg');
        if (!svg) return;

        this.scene.saveMoveHistory();

        const parseFill = (el: Element): string | null => {
            const fill = el.getAttribute('fill');
            if (fill === 'none') return null;
            return fill || '#808080';
        };

        const parseStroke = (el: Element): string | null => {
            const stroke = el.getAttribute('stroke');
            if (stroke === 'none' || !stroke) return null;
            return stroke;
        };

        const applyStyle = (id: number, el: Element) => {
            const fillHex = parseFill(el);
            const strokeHex = parseStroke(el);
            const sw = parseFloat(el.getAttribute('stroke-width') || '1');
            const op = parseFloat(el.getAttribute('opacity') || '1');

            const fill = fillHex ? this.hexToRgb(fillHex) : null;
            const stroke = strokeHex ? this.hexToRgb(strokeHex) : null;

            // Parse stroke-linecap
            const capStr = el.getAttribute('stroke-linecap') || 'butt';
            const capMap: Record<string, number> = { butt: 0, round: 1, square: 2 };
            const strokeCap = capMap[capStr] ?? 0;

            // Parse stroke-linejoin
            const joinStr = el.getAttribute('stroke-linejoin') || 'miter';
            const joinMap: Record<string, number> = { miter: 0, round: 1, bevel: 2 };
            const strokeJoin = joinMap[joinStr] ?? 0;

            // Parse fill-rule
            const fillRuleStr = el.getAttribute('fill-rule') || 'nonzero';
            const fillRuleMap: Record<string, number> = { nonzero: 0, evenodd: 1 };
            const fillRule = fillRuleMap[fillRuleStr] ?? 0;

            // Parse miter limit
            const miterLimit = parseFloat(el.getAttribute('stroke-miterlimit') || '4');

            // Parse fill-opacity
            const fillOpacity = parseFloat(el.getAttribute('fill-opacity') || '1');

            const style = {
                fill, stroke,
                stroke_width: sw,
                opacity: op,
                stroke_cap: strokeCap,
                stroke_join: strokeJoin,
                dash_array: [] as number[],
                dash_offset: 0,
                corner_radius: 0,
                blend_mode: 0,
                fill_rule: fillRule,
                miter_limit: miterLimit,
                fill_opacity: fillOpacity,
            };

            // Parse stroke-dasharray
            const dashArr = el.getAttribute('stroke-dasharray');
            if (dashArr && dashArr !== 'none') {
                style.dash_array = dashArr.split(/[,\s]+/).map(Number).filter(n => !isNaN(n));
            }

            // Parse stroke-dashoffset
            const dashOff = el.getAttribute('stroke-dashoffset');
            if (dashOff) {
                style.dash_offset = parseFloat(dashOff);
            }

            // Parse rx for corner radius
            const rx = el.getAttribute('rx');
            if (rx) style.corner_radius = parseFloat(rx);

            this.scene.setNodeStyle(id, JSON.stringify(style));

            // Handle visibility
            const visibility = el.getAttribute('visibility');
            if (visibility === 'hidden') {
                this.scene.setNodeVisible(id, false);
            }
        };

        const elements = svg.querySelectorAll('rect, ellipse, circle, path, text, line, polygon, polyline');
        for (const el of elements) {
            const tag = el.tagName.toLowerCase();

            // Parse transform for position
            let tx = 0, ty = 0;
            const transformAttr = el.getAttribute('transform');
            if (transformAttr) {
                const translateMatch = transformAttr.match(/translate\(([^,)]+)[,\s]*([^)]*)\)/);
                if (translateMatch) {
                    tx = parseFloat(translateMatch[1]) || 0;
                    ty = parseFloat(translateMatch[2]) || 0;
                }
                const matrixMatch = transformAttr.match(/matrix\(([^)]+)\)/);
                if (matrixMatch) {
                    const vals = matrixMatch[1].split(/[,\s]+/).map(Number);
                    if (vals.length >= 6) {
                        tx = vals[4]; ty = vals[5];
                    }
                }
            }

            if (tag === 'rect') {
                const x = (parseFloat(el.getAttribute('x') || '0')) + tx;
                const y = (parseFloat(el.getAttribute('y') || '0')) + ty;
                const w = parseFloat(el.getAttribute('width') || '100');
                const h = parseFloat(el.getAttribute('height') || '100');
                const id = this.scene.addRect(x, y, w, h);
                applyStyle(id, el);
            } else if (tag === 'ellipse') {
                const cx = (parseFloat(el.getAttribute('cx') || '0')) + tx;
                const cy = (parseFloat(el.getAttribute('cy') || '0')) + ty;
                const rx = parseFloat(el.getAttribute('rx') || '50');
                const ry = parseFloat(el.getAttribute('ry') || '50');
                const id = this.scene.addEllipse(cx, cy, rx, ry);
                applyStyle(id, el);
            } else if (tag === 'circle') {
                const cx = (parseFloat(el.getAttribute('cx') || '0')) + tx;
                const cy = (parseFloat(el.getAttribute('cy') || '0')) + ty;
                const r = parseFloat(el.getAttribute('r') || '50');
                const id = this.scene.addEllipse(cx, cy, r, r);
                applyStyle(id, el);
            } else if (tag === 'text') {
                const x = (parseFloat(el.getAttribute('x') || '0')) + tx;
                const y = (parseFloat(el.getAttribute('y') || '0')) + ty;
                const content = el.textContent || 'Text';
                const fontSize = parseFloat(el.getAttribute('font-size') || '24');
                const id = this.scene.addText(x, y, content, fontSize);
                applyStyle(id, el);
            } else if (tag === 'line') {
                const x1 = (parseFloat(el.getAttribute('x1') || '0')) + tx;
                const y1 = (parseFloat(el.getAttribute('y1') || '0')) + ty;
                const x2 = (parseFloat(el.getAttribute('x2') || '100')) + tx;
                const y2 = (parseFloat(el.getAttribute('y2') || '100')) + ty;
                const points = [
                    { x: x1, y: y1, cp1: [x1, y1], cp2: [x1, y1] },
                    { x: x2, y: y2, cp1: [x2, y2], cp2: [x2, y2] },
                ];
                const id = this.scene.addPath(JSON.stringify(points));
                applyStyle(id, el);
            } else if (tag === 'polygon' || tag === 'polyline') {
                const pointsStr = el.getAttribute('points') || '';
                const coords = pointsStr.trim().split(/[\s,]+/).map(Number);
                const pts = [];
                for (let i = 0; i < coords.length - 1; i += 2) {
                    const px = coords[i] + tx;
                    const py = coords[i + 1] + ty;
                    pts.push({ x: px, y: py, cp1: [px, py], cp2: [px, py] });
                }
                if (tag === 'polygon' && pts.length > 0) {
                    pts.push({ ...pts[0] }); // close the polygon
                }
                if (pts.length >= 2) {
                    const id = this.scene.addPath(JSON.stringify(pts));
                    applyStyle(id, el);
                }
            } else if (tag === 'path') {
                // Basic SVG path parsing (M, L, C commands)
                const d = el.getAttribute('d') || '';
                const pts = this.parseSVGPathD(d, tx, ty);
                if (pts.length >= 2) {
                    const id = this.scene.addPath(JSON.stringify(pts));
                    applyStyle(id, el);
                }
            }
        }

        this.scene.invalidateCache();
        this.updateLayerList();
    }

    private parseSVGPathD(d: string, tx: number, ty: number): Array<{x: number; y: number; cp1: number[]; cp2: number[]}> {
        const pts: Array<{x: number; y: number; cp1: number[]; cp2: number[]}> = [];
        // Tokenize: split on command letters, keeping the letter
        const segments = d.match(/[MmLlCcSsQqTtHhVvZz][^MmLlCcSsQqTtHhVvZz]*/g) || [];
        let cx = 0, cy = 0;

        for (const seg of segments) {
            const cmd = seg[0];
            const nums = seg.slice(1).trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));

            switch (cmd) {
                case 'M':
                    cx = nums[0] + tx; cy = nums[1] + ty;
                    pts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                    break;
                case 'm':
                    cx += nums[0]; cy += nums[1];
                    pts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                    break;
                case 'L':
                    for (let i = 0; i < nums.length - 1; i += 2) {
                        cx = nums[i] + tx; cy = nums[i+1] + ty;
                        pts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                    }
                    break;
                case 'l':
                    for (let i = 0; i < nums.length - 1; i += 2) {
                        cx += nums[i]; cy += nums[i+1];
                        pts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                    }
                    break;
                case 'C':
                    for (let i = 0; i < nums.length - 5; i += 6) {
                        const cp2x = nums[i] + tx, cp2y = nums[i+1] + ty;
                        const cp1x = nums[i+2] + tx, cp1y = nums[i+3] + ty;
                        cx = nums[i+4] + tx; cy = nums[i+5] + ty;
                        // Set previous point's cp2
                        if (pts.length > 0) {
                            pts[pts.length - 1].cp2 = [cp2x, cp2y];
                        }
                        pts.push({ x: cx, y: cy, cp1: [cp1x, cp1y], cp2: [cx, cy] });
                    }
                    break;
                case 'H':
                    cx = nums[0] + tx;
                    pts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                    break;
                case 'h':
                    cx += nums[0];
                    pts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                    break;
                case 'V':
                    cy = nums[0] + ty;
                    pts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                    break;
                case 'v':
                    cy += nums[0];
                    pts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                    break;
                case 'Z': case 'z':
                    if (pts.length > 0) {
                        pts.push({ x: pts[0].x, y: pts[0].y, cp1: [pts[0].x, pts[0].y], cp2: [pts[0].x, pts[0].y] });
                    }
                    break;
            }
        }
        return pts;
    }

    showContextMenu(x: number, y: number, callback: (action: string) => void) {
        this._contextMenuCallback = callback;
        const items: Array<{ label: string; action: string; shortcut: string } | 'separator'> = [
            { label: 'Bring to Front', action: 'bring-to-front', shortcut: '⌘]' },
            { label: 'Bring Forward', action: 'bring-forward', shortcut: ']' },
            { label: 'Send Backward', action: 'send-backward', shortcut: '[' },
            { label: 'Send to Back', action: 'send-to-back', shortcut: '⌘[' },
            'separator',
            { label: 'Duplicate', action: 'duplicate', shortcut: '⌘D' },
            { label: 'Delete', action: 'delete', shortcut: '⌫' },
        ];

        this.contextMenuEl.innerHTML = '';
        for (const item of items) {
            if (item === 'separator') {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                this.contextMenuEl.appendChild(sep);
            } else {
                const row = document.createElement('div');
                row.className = 'context-menu-item';
                row.innerHTML = `<span>${item.label}</span><span class="context-menu-shortcut">${item.shortcut}</span>`;
                row.addEventListener('click', () => {
                    this._contextMenuCallback?.(item.action);
                });
                this.contextMenuEl.appendChild(row);
            }
        }

        // Position: keep within viewport
        this.contextMenuEl.style.display = 'block';
        this.contextMenuEl.style.left = `${x}px`;
        this.contextMenuEl.style.top = `${y}px`;

        // Adjust if overflowing viewport
        requestAnimationFrame(() => {
            const rect = this.contextMenuEl.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                this.contextMenuEl.style.left = `${x - rect.width}px`;
            }
            if (rect.bottom > window.innerHeight) {
                this.contextMenuEl.style.top = `${y - rect.height}px`;
            }
        });

        // Dismiss on click-outside
        this._dismissContextMenu = (e: MouseEvent) => {
            if (!this.contextMenuEl.contains(e.target as Node)) {
                this.hideContextMenu();
            }
        };
        this._dismissContextMenuKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') this.hideContextMenu();
        };
        setTimeout(() => {
            window.addEventListener('mousedown', this._dismissContextMenu!);
            window.addEventListener('keydown', this._dismissContextMenuKey!);
        }, 0);
    }

    hideContextMenu() {
        this.contextMenuEl.style.display = 'none';
        this.contextMenuEl.innerHTML = '';
        this._contextMenuCallback = null;
        if (this._dismissContextMenu) {
            window.removeEventListener('mousedown', this._dismissContextMenu);
            this._dismissContextMenu = null;
        }
        if (this._dismissContextMenuKey) {
            window.removeEventListener('keydown', this._dismissContextMenuKey);
            this._dismissContextMenuKey = null;
        }
    }
}
