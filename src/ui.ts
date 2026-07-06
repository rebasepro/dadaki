import type { CanvasKit } from 'canvaskit-wasm';
import type { WasmScene } from './wasm_scene';
import { FileIO } from './file_io';
import type { Color } from './types';
import { isGradient } from './types';
import { hexToRgb, rgbToHex, parseSVGPathD as parseSVGPathDUtil, parseSVGTransform, composeMatrices, transformPoint, identityMatrix, resolveGradientColor, resolveGradient, parseCssColor, parsePreserveAspectRatio, translateMatrix } from './svg_utils';
import { buildSVGFromData, BLEND_MODE_MAP } from './svg_export';
import type { SVGExportInput, FilledFace } from './svg_export';
import type { SVGSubpath, SVGGradientData } from './svg_utils';
import type { ContextBar } from './context_bar';
import type { BreadcrumbBar } from './breadcrumb';
import { iconFolder, iconSquare, iconCircle, iconPenTool, iconType, iconHexagon, iconEye, iconEyeOff, iconLock, iconUnlock } from './icons';

export class UIEngine {
    ck: CanvasKit;
    scene: WasmScene;
    activeTool: string = 'selection';
    contextBar: ContextBar | null = null;
    breadcrumbBar: BreadcrumbBar | null = null;

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
    propSkewX: HTMLInputElement;
    propSkewY: HTMLInputElement;

    // DOM Elements — new SVG properties
    fillOpacity: HTMLInputElement;
    fillRule: HTMLSelectElement;
    dashOffset: HTMLInputElement;
    miterLimit: HTMLInputElement;
    toggleVisible: HTMLButtonElement;
    toggleLocked: HTMLButtonElement;

    // Typography DOM elements
    textFontFamily: HTMLSelectElement;
    textFontSize: HTMLInputElement;
    textLineHeight: HTMLInputElement;
    textAlign: HTMLSelectElement;
    typographySection: HTMLElement;

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
        this.propSkewX = document.getElementById('prop-skew-x') as HTMLInputElement;
        this.propSkewY = document.getElementById('prop-skew-y') as HTMLInputElement;

        // Initialize DOM refs — new SVG properties
        this.fillOpacity = document.getElementById('fill-opacity') as HTMLInputElement;
        this.fillRule = document.getElementById('fill-rule') as HTMLSelectElement;
        this.dashOffset = document.getElementById('stroke-dash-offset') as HTMLInputElement;
        this.miterLimit = document.getElementById('stroke-miter-limit') as HTMLInputElement;
        this.toggleVisible = document.getElementById('toggle-visible') as HTMLButtonElement;
        this.toggleLocked = document.getElementById('toggle-locked') as HTMLButtonElement;

        // Typography
        this.textFontFamily = document.getElementById('text-font-family') as HTMLSelectElement;
        this.textFontSize = document.getElementById('text-font-size') as HTMLInputElement;
        this.textLineHeight = document.getElementById('text-line-height') as HTMLInputElement;
        this.textAlign = document.getElementById('text-align') as HTMLSelectElement;
        this.typographySection = document.getElementById('typography-section') as HTMLElement;

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
            this.strokeDash, this.blendMode,
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

        // Corner radius has its own handler: on a Rect it sets the parametric
        // shape radius; on a Path it writes the radius onto the vertices
        // (selected ones in node-edit mode, otherwise all corners).
        if (this.cornerRadius) {
            this.cornerRadius.addEventListener('input', () => {
                if (!this._propertyEditSnapshotTaken) {
                    this.scene.saveMoveHistory();
                    this._propertyEditSnapshotTaken = true;
                }
                this.applyCornerRadiusToSelection();
            });
            this.cornerRadius.addEventListener('change', () => {
                if (!this._propertyEditSnapshotTaken) {
                    this.scene.saveMoveHistory();
                }
                this._propertyEditSnapshotTaken = false;
                this.applyCornerRadiusToSelection();
                this.scene.autosave?.trigger();
            });
        }

        // Typography properties
        const typographyInputs = [this.textFontFamily, this.textFontSize, this.textLineHeight, this.textAlign];
        for (const el of typographyInputs) {
            if (el) {
                el.addEventListener('input', () => {
                    if (!this._propertyEditSnapshotTaken) {
                        this.scene.saveMoveHistory();
                        this._propertyEditSnapshotTaken = true;
                    }
                    this.updateTextPropertiesNoHistory();
                });
                el.addEventListener('change', () => {
                    if (!this._propertyEditSnapshotTaken) {
                        this.scene.saveMoveHistory();
                    }
                    this._propertyEditSnapshotTaken = false;
                    this.updateTextPropertiesNoHistory();
                    this.scene.autosave?.trigger();
                });
            }
        }

