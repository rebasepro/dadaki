import type { CanvasKit } from 'canvaskit-wasm';
import type { WasmScene } from './wasm_scene';
import { FileIO } from './file_io';
import type { Color } from './types';
import { hexToRgb, rgbToHex, parseSVGPathD as parseSVGPathDUtil, matrixToSVGTransform, escapeXml, parseSVGTransform, composeMatrices, transformPoint, identityMatrix, resolveGradientColor } from './svg_utils';
import type { SVGSubpath } from './svg_utils';
import type { ContextBar } from './context_bar';
import { iconFolder, iconSquare, iconCircle, iconPenTool, iconType, iconHexagon, iconEye, iconEyeOff, iconLock } from './icons';

export class UIEngine {
    ck: CanvasKit;
    scene: WasmScene;
    activeTool: string = 'selection';
    contextBar: ContextBar | null = null;

    /** Tracks whether we've already taken a history snapshot for the current
     *  property-editing gesture (e.g. a color picker drag). */
    private _propertyEditSnapshotTaken: boolean = false;
    /** Last style the user configured — applied to newly created shapes. */
    private _currentStyleJson: string | null = null;

    // Static lookup tables (avoid re-creation each call)
    private static readonly ICON_MAP: Record<string, () => string> = {
        'Group': () => iconFolder(14),
        'Rect': () => iconSquare(14),
        'Ellipse': () => iconCircle(14),
        'Path': () => iconPenTool(14),
        'Text': () => iconType(14),
    };
    private static readonly CAP_MAP = ['butt', 'round', 'square'] as const;
    private static readonly JOIN_MAP = ['miter', 'round', 'bevel'] as const;
    private static readonly FILL_RULE_MAP = ['nonzero', 'evenodd'] as const;
    
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

    // Layer tree state
    private _collapsedGroups: Set<number> = new Set();

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

        // Seed the current style from the panel's initial (HTML default) values
        this._currentStyleJson = this.buildCurrentStyleJson();
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

        // Style properties — coalesced undo: one snapshot per gesture
        const styleInputs = [
            this.fillInput, this.strokeInput, this.weightInput, this.opacityInput,
            this.fillEnabled, this.strokeEnabled, this.strokeCap, this.strokeJoin,
            this.strokeDash, this.blendMode, this.cornerRadius,
            this.fillOpacity, this.fillRule, this.dashOffset, this.miterLimit,
        ];
        for (const el of styleInputs) {
            if (el) {
                // Take a single history snapshot on the first 'input' of a gesture,
                // then apply live updates without pushing more history.
                el.addEventListener('input', () => {
                    if (!this._propertyEditSnapshotTaken) {
                        this.scene.saveMoveHistory();
                        this._propertyEditSnapshotTaken = true;
                    }
                    this._currentStyleJson = this.buildCurrentStyleJson();
                    this.updateSelectedPropertiesNoHistory();
                });
                // 'change' fires at the end of a gesture (mouse-up on slider, blur, etc.).
                // If no 'input' preceded it (e.g. dropdown change), take the snapshot here.
                el.addEventListener('change', () => {
                    if (!this._propertyEditSnapshotTaken) {
                        this.scene.saveMoveHistory();
                    }
                    this._propertyEditSnapshotTaken = false;
                    this._currentStyleJson = this.buildCurrentStyleJson();
                    this.updateSelectedPropertiesNoHistory();
                    this.scene.autosave?.trigger();
                });
            }
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

        this.contextBar?.refresh();
    }

    /** Get the current fill color from the UI as {r, g, b, a} in 0-1 range. */
    getActiveFillColor(): Color {
        const hex = this.fillInput?.value || '#4285F4';
        return this.hexToRgb(hex);
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

        const styleJson = this.buildCurrentStyleJson();
        for (const id of selection) {
            this.scene.setNodeStyle(id, styleJson);
        }
    }

    /** Apply style changes to selected nodes WITHOUT pushing undo history.
     *  Used for live preview during drag-editing (color picker, sliders). */
    updateSelectedPropertiesNoHistory() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;