        // Transform properties
        const transformInputs = [this.propX, this.propY, this.propW, this.propH, this.propRotation, this.propSkewX, this.propSkewY];
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
                'scissors': 'crosshair',
            };
            canvas.style.cursor = cursorMap[toolId] || 'default';
        }

        this.contextBar?.refresh();
        this.breadcrumbBar?.refresh();
    }

    /** Get the current fill color from the UI as {r, g, b, a} in 0-1 range. */
    getActiveFillColor(): Color {
        const hex = this.fillInput?.value || '#4285F4';
        return this.hexToRgb(hex);
    }

    private toggleNodeVisibility() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;

        const currentVisible = this.scene.getNodeVisible(selection[0]);

        const newVisible = !currentVisible;
        for (const id of selection) {
            this.scene.setNodeVisible(id, newVisible);
        }

        // Update button visual
        this.toggleVisible.classList.toggle('active', newVisible);
    }

    private toggleNodeLocked() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;

        const currentLocked = this.scene.getNodeLocked(selection[0]);

        const newLocked = !currentLocked;
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

    /** Apply the Radius field to the selection. Rect → shape corner_radius;
     *  Path → per-vertex corner_radius (selected vertices in node-edit mode,
     *  otherwise every corner). No-history: the calling gesture snapshots once. */
    applyCornerRadiusToSelection() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;
        const radius = this.cornerRadius ? Math.max(0, parseFloat(this.cornerRadius.value) || 0) : 0;
        const im = this.scene.renderer?.inputManager;

        for (const id of selection) {
            const node = this.scene.getNode(id);
            if (!node) continue;

            if (node.geometry.Rect) {
                const style = { ...node.style, corner_radius: radius };
                this.scene.setNodeStyleNoHistory(id, JSON.stringify(style));
            } else if (node.geometry.Path) {
                const subpaths = node.geometry.Path.subpaths;
                // Target only the selected vertices when this node is being
                // edited with a non-empty vertex selection; else all corners.
                const editingThis = im?.editingNodeId === id && (im?.selectedPoints?.size ?? 0) > 0;
                for (let si = 0; si < subpaths.length; si++) {
                    for (let pi = 0; pi < subpaths[si].points.length; pi++) {
                        if (!editingThis || im!.selectedPoints.has(`${si}:${pi}`)) {
                            subpaths[si].points[pi].corner_radius = radius;
                        }
                    }
                }
                this.scene.engine!.update_path_points(id, JSON.stringify(subpaths));
                // Keep the live node-edit buffer in sync so the overlay and
                // subsequent drags see the updated radii.
                if (im?.editingNodeId === id) {
                    im.editingPoints = JSON.parse(JSON.stringify(subpaths));
                }
            }
        }
        this.scene.invalidateCache();
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
        const node = this.scene.getNode(id);
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

        // Rotation + Skew — recompose the full transform as T × R × Skew × S
        // We read the current local transform to get the current scale,
        // then apply the new rotation and skew from the UI fields.
        {
            const lt = this.scene.getNodeLocalTransform(id);
            // lt is column-major [m00, m10, m20, m01, m11, m21, m02, m12, m22]
            // Decompose current scale from the local transform
            const sx = Math.sqrt(lt[0] * lt[0] + lt[1] * lt[1]) || 1;
            const det = lt[0] * lt[4] - lt[3] * lt[1];
            const sy = det < 0 ? -Math.sqrt(lt[3] * lt[3] + lt[4] * lt[4]) || -1 : Math.sqrt(lt[3] * lt[3] + lt[4] * lt[4]) || 1;

            const tx = lt[6]; // translation X (column-major: m02)
            const ty = lt[7]; // translation Y (column-major: m12)

            const angleDeg = parseFloat(this.propRotation?.value) || 0;
            const angleRad = angleDeg * (Math.PI / 180);
            const skewXDeg = parseFloat(this.propSkewX?.value) || 0;
            const skewYDeg = parseFloat(this.propSkewY?.value) || 0;
            const skewXRad = skewXDeg * (Math.PI / 180);
            const skewYRad = skewYDeg * (Math.PI / 180);

            const cosR = Math.cos(angleRad);
            const sinR = Math.sin(angleRad);
            const tanSkX = Math.tan(skewXRad);
            const tanSkY = Math.tan(skewYRad);

            // Compose: T(tx,ty) × R(θ) × Skew(skewX, skewY) × S(sx, sy)
            // Skew matrix:  [1, tan(skX), 0,  tan(skY), 1, 0,  0, 0, 1] (column-major)
            // R × Skew × S (column-major):
            //   col0 = R × [sx, sx*tan(skY), 0]
            //   col1 = R × [sy*tan(skX), sy, 0]
            const m00 = cosR * sx + (-sinR) * sx * tanSkY;
            const m10 = sinR * sx + cosR * sx * tanSkY;
            const m01 = cosR * sy * tanSkX + (-sinR) * sy;
            const m11 = sinR * sy * tanSkX + cosR * sy;

            // Column-major transform: [m00, m10, 0, m01, m11, 0, tx, ty, 1]
            const newTransform = [m00, m10, 0, m01, m11, 0, tx, ty, 1];
            this.scene.setNodeTransform(id, newTransform);
        }

        this.scene.invalidateCache();
        this.ui_syncSelection();
    }

    /** Internal sync helper to avoid recursion. */
    private ui_syncSelection() {
        // Lightweight sync that doesn't trigger updateTransform again
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;
        const nodeType = this.scene.getNodeType(selection[0]);
        if (nodeType === undefined) return;
        this.updateLayerList();
    }

    syncWithSelection(opts: { interactive?: boolean } = {}) {
        const interactive = opts.interactive === true;
        // Any selection change must repaint the overlay — otherwise stale
        // selection/corner-radius handles linger after deselecting via paths
        // that don't go through the canvas input handlers (e.g. layer panel).
        this.scene.renderer?.requestRender();
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) {
            this.clearPropertyPanel();
            if (!interactive) {
                this.updateLayerList();
                this.contextBar?.refresh();
                this.breadcrumbBar?.refresh();
            }
            return;
        }
        
        const node = this.scene.getNode(selection[0]);
        if (!node) {
            this.clearPropertyPanel();
            if (!interactive) {
                this.updateLayerList();
                this.contextBar?.refresh();
                this.breadcrumbBar?.refresh();
            }
            return;
        }
        const style = node.style;

        // Fill
        if (style.fill) {
            if (isGradient(style.fill)) {
                // Gradient fill — show first stop color in picker
                const firstStop = style.fill.stops?.[0]?.color;
                if (firstStop) {
                    this.fillInput.value = this.rgbToHex(firstStop);
                }
            } else {
                this.fillInput.value = this.rgbToHex(style.fill);
            }
            if (this.fillEnabled) this.fillEnabled.checked = true;
        } else {
            if (this.fillEnabled) this.fillEnabled.checked = false;
        }

        // Stroke
        if (style.stroke) {
            if (isGradient(style.stroke)) {
                const firstStop = style.stroke.stops?.[0]?.color;
                if (firstStop) {
                    this.strokeInput.value = this.rgbToHex(firstStop);
                }
            } else {
                this.strokeInput.value = this.rgbToHex(style.stroke);
            }
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

        // Corner radius — Rect uses the parametric shape radius; Path shows the
        // per-vertex radius (blank when corners differ), editable via the field.
        const cornerRadiusCell = document.getElementById('corner-radius-cell');
        const im = this.scene.renderer?.inputManager;
        if (this.cornerRadius) {
            if (node.geometry.Rect) {
                this.cornerRadius.value = (style.corner_radius || 0).toString();
            } else if (node.geometry.Path) {
                const editingThis = im?.editingNodeId === selection[0] && (im?.selectedPoints?.size ?? 0) > 0;
                const radii: number[] = [];
                const subs = node.geometry.Path.subpaths;
                for (let si = 0; si < subs.length; si++) {
                    for (let pi = 0; pi < subs[si].points.length; pi++) {
                        if (!editingThis || im!.selectedPoints.has(`${si}:${pi}`)) {
                            radii.push(subs[si].points[pi].corner_radius || 0);
                        }
                    }
                }
                const uniform = radii.length > 0 && radii.every(r => Math.abs(r - radii[0]) < 1e-3);
                this.cornerRadius.value = uniform ? String(radii[0]) : '';
                if (!uniform) this.cornerRadius.placeholder = 'Mixed';
            }
        }
        if (cornerRadiusCell) {
            cornerRadiusCell.style.display = (node.geometry.Rect || node.geometry.Path) ? '' : 'none';
        }

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

        // Decompose rotation and skew from the local transform matrix
        // The local transform is column-major: [m00, m10, m20, m01, m11, m21, m02, m12, m22]
        // Row-major (t from getTransform): [scaleX, skewX, transX, skewY, scaleY, transY, p0, p1, p2]
        {
            const lt = this.scene.getNodeLocalTransform(selection[0]);
            // Column-major: m00=lt[0], m10=lt[1], m01=lt[3], m11=lt[4]
            // Decompose as R × Skew × S
            const sx = Math.sqrt(lt[0] * lt[0] + lt[1] * lt[1]);
            const rotation = Math.atan2(lt[1], lt[0]);

            if (this.propRotation) {
                this.propRotation.value = Math.round(rotation * (180 / Math.PI)).toString();
            }

            // Remove rotation to get Skew × S
            if (sx > 1e-6) {
                const cosR = Math.cos(rotation);
                const sinR = Math.sin(rotation);
                // R⁻¹ × M  (only need the 2×2 linear part)
                // R⁻¹ = [cos, sin; -sin, cos]
                const r10 = -sinR * lt[0] + cosR * lt[1]; // ≈ sx * tan(skewY)
                const r01 = cosR * lt[3] + sinR * lt[4];  // = sx * tan(skewX)  ... actually sy*tan(skewX)
                const r11 = -sinR * lt[3] + cosR * lt[4]; // = sy

                // r00 = sx, r10 ≈ 0, r01 = sy * tan(skewX), r11 = sy
                // skewX = atan2(r01, r11)  — or atan(r01/r11) when r11 ≈ sy
                const skewXRad = Math.abs(r11) > 1e-6 ? Math.atan2(r01, r11) : 0;
                // skewY is not directly extractable from a simple R×Skew×S decomposition
                // because our compose order is R × SkewMatrix(skX, skY) × S
                // SkewMatrix col0 = [1, tan(skY)] × sx → after R: [cos-sin*tan(skY), sin+cos*tan(skY)] × sx
                // r10 = sx * tan(skY) when decomposed correctly, but r10 should be ≈ 0 in R×Skew×S
                // Actually: r10 = -sinR*lt[0] + cosR*lt[1]
                //   lt[0] = cosR*sx + (-sinR)*sx*tan(skY) = sx*(cosR - sinR*tan(skY))
                //   lt[1] = sinR*sx + cosR*sx*tan(skY) = sx*(sinR + cosR*tan(skY))
                //   r10 = -sinR*sx*(cosR-sinR*tanSkY) + cosR*sx*(sinR+cosR*tanSkY)
                //       = sx*(-sinR*cosR + sin²R*tanSkY + cosR*sinR + cos²R*tanSkY)
                //       = sx * tanSkY
                const skewYRad = Math.abs(sx) > 1e-6 ? Math.atan(r10 / sx) : 0;

                if (this.propSkewX) {
                    const deg = skewXRad * (180 / Math.PI);
                    this.propSkewX.value = Math.abs(deg) < 0.05 ? '0' : deg.toFixed(1);
                }
                if (this.propSkewY) {
                    const deg = skewYRad * (180 / Math.PI);
                    this.propSkewY.value = Math.abs(deg) < 0.05 ? '0' : deg.toFixed(1);
                }
            } else {
                if (this.propSkewX) this.propSkewX.value = '0';
                if (this.propSkewY) this.propSkewY.value = '0';
            }
        }

        // During interactive drags, skip expensive DOM rebuilds — the mouseup
        // handler will do a full syncWithSelection() to reconcile everything.
        if (!interactive) {
            this.updateLayerList();
            this.contextBar?.refresh();
            this.breadcrumbBar?.refresh();
        }
        // Typography — show/hide section and populate values
        if (node.geometry.Text) {
            if (this.typographySection) this.typographySection.style.display = '';
            if (this.textFontFamily) this.textFontFamily.value = node.geometry.Text.font_family || '';
            if (this.textFontSize) this.textFontSize.value = String(node.geometry.Text.font_size || 32);
            if (this.textLineHeight) this.textLineHeight.value = String(node.geometry.Text.line_height || 1.2);
            if (this.textAlign) this.textAlign.value = String(node.geometry.Text.text_align || 0);
        } else {
            if (this.typographySection) this.typographySection.style.display = 'none';
        }
    }

    /** Clear the property panel (when nothing is selected). Show the CURRENT style (what a newly drawn
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
        if (this.propSkewX) this.propSkewX.value = '';
        if (this.propSkewY) this.propSkewY.value = '';
        if (this.toggleVisible) this.toggleVisible.classList.remove('active');
        if (this.toggleLocked) this.toggleLocked.classList.remove('active');
        if (this.typographySection) this.typographySection.style.display = 'none';
        const cornerRadiusCell = document.getElementById('corner-radius-cell');
        if (cornerRadiusCell) cornerRadiusCell.style.display = 'none';
    }

    /** Apply typography properties from the side panel to the selected text node. */
    private updateTextPropertiesNoHistory() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length !== 1) return;
        const id = selection[0];
        const node = this.scene.getNode(id);
        if (!node?.geometry?.Text) return;

        const fontFamily = this.textFontFamily?.value ?? '';
        const textAlign = parseInt(this.textAlign?.value ?? '0', 10);
        const lineHeight = parseFloat(this.textLineHeight?.value ?? '1.2');
        const fontSize = parseFloat(this.textFontSize?.value ?? '32');

        // Update font size via setTextContent
        // NOTE: we need a way to set properties without history for live preview
        // Let's add set_text_properties_no_history to engine if needed, 
        // or just use the current one and assume history was already saved by the listener.
        
        const content = node.geometry.Text.content;
        this.scene.engine!.set_text_content(id, content, fontSize);
        this.scene.engine!.set_text_properties(id, fontFamily, textAlign, lineHeight);
        
        this.scene.invalidateCache();
        this.syncWithSelection({ interactive: true }); // Don't re-focus inputs
    }

    /** Map from numeric node type (engine enum) to string key for icon lookup.
     *  0=Path, 1=Rect, 2=Ellipse, 3=Group, 4=Text */
    private static readonly NODE_TYPE_KEY: readonly string[] = ['Path', 'Rect', 'Ellipse', 'Group', 'Text'];

    updateLayerList() {
        if (!this.scene.engine) return;

        let rootNodes: Uint32Array;
        let selection: number[];
        try {
            rootNodes = this.scene.getRootNodes();
            selection = Array.from(this.scene.engine.get_selection());
        } catch {
            return; // Don't clear the list if we can't get fresh data
        }

        if (rootNodes.length === 0) {
            this.layerList.innerHTML = '';
            return;
        }

        // Clear only after we know we have data to render
        this.layerList.innerHTML = '';

        // Recursive helper to render a node and its children
        const renderNode = (id: number, depth: number) => {
            const nodeTypeNum = this.scene.getNodeType(id);
            if (nodeTypeNum === undefined) return;

            const nodeTypeKey = UIEngine.NODE_TYPE_KEY[nodeTypeNum] || 'Path';
            const isGroup = nodeTypeKey === 'Group';
            const children = isGroup ? this.scene.getNodeChildren(id) : null;
            const isCollapsed = this._collapsedGroups.has(id);
            const hasChildren = isGroup && children !== null && children.length > 0;

            const nodeVisible = this.scene.getNodeVisible(id);
            const nodeLocked = this.scene.getNodeLocked(id);
            const nodeName = this.scene.getNodeName(id);

            const item = document.createElement('div');
            item.className = 'layer-item';
            item.dataset.nodeId = id.toString();
            if (selection.includes(id)) item.classList.add('selected');
            if (nodeVisible === false) item.classList.add('layer-hidden');
            if (nodeLocked === true) item.classList.add('layer-locked');

            // Indent based on depth
            const indent = depth * 16;

            // Build layer item content
            let chevronHtml = '';
            if (hasChildren) {
                chevronHtml = `<span class="layer-chevron ${isCollapsed ? '' : 'expanded'}" data-toggle-id="${id}">▸</span>`;
            } else {
                chevronHtml = `<span class="layer-chevron-spacer"></span>`;
            }

            const iconFn = UIEngine.ICON_MAP[nodeTypeKey];
            const icon = iconFn ? iconFn() : iconHexagon(14);

            const visIcon = nodeVisible !== false ? iconEye(12) : iconEyeOff(12);
            const lockIcon = nodeLocked === true ? iconLock(12) : iconUnlock(12);

            item.innerHTML = `
                <div class="layer-item-row" style="padding-left: ${indent + 4}px">
                    ${chevronHtml}
                    <span class="layer-icon">${icon}</span>
                    <span class="layer-name" data-node-id="${id}">${nodeName || `Node ${id}`}</span>
                    <span class="layer-actions">
                        <span class="layer-lock-btn" data-lock-id="${id}" title="${nodeLocked ? 'Unlock' : 'Lock'}">${lockIcon}</span>
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
                    this.scene.setNodeVisible(id, nodeVisible === false);
                    this.updateLayerList();
                });
            }

            // Lock toggle
            const lockBtn = item.querySelector('.layer-lock-btn') as HTMLElement;
            if (lockBtn) {
                lockBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.scene.setNodeLocked(id, !nodeLocked);
                    this.updateLayerList();
                });
            }

            this.layerList.appendChild(item);

            // Render children if group is expanded
            if (hasChildren && !isCollapsed) {
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
            // Set the name via engine — verify node exists first
            const existingName = this.scene.getNodeName(nodeId);
            if (existingName !== undefined) {
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
        this.breadcrumbBar?.refresh();
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
        const docW = this.scene.engine?.get_document_width() ?? 1000;
        const docH = this.scene.engine?.get_document_height() ?? 1000;

        const rootNodeIds = Array.from(this.scene.getRootNodes());

        // Collect all node data and local transforms
        const nodes: SVGExportInput['nodes'] = {};
        const localTransforms: SVGExportInput['localTransforms'] = {};

        const collectNodeData = (id: number) => {
            const node = this.scene.getNode(id);
            if (!node) return;
            // Bake per-vertex corner radii into the exported path outline so the
            // SVG matches the rendered (rounded) shape.
            if (node.geometry?.Path && this.scene.engine) {
                const resolved = this.scene.getResolvedSubpaths(id);
                if (resolved.length) node.geometry.Path.subpaths = resolved;
            }
            nodes[id] = node;
            localTransforms[id] = Array.from(this.scene.getNodeLocalTransform(id));
            if (node.node_type === 'Group') {
                const children = this.scene.getNodeChildren(id);
                for (const childId of Array.from(children)) {
                    collectNodeData(childId);
                }
            }
        };
        for (const rootId of rootNodeIds) {
            collectNodeData(rootId);
        }

        // Collect live-paint face fills
        let filledFaces: FilledFace[] | undefined;
        if (this.scene.engine) {
            try {
                const facesJson = this.scene.engine.get_filled_faces();
                const parsed = JSON.parse(facesJson) as FilledFace[];
                if (parsed.length > 0) filledFaces = parsed;
            } catch { /* no faces */ }
        }

        let svg = buildSVGFromData({
            docWidth: docW,
            docHeight: docH,
            nodes,
            rootNodeIds,
            localTransforms,
            filledFaces,
        });

        // Embed the binary .vec payload for round-tripping
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

    /** Import an SVG document as ONE undo step. */
    parseSVG(svgText: string) {
        this.scene.transaction(() => this.parseSVGInternal(svgText));
    }

    private parseSVGInternal(svgText: string) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, 'image/svg+xml');
        const svg = doc.querySelector('svg');
        if (!svg) return;

        // Parse viewBox for offset/scaling with preserveAspectRatio
        let vbMatrix = identityMatrix();
        const viewBox = svg.getAttribute('viewBox');
        if (viewBox) {
            const parts = viewBox.trim().split(/[\s,]+/).map(Number);
            if (parts.length >= 4) {
                const vbMinX = parts[0], vbMinY = parts[1];
                const vbWidth = parts[2], vbHeight = parts[3];

                // Determine the SVG element's intrinsic size
                const svgWidth = parseFloat(svg.getAttribute('width') || '0');
                const svgHeight = parseFloat(svg.getAttribute('height') || '0');

                if (svgWidth > 0 && svgHeight > 0 && vbWidth > 0 && vbHeight > 0) {
                    // Use preserveAspectRatio to compute the correct viewBox transform
                    const par = svg.getAttribute('preserveAspectRatio');
                    vbMatrix = parsePreserveAspectRatio(par, vbMinX, vbMinY, vbWidth, vbHeight, svgWidth, svgHeight);
                } else if (vbMinX !== 0 || vbMinY !== 0) {
                    // No explicit size — just translate away the viewBox origin
                    vbMatrix = translateMatrix(-vbMinX, -vbMinY);
                }
            } else if (parts.length >= 2 && (parts[0] !== 0 || parts[1] !== 0)) {
                // Fallback: only offset, no width/height in viewBox
                vbMatrix = translateMatrix(-parts[0], -parts[1]);
            }
        }

        // Color parser: hex (3/4/6/8), rgb[a](), hsl[a](), named colors, url() refs
        const parseColor = (colorStr: string | null): string | null => {
            if (!colorStr || colorStr === 'none' || colorStr === 'transparent') return null;
            // Gradient / paint-server reference: resolve to a representative
            // solid color (real gradient import replaces this path).
            if (colorStr.match(/url\s*\(/)) {
                const resolved = resolveGradientColor(doc, colorStr);
                if (resolved) return resolved;
                // SVG allows a fallback color after the url() reference
                const fallback = colorStr.replace(/url\s*\([^)]*\)\s*/, '').trim();
                return fallback ? parseColor(fallback) : null;
            }
            // Never return the raw string: hexToRgb turns unparsed values
            // (rgba(), hsl(), var(), …) into black, which reads as broken import.
            return parseCssColor(colorStr)?.hex ?? null;
        };

        // ─── CSS <style> block parsing ─────────────────────────────────
        // Many SVGs (Figma, Illustrator, Inkscape exports) define styles
        // via CSS class selectors inside <style> blocks. We parse these
        // into a lookup map so class-based styles participate in the cascade.
        //
        // Cascade priority: inline style="..." > CSS class rule > presentation attribute
        type CSSRuleMap = Map<string, Record<string, string>>;

        const parseCSSBlocks = (svgEl: Element): CSSRuleMap => {
            const rules: CSSRuleMap = new Map();
            const styleEls = svgEl.querySelectorAll('style');
            for (const styleEl of styleEls) {
                const css = styleEl.textContent || '';
                // Match simple rules: .className { prop: value; ... }
                // Also handles multi-class selectors like .cls-1, .cls-2 { ... }
                const ruleRegex = /([^{}]+)\{([^}]*)\}/g;
                let match;
                while ((match = ruleRegex.exec(css)) !== null) {
                    const selectors = match[1];
                    const body = match[2];
                    // Parse declarations
                    const props: Record<string, string> = {};
                    for (const decl of body.split(';')) {
                        const colonIdx = decl.indexOf(':');
                        if (colonIdx < 0) continue;
                        const key = decl.slice(0, colonIdx).trim();
                        const val = decl.slice(colonIdx + 1).trim();
                        if (key && val) props[key] = val;
                    }
                    // Apply to each selector (handles ".cls-1, .cls-2" comma-separated)
                    for (const sel of selectors.split(',')) {
                        const trimmed = sel.trim();
                        // Support simple class selectors: .className
                        if (trimmed.startsWith('.')) {
                            const className = trimmed.slice(1);
                            const existing = rules.get(className);
                            rules.set(className, existing ? { ...existing, ...props } : props);
                        }
                    }
                }
            }
            return rules;
        };

        const cssRules = parseCSSBlocks(svg);

        /** Get CSS class styles for an element (merged from all its classes). */
        const getCSSClassStyles = (el: Element): Record<string, string> => {
            const classAttr = el.getAttribute('class');
            if (!classAttr || cssRules.size === 0) return {};
            const merged: Record<string, string> = {};
            for (const cls of classAttr.trim().split(/\s+/)) {
                const rule = cssRules.get(cls);
                if (rule) Object.assign(merged, rule);
            }
            return merged;
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

        // Get attribute with cascade: inline style > CSS class > presentation attribute
        const getStyleAttr = (el: Element, attr: string, inlineStyles: Record<string, string>, classStyles?: Record<string, string>): string | null => {
            if (inlineStyles[attr]) return inlineStyles[attr];
            const cs = classStyles ?? getCSSClassStyles(el);
            if (cs[attr]) return cs[attr];
            return el.getAttribute(attr);
        };

        // ─── SVG style inheritance ──────────────────────────────────────
        // SVG presentation attributes cascade from parent to child.
        // We track the inheritable properties as a record threaded through
        // the recursive element tree.
        type InheritedStyles = Record<string, string | null>;

        /** SVG presentation attributes that inherit per the spec. */
        const INHERITABLE_ATTRS = [
            'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
            'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
            'opacity', 'fill-opacity', 'fill-rule', 'visibility', 'font-size',
        ];

        /** Read an element's own presentation attributes (explicit attr + inline style)
         *  and merge them on top of the parent's inherited styles. */
        const collectInheritedStyles = (el: Element, parentStyles: InheritedStyles): InheritedStyles => {
            const merged: InheritedStyles = { ...parentStyles };
            const inlineStyles = parseInlineStyle(el);
            for (const attr of INHERITABLE_ATTRS) {
                const val = getStyleAttr(el, attr, inlineStyles);
                if (val !== null && val !== 'inherit') {
                    merged[attr] = val;
                }
            }
            return merged;
        };

        /** Resolve an attribute value: element's own value > inherited > fallback. */
        const resolveAttr = (el: Element, attr: string, inlineStyles: Record<string, string>, inherited: InheritedStyles, fallback: string | null = null): string | null => {
            const own = getStyleAttr(el, attr, inlineStyles);
            if (own !== null && own !== 'inherit') return own;
            if (inherited[attr] !== undefined && inherited[attr] !== null) return inherited[attr]!;
            return fallback;
        };

        /** Result of parsing a fill/stroke attribute: either a solid hex (with alpha) or a gradient. */
        type ParsedPaint = { type: 'solid'; hex: string; alpha: number } | { type: 'gradient'; data: SVGGradientData };

        const parseFill = (el: Element, inlineStyles: Record<string, string>, inherited: InheritedStyles): ParsedPaint | null => {
            const fill = resolveAttr(el, 'fill', inlineStyles, inherited, '#000000');
            if (fill === 'none' || fill === 'transparent') return null;
            // Check for gradient url(#...)
            if (fill && fill.match(/url\s*\(/)) {
                const grad = resolveGradient(doc, fill);
                if (grad) return { type: 'gradient', data: grad };
                return null;
            }
            const parsed = parseCssColor(fill || '');
            return parsed ? { type: 'solid', hex: parsed.hex, alpha: parsed.alpha } : null;
        };

        const parseStroke = (el: Element, inlineStyles: Record<string, string>, inherited: InheritedStyles): ParsedPaint | null => {
            const stroke = resolveAttr(el, 'stroke', inlineStyles, inherited, null);
            if (!stroke || stroke === 'none' || stroke === 'transparent') return null;
            if (stroke.match(/url\s*\(/)) {
                const grad = resolveGradient(doc, stroke);
                if (grad) return { type: 'gradient', data: grad };
                return null;
            }
            const parsed = parseCssColor(stroke);
            return parsed ? { type: 'solid', hex: parsed.hex, alpha: parsed.alpha } : null;
        };

        /** Convert a ParsedPaint to the JSON format expected by the Rust engine's Paint enum.
         *  @param opacityMul  Extra opacity multiplier (e.g. fill-opacity / stroke-opacity)
         */
        const paintToJson = (paint: ParsedPaint | null, opacityMul: number = 1): Record<string, unknown> | null => {
            if (!paint) return null;
            if (paint.type === 'solid') {
                const c = this.hexToRgb(paint.hex);
                // Multiply CSS color alpha and the SVG fill-opacity / stroke-opacity
                c.a = paint.alpha * opacityMul;
                return { ...c };
            }
            // Gradient: matches Rust's Gradient struct for serde(untagged) deserialization
            return {
                gradient_type: paint.data.gradient_type,
                stops: paint.data.stops.map(s => ({
                    offset: s.offset,
                    color: s.color,
                })),
                start_x: paint.data.start_x,
                start_y: paint.data.start_y,
                end_x: paint.data.end_x,
                end_y: paint.data.end_y,
            };
        };

        const applyStyle = (id: number, el: Element, inherited: InheritedStyles) => {
            const inlineStyles = parseInlineStyle(el);
            const fillPaint = parseFill(el, inlineStyles, inherited);
            const strokePaint = parseStroke(el, inlineStyles, inherited);
            const sw = parseFloat(resolveAttr(el, 'stroke-width', inlineStyles, inherited, '1') || '1');
            const op = parseFloat(resolveAttr(el, 'opacity', inlineStyles, inherited, '1') || '1');

            // Parse fill-opacity and stroke-opacity (multiply into paint alpha)
            const fillOpacity = parseFloat(resolveAttr(el, 'fill-opacity', inlineStyles, inherited, '1') || '1');
            const strokeOpacity = parseFloat(resolveAttr(el, 'stroke-opacity', inlineStyles, inherited, '1') || '1');

            const fill = paintToJson(fillPaint, fillOpacity);
            const stroke = paintToJson(strokePaint, strokeOpacity);

            // Parse stroke-linecap
            const capStr = resolveAttr(el, 'stroke-linecap', inlineStyles, inherited, 'butt') || 'butt';
            const capMap: Record<string, number> = { butt: 0, round: 1, square: 2 };
            const strokeCap = capMap[capStr] ?? 0;

            // Parse stroke-linejoin
            const joinStr = resolveAttr(el, 'stroke-linejoin', inlineStyles, inherited, 'miter') || 'miter';
            const joinMap: Record<string, number> = { miter: 0, round: 1, bevel: 2 };
            const strokeJoin = joinMap[joinStr] ?? 0;

            // Parse fill-rule
            const fillRuleStr = resolveAttr(el, 'fill-rule', inlineStyles, inherited, 'nonzero') || 'nonzero';
            const fillRuleMap: Record<string, number> = { nonzero: 0, evenodd: 1 };
            const fillRule = fillRuleMap[fillRuleStr] ?? 0;

            // Parse miter limit
            const miterLimit = parseFloat(resolveAttr(el, 'stroke-miterlimit', inlineStyles, inherited, '4') || '4');


            const style = {
                fill, stroke,
                stroke_width: sw,
                opacity: op,
                stroke_cap: strokeCap,
                stroke_join: strokeJoin,
                dash_array: [] as number[],
                dash_offset: 0,
                corner_radius: 0,
                blend_mode: 0 as number,
                fill_rule: fillRule,
                miter_limit: miterLimit,
                fill_opacity: fillOpacity,
            };

            // Parse stroke-dasharray
            const dashArr = resolveAttr(el, 'stroke-dasharray', inlineStyles, inherited, null);
            if (dashArr && dashArr !== 'none') {
                style.dash_array = dashArr.split(/[,\s]+/).map(Number).filter(n => !isNaN(n));
            }

            // Parse stroke-dashoffset
            const dashOff = resolveAttr(el, 'stroke-dashoffset', inlineStyles, inherited, null);
            if (dashOff) {
                style.dash_offset = parseFloat(dashOff);
            }

            // Parse rx for corner radius (rects)
            const rx = el.getAttribute('rx');
            if (rx) style.corner_radius = parseFloat(rx);

            // Parse mix-blend-mode from inline style
            const blendStr = inlineStyles['mix-blend-mode'];
            if (blendStr) {
                const bmIdx = BLEND_MODE_MAP.indexOf(blendStr.trim() as typeof BLEND_MODE_MAP[number]);
                if (bmIdx > 0) style.blend_mode = bmIdx;
            }

            this.scene.setNodeStyle(id, JSON.stringify(style));

            // Handle visibility
            const visibility = resolveAttr(el, 'visibility', inlineStyles, inherited, null);
            const display = getStyleAttr(el, 'display', inlineStyles);
            if (visibility === 'hidden' || display === 'none') {
                this.scene.setNodeVisible(id, false);
            }
        };

        // Collect all created node IDs for final grouping
        const createdIds: number[] = [];

        // Collect inherited styles from the root <svg> element
        const rootInherited: InheritedStyles = collectInheritedStyles(svg, {});

        /** Helper: process children of a container element, optionally grouping results.
         *  Returns the IDs created. */
        const processChildren = (container: Element, mat: number[], inherited: InheritedStyles, useRefStack: Set<string>) => {
            const childIds: number[] = [];
            for (const child of container.children) {
                const beforeLen = createdIds.length;
                processElement(child, mat, inherited, useRefStack);
                for (let i = beforeLen; i < createdIds.length; i++) {
                    childIds.push(createdIds[i]);
                }
            }
            return childIds;
        };

        /** Helper: turn a list of child IDs into a group (or leave as-is for 0–1 children).
         *  Removes child IDs from createdIds and pushes the group ID instead. */
        const groupChildIds = (childIds: number[], name: string) => {
            if (childIds.length > 1) {
                const removeSet = new Set(childIds);
                let write = 0;
                for (let read = 0; read < createdIds.length; read++) {
                    if (!removeSet.has(createdIds[read])) {
                        createdIds[write++] = createdIds[read];
                    }
                }
                createdIds.length = write;
                const groupId = this.scene.groupNodes(childIds);
                try { this.scene.engine!.set_node_name(groupId, name); } catch { /* noop */ }
                createdIds.push(groupId);
            } else if (childIds.length === 1 && name) {
                try { this.scene.engine!.set_node_name(childIds[0], name); } catch { /* noop */ }
            }
        };

        /** Compute a viewBox transform matrix for an element with viewBox/width/height/preserveAspectRatio. */
        const computeViewBoxMatrix = (el: Element): number[] => {
            const vb = el.getAttribute('viewBox');
            if (!vb) return identityMatrix();
            const p = vb.trim().split(/[\s,]+/).map(Number);
            if (p.length < 4 || p[2] <= 0 || p[3] <= 0) return identityMatrix();
            const vpW = parseFloat(el.getAttribute('width') || '0');
            const vpH = parseFloat(el.getAttribute('height') || '0');
            if (vpW > 0 && vpH > 0) {
                const par = el.getAttribute('preserveAspectRatio');
                return parsePreserveAspectRatio(par, p[0], p[1], p[2], p[3], vpW, vpH);
            }
            // No explicit size — just translate away the viewBox origin
            if (p[0] !== 0 || p[1] !== 0) return translateMatrix(-p[0], -p[1]);
            return identityMatrix();
        };

        /**
         * Recursive element processor — handles <g>, shapes, and nested structure.
         * @param el          The SVG element to process
         * @param parentMat   Composed parent transform matrix (column-major [f32; 9])
         * @param inherited    Cascaded presentation attributes from ancestor elements
         * @param useRefStack  Set of href IDs currently being resolved (cycle detection)
         */
        const processElement = (el: Element, parentMat: number[], inherited: InheritedStyles, useRefStack: Set<string> = new Set()) => {
            const tag = el.tagName.toLowerCase();

            // Skip metadata, defs, style, desc, title, clipPath
            // Note: <symbol> is NOT skipped — it is processed when referenced by <use>
            if (['defs', 'style', 'metadata', 'desc', 'title', 'clippath', 'mask', 'pattern', 'lineargradient', 'radialgradient', 'filter'].includes(tag)) return;

            // <symbol> is only renderable when referenced by <use>, not as a top-level element
            if (tag === 'symbol') return;

            // Parse this element's transform and compose with parent
            const transformAttr = el.getAttribute('transform');
            const localMat = transformAttr ? parseSVGTransform(transformAttr) : identityMatrix();
            const composedMat = composeMatrices(parentMat, localMat);

            // Merge this element's styles on top of inherited ones
            const mergedStyles = collectInheritedStyles(el, inherited);

            // Handle <g> groups — recurse into children
            if (tag === 'g') {
                const childIds = processChildren(el, composedMat, mergedStyles, useRefStack);
                const groupName = el.getAttribute('id') || el.getAttribute('class') || 'Group';
                groupChildIds(childIds, groupName);
                return;
            }

            // Handle nested <svg> — treat as group with its own viewBox transform
            if (tag === 'svg') {
                const x = parseFloat(el.getAttribute('x') || '0');
                const y = parseFloat(el.getAttribute('y') || '0');
                const offsetMat = (x !== 0 || y !== 0)
                    ? composeMatrices(composedMat, translateMatrix(x, y))
                    : composedMat;
                const nestedVbMat = computeViewBoxMatrix(el);
                const nestedMat = composeMatrices(offsetMat, nestedVbMat);
                const childIds = processChildren(el, nestedMat, mergedStyles, useRefStack);
                const groupName = el.getAttribute('id') || 'Nested SVG';
                groupChildIds(childIds, groupName);
                return;
            }

            // Handle <switch> — import only the first renderable child
            if (tag === 'switch') {
                const nonRenderable = new Set(['foreignobject', 'desc', 'title', 'metadata']);
                for (const child of el.children) {
                    if (!nonRenderable.has(child.tagName.toLowerCase())) {
                        processElement(child, composedMat, mergedStyles, useRefStack);
                        return; // only first renderable child
                    }
                }
                return;
            }

            // Handle <use> — inline the referenced element with cycle guard
            if (tag === 'use') {
                const href = el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
                if (href && href.startsWith('#')) {
                    const refId = href.slice(1);

                    // Cycle detection: prevent infinite recursion
                    if (useRefStack.has(refId)) return;

                    const refEl = doc.getElementById(refId);
                    if (refEl) {
                        const useX = parseFloat(el.getAttribute('x') || '0');
                        const useY = parseFloat(el.getAttribute('y') || '0');
                        const useMat = (useX !== 0 || useY !== 0)
                            ? composeMatrices(composedMat, translateMatrix(useX, useY))
                            : composedMat;

                        // Push this ref onto the cycle-detection stack
                        const newStack = new Set(useRefStack);
                        newStack.add(refId);

                        const refTag = refEl.tagName.toLowerCase();
                        if (refTag === 'symbol') {
                            // <symbol> acts like a nested viewport:
                            // compute viewBox transform using <use>'s width/height (or <symbol>'s)
                            const useW = parseFloat(el.getAttribute('width') || refEl.getAttribute('width') || '0');
                            const useH = parseFloat(el.getAttribute('height') || refEl.getAttribute('height') || '0');
                            const symVb = refEl.getAttribute('viewBox');
                            let symMat = useMat;
                            if (symVb) {
                                const p = symVb.trim().split(/[\s,]+/).map(Number);
                                if (p.length >= 4 && p[2] > 0 && p[3] > 0 && useW > 0 && useH > 0) {
                                    const par = refEl.getAttribute('preserveAspectRatio');
                                    const vbMat = parsePreserveAspectRatio(par, p[0], p[1], p[2], p[3], useW, useH);
                                    symMat = composeMatrices(useMat, vbMat);
                                } else if (p.length >= 2 && (p[0] !== 0 || p[1] !== 0)) {
                                    symMat = composeMatrices(useMat, translateMatrix(-p[0], -p[1]));
                                }
                            }
                            // Process symbol's children
                            const symStyles = collectInheritedStyles(refEl, mergedStyles);
                            const childIds = processChildren(refEl, symMat, symStyles, newStack);
                            const groupName = refEl.getAttribute('id') || el.getAttribute('id') || 'Symbol';
                            groupChildIds(childIds, groupName);
                        } else {
                            // Regular element reference (<g>, <rect>, etc.)
                            processElement(refEl, useMat, mergedStyles, newStack);
                        }
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
                const offsetMat = composeMatrices(composedMat, translateMatrix(x, y));
                this.scene.setNodeTransform(nodeId, offsetMat);
            } else if (tag === 'ellipse') {
                const cx = parseFloat(el.getAttribute('cx') || '0');
                const cy = parseFloat(el.getAttribute('cy') || '0');
                const rx = parseFloat(el.getAttribute('rx') || '50');
                const ry = parseFloat(el.getAttribute('ry') || '50');
                // Create at origin, then set full transform (center offset baked into matrix)
                nodeId = this.scene.addEllipse(0, 0, rx, ry);
                const offsetMat = composeMatrices(composedMat, translateMatrix(cx, cy));
                this.scene.setNodeTransform(nodeId, offsetMat);
            } else if (tag === 'circle') {
                const cx = parseFloat(el.getAttribute('cx') || '0');
                const cy = parseFloat(el.getAttribute('cy') || '0');
                const r = parseFloat(el.getAttribute('r') || '50');
                nodeId = this.scene.addEllipse(0, 0, r, r);
                const offsetMat = composeMatrices(composedMat, translateMatrix(cx, cy));
                this.scene.setNodeTransform(nodeId, offsetMat);
            } else if (tag === 'text') {
                // Resolve font-size through the CSS cascade
                const inlineStyles = parseInlineStyle(el);
                const fontSize = parseFloat(resolveAttr(el, 'font-size', inlineStyles, mergedStyles, '24') || '24');
                const textX = parseFloat(el.getAttribute('x') || '0');
                const textY = parseFloat(el.getAttribute('y') || '0');

                // Check for <tspan> children
                const tspans = el.querySelectorAll('tspan');
                if (tspans.length > 0) {
                    const tspanIds: number[] = [];
                    for (const tspan of tspans) {
                        const tspanInline = parseInlineStyle(tspan);
                        const tspanStyles = collectInheritedStyles(tspan, mergedStyles);
                        const tx = parseFloat(tspan.getAttribute('x') ?? String(textX));
                        const ty = parseFloat(tspan.getAttribute('y') ?? String(textY));
                        const tfs = parseFloat(resolveAttr(tspan, 'font-size', tspanInline, tspanStyles, String(fontSize)) || String(fontSize));
                        const content = tspan.textContent?.trim() || '';
                        if (!content) continue;
                        const tid = this.scene.addText(0, 0, content, tfs);
                        const tMat = composeMatrices(composedMat, translateMatrix(tx, ty));
                        this.scene.setNodeTransform(tid, tMat);
                        applyStyle(tid, tspan, tspanStyles);
                        createdIds.push(tid);
                        tspanIds.push(tid);
                    }
                    // Group multiple tspan nodes
                    if (tspanIds.length > 1) {
                        const groupName = el.getAttribute('id') || 'Text';
                        groupChildIds(tspanIds, groupName);
                    } else if (tspanIds.length === 1) {
                        const elName = el.getAttribute('id') || el.getAttribute('class');
                        if (elName) {
                            try { this.scene.engine!.set_node_name(tspanIds[0], elName); } catch { /* noop */ }
                        }
                    }
                    return; // tspan IDs already added to createdIds
                }

                // No tspan — use textContent directly
                const content = el.textContent?.trim() || 'Text';
                nodeId = this.scene.addText(0, 0, content, fontSize);
                const offsetMat = composeMatrices(composedMat, translateMatrix(textX, textY));
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
                applyStyle(nodeId, el, mergedStyles);
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
            processElement(child, vbMatrix, rootInherited);
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
            { label: 'Flatten', action: 'flatten', shortcut: '⌘E' },
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