        const styleJson = this.buildCurrentStyleJson();
        for (const id of selection) {
            this.scene.setNodeStyleNoHistory(id, styleJson);
        }
    }

    /** Build a style JSON string from the current UI panel values. */
    private buildCurrentStyleJson(): string {
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

        const fillOpacity = this.fillOpacity ? (parseFloat(this.fillOpacity.value) || 100) / 100 : 1;
        const fillRule = this.fillRule ? parseInt(this.fillRule.value) || 0 : 0;
        const dashOffset = this.dashOffset ? parseFloat(this.dashOffset.value) || 0 : 0;
        const miterLimit = this.miterLimit ? parseFloat(this.miterLimit.value) || 4 : 4;

        let dashArray: number[] = [];
        if (this.strokeDash && this.strokeDash.value) {
            dashArray = this.strokeDash.value.split(',').map(Number).filter(n => !isNaN(n));
        }

        return JSON.stringify({
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
        });
    }

    /** Get the current ("last used") style as a JSON string.
     *  Applied to newly created shapes. Persists across deselection —
     *  it is NOT derived from the panel widgets at call time, because those
     *  get repopulated from whatever is selected. */
    getCurrentStyle(): string {
        return this._currentStyleJson ?? this.buildCurrentStyleJson();
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
        if (selection.length === 0) {
            this.clearPropertyPanel();
            this.updateLayerList();
            this.contextBar?.refresh();
            return;
        }
        
        const sceneData = this.scene.getSceneData();
        const node = sceneData.nodes[selection[0]];
        if (!node) {
            this.clearPropertyPanel();
            this.updateLayerList();
            this.contextBar?.refresh();
            return;
        }
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
            const subpaths = node.geometry.Path.subpaths;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            let hasPoints = false;
            for (const sp of subpaths) {
                for (const p of sp.points) {
                    hasPoints = true;
                    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
                    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
                }
            }
            if (hasPoints) {
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
        this.contextBar?.refresh();
    }

    /** When nothing is selected, show the CURRENT style (what a newly drawn
     *  shape will get) in the style controls and blank the transform fields. */
    private clearPropertyPanel() {
        // Restore style widgets from the persistent current style
        try {
            const s = JSON.parse(this.getCurrentStyle());
            if (this.fillEnabled) this.fillEnabled.checked = s.fill !== null;
            if (s.fill) this.fillInput.value = this.rgbToHex(s.fill);
            if (this.strokeEnabled) this.strokeEnabled.checked = s.stroke !== null;
            if (s.stroke) this.strokeInput.value = this.rgbToHex(s.stroke);
            this.weightInput.value = String(s.stroke_width ?? 2);
            this.opacityInput.value = String(Math.round((s.opacity ?? 1) * 100));
            if (this.strokeCap) this.strokeCap.value = String(s.stroke_cap ?? 0);
            if (this.strokeJoin) this.strokeJoin.value = String(s.stroke_join ?? 0);
            if (this.strokeDash) this.strokeDash.value = (s.dash_array ?? []).join(',');
            if (this.blendMode) this.blendMode.value = String(s.blend_mode ?? 0);
            if (this.cornerRadius) this.cornerRadius.value = String(s.corner_radius ?? 0);
            if (this.fillOpacity) this.fillOpacity.value = String(Math.round((s.fill_opacity ?? 1) * 100));
            if (this.fillRule) this.fillRule.value = String(s.fill_rule ?? 0);
            if (this.dashOffset) this.dashOffset.value = String(s.dash_offset ?? 0);
            if (this.miterLimit) this.miterLimit.value = String(s.miter_limit ?? 4);
        } catch { /* keep whatever the panel shows */ }
        // Transform fields have no meaning without a selection
        if (this.propX) this.propX.value = '';
        if (this.propY) this.propY.value = '';
        if (this.propW) this.propW.value = '';
        if (this.propH) this.propH.value = '';
        if (this.propRotation) this.propRotation.value = '';
        if (this.toggleVisible) this.toggleVisible.classList.remove('active');
        if (this.toggleLocked) this.toggleLocked.classList.remove('active');
    }

    updateLayerList() {
        if (!this.scene.engine) return;

        let sceneData: ReturnType<typeof this.scene.getSceneData>;
        let selection: number[];
        try {
            sceneData = this.scene.getSceneData();
            selection = Array.from(this.scene.engine.get_selection());
        } catch {
            return; // Don't clear the list if we can't get fresh data
        }

        const nodes = sceneData?.nodes;
        const rootNodes = sceneData?.root_nodes;
        if (!nodes || !rootNodes || rootNodes.length === 0) {
            this.layerList.innerHTML = '';
            return;
        }

        // Clear only after we know we have data to render
        this.layerList.innerHTML = '';

        // Recursive helper to render a node and its children
        const renderNode = (id: number, depth: number) => {
            const node = nodes[id];
            if (!node) return;

            const isGroup = node.node_type === 'Group';
            const isCollapsed = this._collapsedGroups.has(id);
            const hasChildren = isGroup && node.children && node.children.length > 0;

            const item = document.createElement('div');
            item.className = 'layer-item';
            item.dataset.nodeId = id.toString();
            if (selection.includes(id)) item.classList.add('selected');
            if (node.visible === false) item.classList.add('layer-hidden');
            if (node.locked === true) item.classList.add('layer-locked');

            // Indent based on depth
            const indent = depth * 16;

            // Build layer item content
            let chevronHtml = '';
            if (hasChildren) {
                chevronHtml = `<span class="layer-chevron ${isCollapsed ? '' : 'expanded'}" data-toggle-id="${id}">▸</span>`;
            } else {
                chevronHtml = `<span class="layer-chevron-spacer"></span>`;
            }

            let icon = iconHexagon(14);
            if (isGroup) {
                icon = UIEngine.ICON_MAP['Group']();
            } else if (node.geometry?.Rect) {
                icon = UIEngine.ICON_MAP['Rect']();
            } else if (node.geometry?.Ellipse) {
                icon = UIEngine.ICON_MAP['Ellipse']();
            } else if (node.geometry?.Path) {
                icon = UIEngine.ICON_MAP['Path']();
            } else if (node.geometry?.Text) {
                icon = UIEngine.ICON_MAP['Text']();
            }

            const visIcon = node.visible !== false ? iconEye(12) : iconEyeOff(12);
            const lockIcon = node.locked === true ? iconLock(12) : '';

            item.innerHTML = `
                <div class="layer-item-row" style="padding-left: ${indent + 4}px">
                    ${chevronHtml}
                    <span class="layer-icon">${icon}</span>
                    <span class="layer-name" data-node-id="${id}">${node.name || `Node ${id}`}</span>
                    <span class="layer-actions">
                        ${lockIcon ? `<span class="layer-lock-btn" data-lock-id="${id}" title="Locked">${lockIcon}</span>` : ''}
                        <span class="layer-vis-btn" data-vis-id="${id}" title="Toggle visibility">${visIcon}</span>
                    </span>
                </div>
            `;

            // Click to select
            const row = item.querySelector('.layer-item-row') as HTMLElement;
            row.addEventListener('click', (e) => {
                const target = e.target as HTMLElement;
                // Don't select if clicking chevron, visibility, or lock buttons
                if (target.classList.contains('layer-chevron') ||
                    target.classList.contains('layer-vis-btn') ||
                    target.classList.contains('layer-lock-btn')) return;
                this.scene.selectNode(id, e.shiftKey);
                this.syncWithSelection();
            });

            // Double-click to rename
            const nameEl = item.querySelector('.layer-name') as HTMLElement;
            nameEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.startLayerRename(nameEl, id);
            });

            // Chevron toggle for groups
            if (hasChildren) {
                const chevron = item.querySelector('.layer-chevron') as HTMLElement;
                chevron.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (this._collapsedGroups.has(id)) {
                        this._collapsedGroups.delete(id);
                    } else {
                        this._collapsedGroups.add(id);
                    }
                    this.updateLayerList();
                });
            }

            // Visibility toggle
            const visBtn = item.querySelector('.layer-vis-btn') as HTMLElement;
            if (visBtn) {
                visBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.scene.setNodeVisible(id, node.visible === false);
                    this.updateLayerList();
                });
            }

            // Lock toggle
            const lockBtn = item.querySelector('.layer-lock-btn') as HTMLElement;
            if (lockBtn) {
                lockBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.scene.setNodeLocked(id, !node.locked);
                    this.updateLayerList();
                });
            }

            this.layerList.appendChild(item);

            // Render children if group is expanded
            if (hasChildren && !isCollapsed) {
                const children = node.children as number[];
                // Render in reverse for top-to-bottom visual order
                for (let i = children.length - 1; i >= 0; i--) {
                    renderNode(children[i], depth + 1);
                }
            }
        };

        // Iterate through root nodes in reverse order for layer list (top-to-bottom)
        for (let i = rootNodes.length - 1; i >= 0; i--) {
            renderNode(rootNodes[i], 0);
        }
    }

    /** Start inline renaming of a layer item. */
    private startLayerRename(nameEl: HTMLElement, nodeId: number) {
        const currentName = nameEl.textContent || '';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'layer-rename-input';
        input.value = currentName;

        nameEl.textContent = '';
        nameEl.appendChild(input);
        input.focus();
        input.select();

        const commit = () => {
            const newName = input.value.trim() || currentName;
            // Set the name via engine (we need to update the node's name)
            const sceneData = this.scene.getSceneData();
            const node = sceneData.nodes[nodeId];
            if (node) {
                node.name = newName;
                // Update via style JSON which includes name — actually we need a different approach
                // For now, directly set it in the engine and invalidate
                try {
                    this.scene.engine!.set_node_name(nodeId, newName);
                    this.scene.invalidateCache();
                } catch {
                    // set_node_name may not exist yet — fallback to just updating the display
                }
            }
            this.updateLayerList();
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            }
            if (e.key === 'Escape') {
                input.value = currentName;
                input.blur();
            }
        });
    }

    setZoom(level: number) {
        this.zoomText.innerText = `${Math.round(level * 100)}%`;
        // Keep the context bar's zoom label in sync
        this.contextBar?.refresh();
    }

    exportSVG() {
        const svg = this.buildSVGString();
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'export.svg';
        a.click();
        URL.revokeObjectURL(url);
    }

    /** Build the full SVG document string (with embedded .vec payload). */
    buildSVGString(): string {
        const sceneData = this.scene.getSceneData();
        const nodes = sceneData.nodes;
        const docW = this.scene.engine?.get_document_width() ?? 1000;
        const docH = this.scene.engine?.get_document_height() ?? 1000;
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${docW}" height="${docH}" viewBox="0 0 ${docW} ${docH}">`;

        /** Build SVG style attributes string for a node. */
        const buildStyleAttrs = (node: typeof nodes[number]): string => {
            const fill = node.style.fill ? escapeXml(this.rgbToHex(node.style.fill)) : 'none';
            const stroke = node.style.stroke ? escapeXml(this.rgbToHex(node.style.stroke)) : 'none';
            const sw = node.style.stroke_width;
            const op = node.style.opacity;

            let attrs = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"`;
            attrs += ` stroke-linecap="${UIEngine.CAP_MAP[node.style.stroke_cap || 0]}"`;
            attrs += ` stroke-linejoin="${UIEngine.JOIN_MAP[node.style.stroke_join || 0]}"`;

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

            const fillRuleIdx = node.style.fill_rule || 0;
            if (fillRuleIdx > 0) {
                attrs += ` fill-rule="${UIEngine.FILL_RULE_MAP[fillRuleIdx]}"`;
            }

            // Visibility
            if (node.visible === false) {
                attrs += ` visibility="hidden"`;
            }

            return attrs;
        };

        /**
         * Recursively emit SVG for a node and its children in draw order.
         * @param nodeId  The node to emit
         * @param depth   Indentation depth for pretty-printing
         */
        const emitNode = (nodeId: number, depth: number) => {
            const node = nodes[nodeId];
            if (!node) return;

            const indent = '\n' + '  '.repeat(depth + 1);
            // Local transform from scene data (column-major [f32; 9])
            const mat = matrixToSVGTransform(node.transform);

            // Group node → emit <g> with local transform, recurse children.
            // Childless groups are skipped entirely (their placeholder Rect{0,0}
            // geometry must not leak into the output).
            if (node.node_type === 'Group') {
                if (!node.children || node.children.length === 0) return;
                let gAttrs = `transform="${mat}"`;
                if (node.visible === false) gAttrs += ` visibility="hidden"`;
                svg += `${indent}<g ${gAttrs}>`;
                for (const childId of node.children) {
                    emitNode(childId, depth + 1);
                }
                svg += `${indent}</g>`;
                return;
            }

            // Build style + transform attributes
            let attrs = buildStyleAttrs(node);
            attrs += ` transform="${mat}"`;

            // Emit based on geometry type
            if (node.geometry.Rect) {
                const { width, height } = node.geometry.Rect;
                const rx = node.style.corner_radius || 0;
                svg += `${indent}<rect width="${width}" height="${height}" ${rx > 0 ? `rx="${rx}" ry="${rx}" ` : ''}${attrs} />`;
            } else if (node.geometry.Ellipse) {
                const { radius_x, radius_y } = node.geometry.Ellipse;
                svg += `${indent}<ellipse rx="${radius_x}" ry="${radius_y}" ${attrs} />`;
            } else if (node.geometry.Path) {
                const subpaths = node.geometry.Path.subpaths;
                let d = '';
                for (const sp of subpaths) {
                    if (sp.points.length < 2) continue;
                    d += `M ${sp.points[0].x} ${sp.points[0].y} `;
                    for (let i = 1; i < sp.points.length; i++) {
                        const prev = sp.points[i - 1];
                        const p = sp.points[i];
                        d += `C ${prev.cp2[0]} ${prev.cp2[1]} ${p.cp1[0]} ${p.cp1[1]} ${p.x} ${p.y} `;
                    }
                    if (sp.closed && sp.points.length >= 2) {
                        const last = sp.points[sp.points.length - 1];
                        const first = sp.points[0];
                        d += `C ${last.cp2[0]} ${last.cp2[1]} ${first.cp1[0]} ${first.cp1[1]} ${first.x} ${first.y} Z `;
                    }
                }
                if (d.trim()) {
                    svg += `${indent}<path d="${d.trim()}" ${attrs} />`;
                }
            } else if (node.geometry.Text) {
                const { content, font_size } = node.geometry.Text;
                const escapedContent = escapeXml(content);
                svg += `${indent}<text x="0" y="0" font-size="${font_size}" ${attrs}>${escapedContent}</text>`;
            }
            // Nodes with no geometry payload (e.g. empty groups) are silently skipped
        };

        // Walk root_nodes in scene order (index 0 = drawn first = bottom)
        for (const rootId of sceneData.root_nodes) {
            emitNode(rootId, 0);
        }

        svg += `\n</svg>`;

        // Embed protobuf payload for lossless re-importing
        if (this.scene.engine) {
            svg = FileIO.embedPayloadInSVG(this.scene.engine, svg);
        }
        return svg;
    }

    private hexToRgb(hex: string): Color {
        return hexToRgb(hex);
    }

    private rgbToHex(color: { r: number; g: number; b: number }): string {
        return rgbToHex(color);
    }

    parseSVG(svgText: string) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, 'image/svg+xml');
        const svg = doc.querySelector('svg');
        if (!svg) return;

        this.scene.saveMoveHistory();

        // Parse viewBox for offset/scaling
        let vbMatrix = identityMatrix();
        const viewBox = svg.getAttribute('viewBox');
        if (viewBox) {
            const parts = viewBox.trim().split(/[\s,]+/).map(Number);
            if (parts.length >= 2 && (parts[0] !== 0 || parts[1] !== 0)) {
                // Translate to compensate for viewBox origin
                vbMatrix = parseSVGTransform(`translate(${-parts[0]},${-parts[1]})`);
            }
        }

        // Color parser that handles hex, rgb(), rgba(), and named colors
        const parseColor = (colorStr: string | null): string | null => {
            if (!colorStr || colorStr === 'none' || colorStr === 'transparent') return null;
            // Check for gradient URL reference
            if (colorStr.match(/url\s*\(/)) {
                return resolveGradientColor(doc, colorStr);
            }
            if (colorStr.startsWith('#')) return colorStr;
            // rgb(r,g,b) or rgb(r g b)
            const rgbMatch = colorStr.match(/rgb\s*\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*\)/);
            if (rgbMatch) {
                const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
                const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
                const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
                return `#${r}${g}${b}`;
            }
            // Named colors (basic set)
            const namedColors: Record<string, string> = {
                black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
                blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
                gray: '#808080', grey: '#808080', pink: '#ffc0cb', brown: '#a52a2a',
                cyan: '#00ffff', magenta: '#ff00ff', lime: '#00ff00', navy: '#000080',
                teal: '#008080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000',
                aqua: '#00ffff', fuchsia: '#ff00ff', crimson: '#dc143c', coral: '#ff7f50',
                currentColor: '#000000', inherit: '#000000',
            };
            return namedColors[colorStr.toLowerCase()] || colorStr;
        };

        // Parse inline style attribute to get style properties
        const parseInlineStyle = (el: Element): Record<string, string> => {
            const styleAttr = el.getAttribute('style');
            if (!styleAttr) return {};
            const props: Record<string, string> = {};
            for (const decl of styleAttr.split(';')) {
                const [key, val] = decl.split(':').map(s => s.trim());
                if (key && val) props[key] = val;
            }
            return props;
        };

        // Get attribute with inline style fallback
        const getStyleAttr = (el: Element, attr: string, inlineStyles: Record<string, string>): string | null => {
            return inlineStyles[attr] || el.getAttribute(attr);
        };

        const parseFill = (el: Element, inlineStyles: Record<string, string>): string | null => {
            const fill = getStyleAttr(el, 'fill', inlineStyles);
            if (fill === 'none') return null;
            return parseColor(fill) || '#808080';
        };

        const parseStroke = (el: Element, inlineStyles: Record<string, string>): string | null => {
            const stroke = getStyleAttr(el, 'stroke', inlineStyles);
            if (stroke === 'none' || !stroke) return null;
            return parseColor(stroke);
        };

        const applyStyle = (id: number, el: Element) => {
            const inlineStyles = parseInlineStyle(el);
            const fillHex = parseFill(el, inlineStyles);
            const strokeHex = parseStroke(el, inlineStyles);
            const sw = parseFloat(getStyleAttr(el, 'stroke-width', inlineStyles) || '1');
            const op = parseFloat(getStyleAttr(el, 'opacity', inlineStyles) || '1');

            const fill = fillHex ? this.hexToRgb(fillHex) : null;
            const stroke = strokeHex ? this.hexToRgb(strokeHex) : null;

            // Parse stroke-linecap
            const capStr = getStyleAttr(el, 'stroke-linecap', inlineStyles) || 'butt';
            const capMap: Record<string, number> = { butt: 0, round: 1, square: 2 };
            const strokeCap = capMap[capStr] ?? 0;

            // Parse stroke-linejoin
            const joinStr = getStyleAttr(el, 'stroke-linejoin', inlineStyles) || 'miter';
            const joinMap: Record<string, number> = { miter: 0, round: 1, bevel: 2 };
            const strokeJoin = joinMap[joinStr] ?? 0;

            // Parse fill-rule
            const fillRuleStr = getStyleAttr(el, 'fill-rule', inlineStyles) || 'nonzero';
            const fillRuleMap: Record<string, number> = { nonzero: 0, evenodd: 1 };
            const fillRule = fillRuleMap[fillRuleStr] ?? 0;

            // Parse miter limit
            const miterLimit = parseFloat(getStyleAttr(el, 'stroke-miterlimit', inlineStyles) || '4');

            // Parse fill-opacity
            const fillOpacity = parseFloat(getStyleAttr(el, 'fill-opacity', inlineStyles) || '1');

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
            const dashArr = getStyleAttr(el, 'stroke-dasharray', inlineStyles);
            if (dashArr && dashArr !== 'none') {
                style.dash_array = dashArr.split(/[,\s]+/).map(Number).filter(n => !isNaN(n));
            }

            // Parse stroke-dashoffset
            const dashOff = getStyleAttr(el, 'stroke-dashoffset', inlineStyles);
            if (dashOff) {
                style.dash_offset = parseFloat(dashOff);
            }

            // Parse rx for corner radius (rects)
            const rx = el.getAttribute('rx');
            if (rx) style.corner_radius = parseFloat(rx);

            this.scene.setNodeStyle(id, JSON.stringify(style));

            // Handle visibility
            const visibility = getStyleAttr(el, 'visibility', inlineStyles);
            const display = getStyleAttr(el, 'display', inlineStyles);
            if (visibility === 'hidden' || display === 'none') {
                this.scene.setNodeVisible(id, false);
            }
        };

        // Collect all created node IDs for final grouping
        const createdIds: number[] = [];

        /**
         * Recursive element processor — handles <g>, shapes, and nested structure.
         * @param el         The SVG element to process
         * @param parentMat  Composed parent transform matrix (column-major [f32; 9])
         */
        const processElement = (el: Element, parentMat: number[]) => {
            const tag = el.tagName.toLowerCase();

            // Skip metadata, defs, style, desc, title, clipPath
            if (['defs', 'style', 'metadata', 'desc', 'title', 'clippath', 'mask', 'symbol', 'pattern', 'lineargradient', 'radialgradient'].includes(tag)) return;

            // Parse this element's transform and compose with parent
            const transformAttr = el.getAttribute('transform');
            const localMat = transformAttr ? parseSVGTransform(transformAttr) : identityMatrix();
            const composedMat = composeMatrices(parentMat, localMat);

            // Handle <g> groups — recurse into children
            if (tag === 'g') {
                const childIds: number[] = [];
                for (const child of el.children) {
                    const beforeLen = createdIds.length;
                    processElement(child, composedMat);
                    // Collect IDs created by children
                    for (let i = beforeLen; i < createdIds.length; i++) {
                        childIds.push(createdIds[i]);
                    }
                }
                // If the group had children, group them
                if (childIds.length > 1) {
                    // Remove child IDs from createdIds (they'll be in the group)
                    for (const cid of childIds) {
                        const idx = createdIds.indexOf(cid);
                        if (idx !== -1) createdIds.splice(idx, 1);
                    }
                    const groupId = this.scene.groupNodes(childIds);
                    // Set group name from id or class
                    const groupName = el.getAttribute('id') || el.getAttribute('class') || 'Group';
                    try { this.scene.engine!.set_node_name(groupId, groupName); } catch { /* noop */ }
                    createdIds.push(groupId);
                } else if (childIds.length === 1) {
                    // Single child — optionally name it from the group
                    const childName = el.getAttribute('id') || el.getAttribute('class');
                    if (childName) {
                        try { this.scene.engine!.set_node_name(childIds[0], childName); } catch { /* noop */ }
                    }
                }
                return;
            }

            // Handle <use> — basic support (inline the referenced element)
            if (tag === 'use') {
                const href = el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
                if (href && href.startsWith('#')) {
                    const refEl = svg!.querySelector(href);
                    if (refEl) {
                        const useX = parseFloat(el.getAttribute('x') || '0');
                        const useY = parseFloat(el.getAttribute('y') || '0');
                        const useMat = composeMatrices(composedMat, parseSVGTransform(`translate(${useX},${useY})`));
                        processElement(refEl, useMat);
                    }
                }
                return;
            }

            // Process shape elements
            let nodeId: number | null = null;

            if (tag === 'rect') {
                const x = parseFloat(el.getAttribute('x') || '0');
                const y = parseFloat(el.getAttribute('y') || '0');
                const w = parseFloat(el.getAttribute('width') || '100');
                const h = parseFloat(el.getAttribute('height') || '100');
                // Create at origin, then set full transform (origin offset baked into matrix)
                nodeId = this.scene.addRect(0, 0, w, h);
                const offsetMat = composeMatrices(composedMat, parseSVGTransform(`translate(${x},${y})`));
                this.scene.setNodeTransform(nodeId, offsetMat);
            } else if (tag === 'ellipse') {
                const cx = parseFloat(el.getAttribute('cx') || '0');
                const cy = parseFloat(el.getAttribute('cy') || '0');
                const rx = parseFloat(el.getAttribute('rx') || '50');
                const ry = parseFloat(el.getAttribute('ry') || '50');
                // Create at origin, then set full transform (center offset baked into matrix)
                nodeId = this.scene.addEllipse(0, 0, rx, ry);
                const offsetMat = composeMatrices(composedMat, parseSVGTransform(`translate(${cx},${cy})`));
                this.scene.setNodeTransform(nodeId, offsetMat);
            } else if (tag === 'circle') {
                const cx = parseFloat(el.getAttribute('cx') || '0');
                const cy = parseFloat(el.getAttribute('cy') || '0');
                const r = parseFloat(el.getAttribute('r') || '50');
                nodeId = this.scene.addEllipse(0, 0, r, r);
                const offsetMat = composeMatrices(composedMat, parseSVGTransform(`translate(${cx},${cy})`));
                this.scene.setNodeTransform(nodeId, offsetMat);
            } else if (tag === 'text') {
                const x = parseFloat(el.getAttribute('x') || '0');
                const y = parseFloat(el.getAttribute('y') || '0');
                const content = el.textContent || 'Text';
                const fontSize = parseFloat(el.getAttribute('font-size') || '24');
                nodeId = this.scene.addText(0, 0, content, fontSize);
                const offsetMat = composeMatrices(composedMat, parseSVGTransform(`translate(${x},${y})`));
                this.scene.setNodeTransform(nodeId, offsetMat);
            } else if (tag === 'line') {
                const x1 = parseFloat(el.getAttribute('x1') || '0');
                const y1 = parseFloat(el.getAttribute('y1') || '0');
                const x2 = parseFloat(el.getAttribute('x2') || '100');
                const y2 = parseFloat(el.getAttribute('y2') || '100');
                // Bake transform into point coordinates
                const [tx1, ty1] = transformPoint(composedMat, x1, y1);
                const [tx2, ty2] = transformPoint(composedMat, x2, y2);
                const points = [
                    { x: tx1, y: ty1, cp1: [tx1, ty1], cp2: [tx1, ty1] },
                    { x: tx2, y: ty2, cp1: [tx2, ty2], cp2: [tx2, ty2] },
                ];
                const subpaths = [{ points, closed: false }];
                nodeId = this.scene.addPath(JSON.stringify(subpaths));
            } else if (tag === 'polygon' || tag === 'polyline') {
                const pointsStr = el.getAttribute('points') || '';
                const coords = pointsStr.trim().split(/[\s,]+/).map(Number);
                const pts = [];
                for (let i = 0; i < coords.length - 1; i += 2) {
                    // Bake transform into point coordinates
                    const [px, py] = transformPoint(composedMat, coords[i], coords[i + 1]);
                    pts.push({ x: px, y: py, cp1: [px, py], cp2: [px, py] });
                }
                if (pts.length >= 2) {
                    const subpaths = [{ points: pts, closed: tag === 'polygon' }];
                    nodeId = this.scene.addPath(JSON.stringify(subpaths));
                }
            } else if (tag === 'path') {
                const d = el.getAttribute('d') || '';
                // Parse path at origin, then bake the composed transform into coordinates
                const subpaths = this.parseSVGPathDWithMatrix(d, composedMat);
                if (subpaths.length > 0) {
                    nodeId = this.scene.addPath(JSON.stringify(subpaths));
                }
            }

            if (nodeId !== null) {
                applyStyle(nodeId, el);
                // Set name from id attribute if present
                const elName = el.getAttribute('id') || el.getAttribute('class');
                if (elName) {
                    try { this.scene.engine!.set_node_name(nodeId, elName); } catch { /* noop */ }
                }
                createdIds.push(nodeId);
            }
        };

        // Process all direct children of the SVG element recursively
        for (const child of svg.children) {
            processElement(child, vbMatrix);
        }

        // Auto-group all imported elements
        if (createdIds.length > 1) {
            const importGroupId = this.scene.groupNodes(createdIds);
            try { this.scene.engine!.set_node_name(importGroupId, 'SVG Import'); } catch { /* noop */ }
            // Select the import group
            this.scene.engine!.clear_selection();
            this.scene.selectNode(importGroupId, false);
        } else if (createdIds.length === 1) {
            // Single element — just select it
            this.scene.engine!.clear_selection();
            this.scene.selectNode(createdIds[0], false);
        }

        this.scene.invalidateCache();
        this.updateLayerList();
        this.syncWithSelection();
    }

    /**
     * Parse SVG path `d` attribute and bake a composed transform matrix
     * into all point coordinates.
     */
    private parseSVGPathDWithMatrix(d: string, mat: number[]): SVGSubpath[] {
        // Parse at origin (no tx/ty offset — we'll transform manually)
        const subpaths = parseSVGPathDUtil(d, 0, 0);
        // Check if matrix is identity — skip transform if so
        const isIdentity = mat[0] === 1 && mat[1] === 0 && mat[3] === 0 && mat[4] === 1 && mat[6] === 0 && mat[7] === 0;
        if (isIdentity) return subpaths;
        // Bake transform into all points and control points
        for (const sp of subpaths) {
            for (const pt of sp.points) {
                const [nx, ny] = transformPoint(mat, pt.x, pt.y);
                const [nc1x, nc1y] = transformPoint(mat, pt.cp1[0], pt.cp1[1]);
                const [nc2x, nc2y] = transformPoint(mat, pt.cp2[0], pt.cp2[1]);
                pt.x = nx; pt.y = ny;
                pt.cp1 = [nc1x, nc1y];
                pt.cp2 = [nc2x, nc2y];
            }
        }
        return subpaths;
    }


    showContextMenu(x: number, y: number, callback: (action: string) => void) {
        this._contextMenuCallback = callback;
        const items: Array<{ label: string; action: string; shortcut: string } | 'separator'> = [
            { label: 'Bring to Front', action: 'bring-to-front', shortcut: '⌘]' },
            { label: 'Bring Forward', action: 'bring-forward', shortcut: ']' },
            { label: 'Send Backward', action: 'send-backward', shortcut: '[' },
            { label: 'Send to Back', action: 'send-to-back', shortcut: '⌘[' },
            'separator',
            { label: 'Group', action: 'group', shortcut: '⌘G' },
            { label: 'Ungroup', action: 'ungroup', shortcut: '⌘⇧G' },
            { label: 'Convert to Path', action: 'convert-to-path', shortcut: '' },
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
