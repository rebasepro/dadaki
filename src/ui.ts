import type { CanvasKit } from 'canvaskit-wasm';
import type { WasmScene } from './wasm_scene';
import { FileIO } from './file_io';
import type { Color, NodeStyle, Gradient, SceneNode, Paint, Stroke } from './types';
import { isGradient, StrokeAlignment } from './types';
import { hexToRgb, rgbToHex, parseSVGPathD as parseSVGPathDUtil, parseSVGTransform, composeMatrices, transformPoint, identityMatrix, resolveGradientColor, resolveGradient, parseCssColor, parsePreserveAspectRatio, translateMatrix } from './svg_utils';
import { buildSVGFromData, BLEND_MODE_MAP } from './svg_export';
import type { SVGExportInput, FilledFace } from './svg_export';
import type { SVGSubpath, SVGGradientData } from './svg_utils';
import type { ContextBar } from './context_bar';
import type { BreadcrumbBar } from './breadcrumb';
import type { Toolbar } from './toolbar';
import { iconFolder, iconSquare, iconCircle, iconPenTool, iconType, iconHexagon, iconEye, iconEyeOff, iconLock, iconUnlock, iconFlipH, iconFlipV, iconFlatten, iconRotateCW, iconRotateCCW } from './icons';

export class UIEngine {
    ck: CanvasKit;
    scene: WasmScene;
    activeTool: string = 'selection';
    contextBar: ContextBar | null = null;
    breadcrumbBar: BreadcrumbBar | null = null;
    toolbar: Toolbar | null = null;

    /** Tracks whether we've already taken a history snapshot for the current
     *  property-editing gesture (e.g. a color picker drag). */
    private _propertyEditSnapshotTaken: boolean = false;
    /** W/H proportion constraint (the link button between W and H). */
    private aspectLocked: boolean = false;
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
    opacityInput: HTMLInputElement;
    layerList: HTMLElement;
    zoomText: HTMLElement;

    // DOM Elements - dynamic lists
    fillsList: HTMLElement;
    strokesList: HTMLElement;

    addFillBtn: HTMLButtonElement;
    addStrokeBtn: HTMLButtonElement;


    // DOM Elements — extended
    blendMode: HTMLSelectElement;
    cornerRadius: HTMLInputElement;
    propX: HTMLInputElement;
    propY: HTMLInputElement;
    propW: HTMLInputElement;
    propH: HTMLInputElement;
    propRotation: HTMLInputElement;
    propSkewX: HTMLInputElement;
    propSkewY: HTMLInputElement;
    propScaleX: HTMLInputElement;
    propScaleY: HTMLInputElement;

    // DOM Elements — new SVG properties
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

    /** Node ids currently being dragged in the layer panel (the whole selection
     *  when the grabbed row is part of a multi-selection), or null. */
    private _draggingLayerIds: number[] | null = null;

    constructor(ck: CanvasKit, scene: WasmScene) {
        this.ck = ck;
        this.scene = scene;

        // Initialize DOM refs — basic
        this.layerList = document.getElementById('layer-list') as HTMLElement;
        this.zoomText = document.getElementById('zoom-level') as HTMLElement;
        this.opacityInput = document.getElementById('opacity') as HTMLInputElement;

        // Dynamic list containers
        this.fillsList = document.getElementById('fills-list') as HTMLElement;
        this.strokesList = document.getElementById('strokes-list') as HTMLElement;

        
        this.addFillBtn = document.getElementById('add-fill-btn') as HTMLButtonElement;
        this.addStrokeBtn = document.getElementById('add-stroke-btn') as HTMLButtonElement;


        // Initialize DOM refs — extended
        this.blendMode = document.getElementById('blend-mode') as HTMLSelectElement;
        this.cornerRadius = document.getElementById('prop-corner-radius') as HTMLInputElement;
        this.propX = document.getElementById('prop-x') as HTMLInputElement;
        this.propY = document.getElementById('prop-y') as HTMLInputElement;
        this.propW = document.getElementById('prop-w') as HTMLInputElement;
        this.propH = document.getElementById('prop-h') as HTMLInputElement;
        this.propRotation = document.getElementById('prop-rotation') as HTMLInputElement;
        this.propSkewX = document.getElementById('prop-skew-x') as HTMLInputElement;
        this.propSkewY = document.getElementById('prop-skew-y') as HTMLInputElement;
        this.propScaleX = document.getElementById('prop-scale-x') as HTMLInputElement;
        this.propScaleY = document.getElementById('prop-scale-y') as HTMLInputElement;

        // Initialize DOM refs — new SVG properties
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

    /** Figma-style label scrubbing: dragging the label inside a dimension
     *  field adjusts its value (Shift = ×10). One undo snapshot per gesture;
     *  live edits apply without history. A plain click focuses the field. */
    private initScrubbing() {
        document.querySelectorAll<HTMLElement>('.dim-label[data-scrub]').forEach(label => {
            const input = document.getElementById(label.dataset.scrub!) as HTMLInputElement | null;
            if (!input) return;

            label.addEventListener('pointerdown', (e: PointerEvent) => {
                if (input.disabled) return;
                if (this.scene.engine!.get_selection().length === 0) return;
                e.preventDefault();
                try { label.setPointerCapture(e.pointerId); } catch { }

                const startX = e.clientX;
                const startVal = parseFloat(input.value) || 0;
                const step = parseFloat(input.step) || 1;
                const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
                let moved = false;

                const onMove = (ev: PointerEvent) => {
                    const dx = ev.clientX - startX;
                    if (!moved && Math.abs(dx) < 3) return; // click-vs-drag threshold
                    if (!moved) this.scene.beginGesture(); // one undo snapshot for the whole drag
                    moved = true;
                    document.body.classList.add('scrubbing');

                    const mult = ev.shiftKey ? 10 : 1;
                    const val = Math.max(min, startVal + Math.round(dx) * step * mult);
                    const next = String(Math.round(val * 100) / 100);
                    if (next === input.value) return;
                    input.value = next;

                    if (input === this.cornerRadius) {
                        this.applyCornerRadiusToSelection();
                    } else {
                        this.updateTransform(false);
                    }
                };

                const onUp = () => {
                    label.removeEventListener('pointermove', onMove);
                    label.removeEventListener('pointerup', onUp);
                    label.removeEventListener('pointercancel', onUp);
                    document.body.classList.remove('scrubbing');
                    if (moved) {
                        this.scene.endGesture();
                        this.syncWithSelection({ interactive: true });
                    } else {
                        input.focus();
                        input.select();
                    }
                };

                label.addEventListener('pointermove', onMove);
                label.addEventListener('pointerup', onUp);
                label.addEventListener('pointercancel', onUp);
            });
        });
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
        // (Toolbar clicks are wired by the Toolbar class itself — see toolbar.ts)

        // Style properties — coalesced undo: one snapshot per gesture
        const styleInputs = [
            this.opacityInput, this.blendMode,
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
        const transformInputs = [this.propX, this.propY, this.propW, this.propH, this.propRotation, this.propSkewX, this.propSkewY, this.propScaleX, this.propScaleY];
        for (const el of transformInputs) {
            if (el) el.addEventListener('change', () => this.updateTransform());
        }

        // Shift+Arrow = ±10 on all dimension fields (Figma convention).
        // Setting the value and dispatching 'change' reuses each field's handler.
        for (const el of [...transformInputs, this.cornerRadius]) {
            if (!el) continue;
            el.addEventListener('keydown', (e: KeyboardEvent) => {
                if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                e.preventDefault();
                const min = el.min !== '' ? parseFloat(el.min) : -Infinity;
                const cur = parseFloat(el.value) || 0;
                el.value = String(Math.max(min, cur + (e.key === 'ArrowUp' ? 10 : -10)));
                el.dispatchEvent(new Event('change'));
            });
        }

        // Constrain-proportions toggle between W and H
        const aspectBtn = document.getElementById('aspect-lock');
        aspectBtn?.addEventListener('click', () => {
            this.aspectLocked = !this.aspectLocked;
            aspectBtn.classList.toggle('active', this.aspectLocked);
            aspectBtn.title = this.aspectLocked ? 'Remove proportion constraint' : 'Constrain proportions';
        });

        this.initScrubbing();

        // Quick transform actions: rotate 90°, flip, flatten. One undo step
        // for the whole selection via transaction().
        const bindAction = (btnId: string, icon: string, fn: (id: number) => void) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.innerHTML = icon;
            btn.addEventListener('click', () => {
                const sel = this.scene.engine!.get_selection();
                if (sel.length === 0) return;
                this.scene.transaction(() => { for (const id of sel) fn(id); });
                this.syncWithSelection();
            });
        };
        // Normalize to (-180, 180] so repeated quarter-turns don't accumulate
        // into display values like 450°.
        const rotateBy = (id: number, delta: number) => {
            const tc = this.scene.getNodeTransformComponents(id);
            const deg = ((tc.rotation_deg + delta + 180) % 360 + 360) % 360 - 180;
            this.scene.engine!.set_node_rotation(id, deg);
        };
        bindAction('rotate-ccw-btn', iconRotateCCW(12), id => rotateBy(id, -90));
        bindAction('rotate-cw-btn', iconRotateCW(12), id => rotateBy(id, 90));
        bindAction('flip-h-btn', iconFlipH(12), id => this.scene.flipNodeH(id));
        bindAction('flip-v-btn', iconFlipV(12), id => this.scene.flipNodeV(id));
        bindAction('flatten-btn', iconFlatten(12), id => this.scene.flattenTransform(id));

        // Visibility toggle
        this.toggleVisible?.addEventListener('click', () => {
            this.toggleNodeVisibility();
        });

        // Locked toggle
        this.toggleLocked?.addEventListener('click', () => {
            this.toggleNodeLocked();
        });


        const forceExpand = (sectionName: string) => {
            const body = document.querySelector(`[data-section-body="${sectionName}"]`);
            const header = document.querySelector(`.panel-section-header[data-section="${sectionName}"]`);
            const chevron = header?.querySelector('.chevron');
            if (body && body.classList.contains('collapsed')) {
                body.classList.remove('collapsed');
                chevron?.classList.remove('collapsed');
            }
        };

        this.addFillBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            const selection = this.scene.engine!.get_selection();
            if (selection.length === 0) return;
            const node = this.scene.getNode(selection[0]);
            if (!node) return;
            forceExpand('fill');
            const currentFills = this.getFills(node);
            this.updateNodeStyle(node, { fills: [...currentFills, { r: 0.8, g: 0.8, b: 0.8, a: 1 }] });
        });

        this.addStrokeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            const selection = this.scene.engine!.get_selection();
            if (selection.length === 0) return;
            const node = this.scene.getNode(selection[0]);
            if (!node) return;
            forceExpand('stroke');
            const currentStrokes = this.getStrokes(node);
            this.updateNodeStyle(node, { strokes: [...currentStrokes, {
                paint: { r: 0, g: 0, b: 0, a: 1 },
                width: 1,
                cap: 0,
                join: 0,
                dash_array: [],
                dash_offset: 0,
                miter_limit: 4,
                alignment: StrokeAlignment.Center
            }] });
        });


        // Undo / Redo (header — global actions, deliberately not in the context bar)
        document.getElementById('undo-btn')?.addEventListener('click', () => {
            this.scene.undo();
            this.syncWithSelection();
            this.updateLayerList();
        });
        document.getElementById('redo-btn')?.addEventListener('click', () => {
            this.scene.redo();
            this.syncWithSelection();
            this.updateLayerList();
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
        this.toolbar?.sync(toolId);

        // Exit path/text editing when switching tools to clear dimming
        const im = this.scene.renderer?.inputManager;
        if (im && im.editingNodeId !== null) {
            im.exitEditMode();
        }

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
    
    updateActiveFillColor(hex: string) {
        const c = this.hexToRgb(hex);
        const selection = this.scene.engine!.get_selection();
        if (selection.length > 0) {
            const node = this.scene.getNode(selection[0]);
            if (node) {
                const newFills = node.style.fills ? [...node.style.fills] : [];
                if (newFills.length === 0) newFills.push(c);
                else if (!isGradient(newFills[0])) newFills[0] = c;
                else if ((newFills[0] as Gradient).stops.length > 0) (newFills[0] as Gradient).stops[0].color = c;
                this.updateNodeStyle(node, { fills: newFills });
            }
        } else {
            // Update default style if nothing selected
            try {
                const s = JSON.parse(this._currentStyleJson || "{}");
                if (!s.fills) s.fills = [];
                if (s.fills.length === 0) s.fills.push(c);
                else s.fills[0] = c;
                this._currentStyleJson = JSON.stringify(s);
            } catch {}
        }
        this.contextBar?.refresh();
    }

    getActiveStrokeColor(): Color {
        try {
            const s = JSON.parse(this.getCurrentStyle());
            if (s.strokes && s.strokes.length > 0 && s.strokes[0].paint) {
                if (isGradient(s.strokes[0].paint) && s.strokes[0].paint.stops.length > 0) return s.strokes[0].paint.stops[0].color;
                if (!isGradient(s.strokes[0].paint)) return s.strokes[0].paint;
            }
        } catch {}
        return { r: 0, g: 0, b: 0, a: 1 };
    }

    updateActiveStrokeColor(hex: string) {
        const c = this.hexToRgb(hex);
        const selection = this.scene.engine!.get_selection();
        if (selection.length > 0) {
            const node = this.scene.getNode(selection[0]);
            if (node) {
                const newStrokes = node.style.strokes ? [...node.style.strokes] : [];
                if (newStrokes.length === 0) newStrokes.push({ paint: c, width: 1, cap: 0, join: 0, dash_array: [], dash_offset: 0, miter_limit: 4, alignment: StrokeAlignment.Center });
                else if (newStrokes[0].paint && !isGradient(newStrokes[0].paint)) newStrokes[0].paint = c;
                else if ((newStrokes[0].paint as Gradient).stops.length > 0) (newStrokes[0].paint as Gradient).stops[0].color = c;
                this.updateNodeStyle(node, { strokes: newStrokes });
            }
        } else {
            try {
                const s = JSON.parse(this._currentStyleJson || "{}");
                if (!s.strokes) s.strokes = [];
                if (s.strokes.length === 0) s.strokes.push({ paint: c, width: 1, cap: 0, join: 0, dash_array: [], dash_offset: 0, miter_limit: 4, alignment: StrokeAlignment.Center });
                else s.strokes[0].paint = c;
                this._currentStyleJson = JSON.stringify(s);
            } catch {}
        }
        this.contextBar?.refresh();
    }
    
    getActiveFillColor(): Color {
        try {
            const s = JSON.parse(this.getCurrentStyle());
            if (s.fills && s.fills.length > 0) return s.fills[0];
        } catch {}
        return { r: 66/255, g: 133/255, b: 244/255, a: 1 };
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
        return this._currentStyleJson || JSON.stringify({
            fills: [{ r: 0.8, g: 0.8, b: 0.8, a: 1.0 }],
            strokes: [{ paint: { r: 0, g: 0, b: 0, a: 1.0 }, width: 2, cap: 0, join: 0, dash_array: [], dash_offset: 0, miter_limit: 4, alignment: StrokeAlignment.Center }],
            opacity: (parseFloat(this.opacityInput?.value) || 100) / 100,
            blend_mode: this.blendMode ? parseInt(this.blendMode.value) || 0 : 0,
            corner_radius: this.cornerRadius ? parseFloat(this.cornerRadius.value) || 0 : 0,
        });
    }

    /** Get the current ("last used") style as a JSON string.
     *  Applied to newly created shapes. Persists across deselection —
     *  it is NOT derived from the panel widgets at call time, because those
     *  get repopulated from whatever is selected. */
    getCurrentStyle(): string {
        return this._currentStyleJson ?? this.buildCurrentStyleJson();
    }

    /** Write a transform field and remember what was written, so change events
     *  can tell a real user edit from an untouched (rounded) display value. */
    private syncField(input: HTMLInputElement | null, value: string) {
        if (!input) return;
        input.value = value;
        input.dataset.synced = value;
    }

    /** True when the user actually changed this field since the last sync. */
    private fieldEdited(input: HTMLInputElement | null): boolean {
        return !!input && input.value !== input.dataset.synced;
    }

    /** Current visual size of a node, full precision — the same measure the
     *  panel displays and resizeNode targets (resolved rounded outline for paths). */
    private getNodeDisplaySize(node: SceneNode, id: number): { w: number; h: number } | null {
        if (node.geometry.Rect) {
            return { w: node.geometry.Rect.width, h: node.geometry.Rect.height };
        }
        if (node.geometry.Ellipse) {
            return { w: node.geometry.Ellipse.radius_x * 2, h: node.geometry.Ellipse.radius_y * 2 };
        }
        if (node.geometry.Path) {
            const resolved = this.scene.getResolvedSubpaths(id);
            const b = this.scene.renderer?.calculatePathBounds({ subpaths: resolved });
            if (b && b.maxX > b.minX && b.maxY > b.minY) {
                return { w: b.maxX - b.minX, h: b.maxY - b.minY };
            }
            return null;
        }
        return null;
    }

    /** Convert a world-space translation delta into the delta to add to the
     *  node's LOCAL translation, undoing the parent's linear transform. For a
     *  top-level node (identity parent) this is a no-op passthrough. */
    private worldDeltaToLocal(id: number, wdx: number, wdy: number): [number, number] {
        const parentId = this.scene.getNodeParent(id);
        if (parentId < 0) return [wdx, wdy]; // top-level: parent is identity
        const p = this.scene.getTransform(parentId); // row-major global
        const a = p[0], b = p[1], c = p[3], d = p[4];
        const det = a * d - b * c;
        if (Math.abs(det) < 1e-9) return [wdx, wdy];
        return [(d * wdx - b * wdy) / det, (-c * wdx + a * wdy) / det];
    }

    updateTransform(pushHistory: boolean = true) {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;

        const id = selection[0];
        const node = this.scene.getNode(id);
        if (!node) return;

        // Only write the components the user actually edited. Writing back
        // untouched fields would quantize the exact stored values to the
        // rounded display strings (and spuriously resize on rotation edits).
        const anyEdit = [this.propX, this.propY, this.propW, this.propH,
            this.propRotation, this.propSkewX, this.propSkewY,
            this.propScaleX, this.propScaleY]
            .some(i => this.fieldEdited(i));
        if (!anyEdit) return;

        const applyEdits = () => {
            // Position — the fields hold the bounding box top-left, so move by
            // the world-space delta from the current bounds, not by setting the
            // transform origin absolutely (which flip/rotation would offset).
            if (this.fieldEdited(this.propX) || this.fieldEdited(this.propY)) {
                const b = this.scene.getNodeBounds(id);
                const worldDx = this.fieldEdited(this.propX)
                    ? (parseFloat(this.propX!.value) || 0) - b[0] : 0;
                const worldDy = this.fieldEdited(this.propY)
                    ? (parseFloat(this.propY!.value) || 0) - b[1] : 0;
                const [ldx, ldy] = this.worldDeltaToLocal(id, worldDx, worldDy);
                this.scene.moveNode(id, ldx, ldy);
            }

            // Size (W/H) — the untouched axis keeps its exact current size
            // (the field only shows a rounded value).
            if (this.fieldEdited(this.propW) || this.fieldEdited(this.propH)) {
                const cur = this.getNodeDisplaySize(node, id);
                let newW = this.fieldEdited(this.propW)
                    ? (parseFloat(this.propW!.value) || 0) : (cur?.w ?? 0);
                let newH = this.fieldEdited(this.propH)
                    ? (parseFloat(this.propH!.value) || 0) : (cur?.h ?? 0);
                // Proportion constraint: editing one axis scales the other.
                if (this.aspectLocked && cur && cur.w > 0 && cur.h > 0) {
                    if (this.fieldEdited(this.propW) && !this.fieldEdited(this.propH)) {
                        newH = newW * (cur.h / cur.w);
                    } else if (this.fieldEdited(this.propH) && !this.fieldEdited(this.propW)) {
                        newW = newH * (cur.w / cur.h);
                    }
                }
                if (newW > 0 && newH > 0) {
                    this.scene.resizeNode(id, newW, newH);
                }
            }

            // Rotation / skew / scale — components are canonical in the engine.
            if (this.fieldEdited(this.propRotation)) {
                this.scene.engine!.set_node_rotation(id, parseFloat(this.propRotation!.value) || 0);
            }
            if (this.fieldEdited(this.propSkewX) || this.fieldEdited(this.propSkewY)) {
                const tc = this.scene.getNodeTransformComponents(id);
                const skewX = this.fieldEdited(this.propSkewX)
                    ? (parseFloat(this.propSkewX!.value) || 0) : tc.skew_x_deg;
                const skewY = this.fieldEdited(this.propSkewY)
                    ? (parseFloat(this.propSkewY!.value) || 0) : tc.skew_y_deg;
                this.scene.engine!.set_node_skew(id, skewX, skewY);
            }
            if (this.fieldEdited(this.propScaleX) || this.fieldEdited(this.propScaleY)) {
                const tc = this.scene.getNodeTransformComponents(id);
                // Percent fields; empty or ~0 entries keep the current factor
                // (scale 0 would collapse the matrix irrecoverably). Negative
                // values are legal — that's a flip.
                const parseScale = (el: HTMLInputElement, cur: number) => {
                    const v = (parseFloat(el.value) || 0) / 100;
                    return Math.abs(v) > 0.001 ? v : cur;
                };
                const sx = this.fieldEdited(this.propScaleX)
                    ? parseScale(this.propScaleX!, tc.scale_x) : tc.scale_x;
                const sy = this.fieldEdited(this.propScaleY)
                    ? parseScale(this.propScaleY!, tc.scale_y) : tc.scale_y;
                this.scene.engine!.set_node_scale(id, sx, sy);
            }
        };

        // One undo step per edit: transaction() snapshots once and suppresses
        // the inner wrappers' own pushes. Scrub gestures (pushHistory=false)
        // already run inside a beginGesture()/endGesture() bracket.
        if (pushHistory) this.scene.transaction(applyEdits);
        else applyEdits();

        this.scene.invalidateCache();
        // Full field re-sync so values and the per-field synced markers reflect
        // what the engine actually stored (resize may clamp, radius may cap).
        this.syncWithSelection({ interactive: true });
        this.updateLayerList();
    }

    syncWithSelection(opts: { interactive?: boolean } = {}) {
        const interactive = opts.interactive === true;
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

        this.opacityInput.value = ((style.opacity !== undefined ? style.opacity : 1) * 100).toFixed(0);
        if (this.blendMode) this.blendMode.value = (style.blend_mode || 0).toString();

        // Corner radius: the field is always present (Figma-style); it is
        // disabled/dimmed when the selected geometry doesn't support it.
        const cornerRadiusCell = document.getElementById('corner-radius-cell');
        const im = this.scene.renderer?.inputManager;
        const radiusSupported = !!(node.geometry.Rect || node.geometry.Path);
        if (this.cornerRadius) {
            this.cornerRadius.disabled = !radiusSupported;
            this.cornerRadius.placeholder = '';
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
            } else {
                this.cornerRadius.value = '';
            }
        }
        cornerRadiusCell?.classList.toggle('disabled', !radiusSupported);

        if (this.toggleVisible) this.toggleVisible.classList.toggle('active', node.visible !== false);
        if (this.toggleLocked) this.toggleLocked.classList.toggle('active', node.locked === true);

        // X/Y show the top-left of the world-space bounding box (Figma-style),
        // which matches the on-screen selection rectangle — not the transform
        // origin, which drifts under rotation/flip.
        const b = this.scene.getNodeBounds(selection[0]);
        this.syncField(this.propX, Math.round(b[0]).toString());
        this.syncField(this.propY, Math.round(b[1]).toString());

        // W/H shows the same measure resizeNode targets: geometry size for
        // rects/ellipses, resolved (corner-rounded) outline size for paths.
        const size = this.getNodeDisplaySize(node, selection[0]);
        if (size) {
            this.syncField(this.propW, Math.round(size.w).toString());
            this.syncField(this.propH, Math.round(size.h).toString());
        }

        {
            const tc = this.scene.getNodeTransformComponents(selection[0]);
            this.syncField(this.propRotation, Math.round(tc.rotation_deg).toString());
            this.syncField(this.propSkewX,
                Math.abs(tc.skew_x_deg) < 0.05 ? '0' : tc.skew_x_deg.toFixed(1));
            this.syncField(this.propSkewY,
                Math.abs(tc.skew_y_deg) < 0.05 ? '0' : tc.skew_y_deg.toFixed(1));
            this.syncField(this.propScaleX, String(Math.round(tc.scale_x * 100)));
            this.syncField(this.propScaleY, String(Math.round(tc.scale_y * 100)));
        }

        if (!interactive) {
            this.updateLayerList();
            this.contextBar?.refresh();
            this.breadcrumbBar?.refresh();
        }
        
        if (node.geometry.Text) {
            if (this.typographySection) this.typographySection.style.display = '';
            if (this.textFontFamily) this.textFontFamily.value = node.geometry.Text.font_family || '';
            if (this.textFontSize) this.textFontSize.value = String(node.geometry.Text.font_size || 32);
            if (this.textLineHeight) this.textLineHeight.value = String(node.geometry.Text.line_height || 1.2);
            if (this.textAlign) this.textAlign.value = String(node.geometry.Text.text_align || 0);
        } else {
            if (this.typographySection) this.typographySection.style.display = 'none';
        }
        
        // Render dynamic lists
        this.renderFillsList(node);
        this.renderStrokesList(node);

    }


    /** Clear the property panel (when nothing is selected). Show the CURRENT style (what a newly drawn
     *  shape will get) in the style controls and blank the transform fields. */
    private clearPropertyPanel() {
        try {
            const s = JSON.parse(this.getCurrentStyle());
            this.opacityInput.value = String(Math.round((s.opacity ?? 1) * 100));
            if (this.blendMode) this.blendMode.value = String(s.blend_mode ?? 0);
        } catch { }
        if (this.propX) this.propX.value = '';
        if (this.propY) this.propY.value = '';
        if (this.propW) this.propW.value = '';
        if (this.propH) this.propH.value = '';
        if (this.propRotation) this.propRotation.value = '';
        if (this.propSkewX) this.propSkewX.value = '';
        if (this.propSkewY) this.propSkewY.value = '';
        if (this.propScaleX) this.propScaleX.value = '';
        if (this.propScaleY) this.propScaleY.value = '';
        if (this.cornerRadius) {
            this.cornerRadius.value = '';
            this.cornerRadius.placeholder = '';
            this.cornerRadius.disabled = true;
        }
        if (this.toggleVisible) this.toggleVisible.classList.remove('active');
        if (this.toggleLocked) this.toggleLocked.classList.remove('active');
        if (this.typographySection) this.typographySection.style.display = 'none';
        document.getElementById('corner-radius-cell')?.classList.add('disabled');
        
        if (this.fillsList) this.fillsList.innerHTML = '';
        if (this.strokesList) this.strokesList.innerHTML = '';

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


    private getFills(node: SceneNode): Paint[] {
        return node.style.fills || [];
    }

    private getStrokes(node: SceneNode): Stroke[] {
        return node.style.strokes || [];
    }

        renderFillsList(node: SceneNode) {
        if (!this.fillsList) return;
        this.fillsList.innerHTML = '';
        const fills = this.getFills(node);
        
        fills.forEach((fill: any, index: number) => {
            const row = document.createElement('div');
            row.className = 'fill-stroke-row';
            
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.className = 'color-input';
            const currentColor = isGradient(fill) && fill.stops.length > 0 ? fill.stops[0].color : (!isGradient(fill) ? fill : {r:0, g:0, b:0, a:1});
            colorInput.value = this.rgbToHex(currentColor);
            
            const hexInput = document.createElement('input');
            hexInput.type = 'text';
            hexInput.className = 'prop-input';
            hexInput.style.width = '60px';
            hexInput.style.flex = '0 0 60px';
            hexInput.value = this.rgbToHex(currentColor).toUpperCase();

            colorInput.addEventListener('input', () => {
                const newFills = [...fills];
                const c = this.hexToRgb(colorInput.value);
                hexInput.value = colorInput.value.toUpperCase();
                if (isGradient(newFills[index])) {
                    if ((newFills[index] as Gradient).stops.length > 0) {
                        (newFills[index] as Gradient).stops[0].color = c;
                    }
                } else {
                    newFills[index] = c;
                }
                this.updateNodeStyle(node, { fills: newFills }, true);
            });

            hexInput.addEventListener('change', () => {
                const val = hexInput.value.startsWith('#') ? hexInput.value : '#' + hexInput.value;
                if (/^#[0-9A-F]{6}$/i.test(val)) {
                    colorInput.value = val;
                    const newFills = [...fills];
                    const c = this.hexToRgb(val);
                    if (isGradient(newFills[index])) {
                        if ((newFills[index] as Gradient).stops.length > 0) {
                            (newFills[index] as Gradient).stops[0].color = c;
                        }
                    } else {
                        newFills[index] = c;
                    }
                    this.updateNodeStyle(node, { fills: newFills });
                }
            });
            
            const delBtn = document.createElement('button');
            delBtn.className = 'icon-toggle';
            delBtn.innerHTML = '×';
            delBtn.title = 'Remove Fill';
            delBtn.onclick = () => {
                const newFills = fills.filter((_: any, i: number) => i !== index);
                this.updateNodeStyle(node, { fills: newFills });
            };

            row.appendChild(colorInput);
            row.appendChild(hexInput);
            const spacer = document.createElement('div');
            spacer.style.flex = '1';
            row.appendChild(spacer);
            row.appendChild(delBtn);
            this.fillsList.appendChild(row);
        });
    }

        renderStrokesList(node: SceneNode) {
        if (!this.strokesList) return;
        this.strokesList.innerHTML = '';
        const strokes = this.getStrokes(node);
        
        strokes.forEach((stroke: any, index: number) => {
            const row = document.createElement('div');
            row.className = 'fill-stroke-row';
            
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.className = 'color-input';
            const currentPaint = stroke.paint || {r:0, g:0, b:0, a:1};
            const currentColor = isGradient(currentPaint) && currentPaint.stops.length > 0 ? currentPaint.stops[0].color : (!isGradient(currentPaint) ? currentPaint : {r:0, g:0, b:0, a:1});
            colorInput.value = this.rgbToHex(currentColor);
            
            const hexInput = document.createElement('input');
            hexInput.type = 'text';
            hexInput.className = 'prop-input';
            hexInput.style.width = '60px';
            hexInput.style.flex = '0 0 60px';
            hexInput.value = this.rgbToHex(currentColor).toUpperCase();

            colorInput.addEventListener('input', () => {
                const newStrokes = [...strokes];
                const c = this.hexToRgb(colorInput.value);
                hexInput.value = colorInput.value.toUpperCase();
                if (stroke.paint && isGradient(stroke.paint)) {
                    if (stroke.paint.stops.length > 0) {
                        stroke.paint.stops[0].color = c;
                    }
                } else {
                    newStrokes[index].paint = c;
                }
                this.updateNodeStyle(node, { strokes: newStrokes }, true);
            });

            hexInput.addEventListener('change', () => {
                const val = hexInput.value.startsWith('#') ? hexInput.value : '#' + hexInput.value;
                if (/^#[0-9A-F]{6}$/i.test(val)) {
                    colorInput.value = val;
                    const newStrokes = [...strokes];
                    const c = this.hexToRgb(val);
                    if (stroke.paint && isGradient(stroke.paint)) {
                        if (stroke.paint.stops.length > 0) {
                            stroke.paint.stops[0].color = c;
                        }
                    } else {
                        newStrokes[index].paint = c;
                    }
                    this.updateNodeStyle(node, { strokes: newStrokes });
                }
            });

            const wInput = document.createElement('input');
            wInput.type = 'number';
            wInput.className = 'prop-input';
            wInput.value = String(stroke.width);
            wInput.step = '0.5';
            wInput.min = '0';
            wInput.style.width = '36px';
            wInput.style.flex = '0 0 36px';
            wInput.addEventListener('input', () => {
                const newStrokes = [...strokes];
                newStrokes[index].width = parseFloat(wInput.value) || 0;
                this.updateNodeStyle(node, { strokes: newStrokes }, true);
            });

            const alignSelect = document.createElement('select');
            alignSelect.className = 'prop-select';
            alignSelect.style.width = '60px';
            alignSelect.style.flex = '0 0 60px';
            alignSelect.innerHTML = `
                <option value="Center">Ctr</option>
                <option value="Inner">In</option>
                <option value="Outer">Out</option>
            `;
            alignSelect.value = stroke.alignment || 'Center';
            alignSelect.addEventListener('change', () => {
                const newStrokes = [...strokes];
                newStrokes[index].alignment = alignSelect.value as unknown as StrokeAlignment;
                this.updateNodeStyle(node, { strokes: newStrokes });
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'icon-toggle';
            delBtn.innerHTML = '×';
            delBtn.title = 'Remove Stroke';
            delBtn.onclick = () => {
                const newStrokes = strokes.filter((_: any, i: number) => i !== index);
                this.updateNodeStyle(node, { strokes: newStrokes });
            };

            row.appendChild(colorInput);
            row.appendChild(hexInput);
            row.appendChild(wInput);
            row.appendChild(alignSelect);
            row.appendChild(delBtn);
            this.strokesList.appendChild(row);
        });
    }


    private updateNodeStyle(_node: SceneNode, styleOverrides: Partial<NodeStyle>, skipSync: boolean = false) {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;

        const applyToNodeAndChildren = (id: number) => {
            const targetNode = this.scene.getNode(id);
            if (!targetNode) return;

            const newStyle = { ...targetNode.style, ...styleOverrides };
            this.scene.setNodeStyleNoHistory(id, JSON.stringify(newStyle));

            const nodeTypeNum = this.scene.getNodeType(id);
            if (nodeTypeNum !== undefined && UIEngine.NODE_TYPE_KEY[nodeTypeNum] === 'Group') {
                const children = this.scene.getNodeChildren(id);
                if (children) {
                    for (const childId of children) {
                        applyToNodeAndChildren(childId);
                    }
                }
            }
        };

        for (const id of selection) {
            applyToNodeAndChildren(id);
        }

        this.scene.saveMoveHistory();
        if (!skipSync) this.syncWithSelection();
    }



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
                // Leaving path-edit mode when selecting a different node clears dimming.
                const im = this.scene.renderer?.inputManager;
                if (im && im.editingNodeId !== null && im.editingNodeId !== id) {
                    im.exitEditMode();
                }
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

            // Drag-and-drop reordering
            item.draggable = true;
            item.addEventListener('dragstart', (e) => {
                // If the grabbed row is part of a multi-selection, drag the whole
                // selection; otherwise just this row.
                const selection = Array.from(this.scene.getSelection());
                const dragIds = selection.length > 1 && selection.includes(id) ? selection : [id];
                this._draggingLayerIds = dragIds;
                this._markDraggingLayers(dragIds);
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    // Firefox needs data set for the drag to begin.
                    e.dataTransfer.setData('text/plain', dragIds.join(','));
                }
            });
            item.addEventListener('dragend', () => {
                this._draggingLayerIds = null;
                this._clearLayerDropIndicators();
                this.layerList.querySelectorAll('.layer-item.dragging')
                    .forEach(el => el.classList.remove('dragging'));
            });
            item.addEventListener('dragover', (e) => {
                const dragIds = this._draggingLayerIds;
                if (!dragIds || this._isInvalidDropTarget(id, dragIds)) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                const zone = this._computeLayerDropZone(row, isGroup, e);
                this._clearLayerDropIndicators();
                row.classList.add(zone === 'into' ? 'drop-into' : zone === 'above' ? 'drop-above' : 'drop-below');
            });
            item.addEventListener('drop', (e) => {
                const dragIds = this._draggingLayerIds;
                if (!dragIds || this._isInvalidDropTarget(id, dragIds)) return;
                e.preventDefault();
                e.stopPropagation();
                const zone = this._computeLayerDropZone(row, isGroup, e);
                this._clearLayerDropIndicators();
                this._draggingLayerIds = null;
                this._performLayerDrop(dragIds, id, zone);
            });

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

        // A draggable ancestor blocks caret placement inside the input in some
        // browsers; disable dragging on the row while renaming.
        const item = nameEl.closest('.layer-item') as HTMLElement | null;
        if (item) {
            item.draggable = false;
            input.addEventListener('blur', () => { item.draggable = true; }, { once: true });
        }
    }

    /** True if `nodeId` is `ancestorId` itself or nested somewhere beneath it. */
    private _isLayerDescendant(nodeId: number, ancestorId: number): boolean {
        let cur = this.scene.getNodeParent(nodeId);
        while (cur !== -1) {
            if (cur === ancestorId) return true;
            cur = this.scene.getNodeParent(cur);
        }
        return false;
    }

    /** A drop target is invalid if it's one of the dragged nodes or sits inside
     *  one of them (can't drop a node into its own subtree). */
    private _isInvalidDropTarget(targetId: number, draggedIds: number[]): boolean {
        return draggedIds.some(d => d === targetId || this._isLayerDescendant(targetId, d));
    }

    /** Add the `dragging` class to every layer row in `ids`. */
    private _markDraggingLayers(ids: number[]) {
        const set = new Set(ids);
        this.layerList.querySelectorAll('.layer-item').forEach(el => {
            const nid = Number((el as HTMLElement).dataset.nodeId);
            if (set.has(nid)) el.classList.add('dragging');
        });
    }

    /** Flattened scene draw order (bottom-up: back to front), used to preserve
     *  the relative z-order of a multi-selection when it's moved. */
    private _flattenDrawOrder(): number[] {
        const out: number[] = [];
        const walk = (ids: Uint32Array) => {
            for (const id of ids) {
                out.push(id);
                const children = this.scene.getNodeChildren(id);
                if (children.length) walk(children);
            }
        };
        walk(this.scene.getRootNodes());
        return out;
    }

    /** Remove any drag drop-indicator classes from the layer list. */
    private _clearLayerDropIndicators() {
        this.layerList.querySelectorAll('.drop-above, .drop-below, .drop-into')
            .forEach(el => el.classList.remove('drop-above', 'drop-below', 'drop-into'));
    }

    /**
     * Decide whether a drop over `row` should place the node above the target,
     * below it, or (for group targets) inside it, based on the pointer's
     * vertical position within the row.
     */
    private _computeLayerDropZone(row: HTMLElement, isGroup: boolean, e: DragEvent): 'above' | 'below' | 'into' {
        const rect = row.getBoundingClientRect();
        const f = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
        if (isGroup && f > 0.3 && f < 0.7) return 'into';
        return f < 0.5 ? 'above' : 'below';
    }

    /**
     * Apply a layer-panel drag drop: move `draggedIds` relative to `targetId`.
     * The layer list renders top-to-bottom (highest z first), while the engine's
     * child order is bottom-up, so a visual "above" maps to a higher vec index.
     */
    private _performLayerDrop(draggedIds: number[], targetId: number, zone: 'above' | 'below' | 'into') {
        // Drop nodes whose ancestor is also being dragged (a selected group
        // carries its children), then order them by draw order (bottom-up) so
        // their relative stacking is preserved after the move.
        const deduped = new Set(this.scene.dedupSelection(draggedIds));
        if (deduped.size === 0) return;
        if (this._isInvalidDropTarget(targetId, [...deduped])) return;
        const ordered = this._flattenDrawOrder().filter(id => deduped.has(id));
        if (ordered.length === 0) return;

        let newParent: number | null;
        let index: number;

        if (zone === 'into') {
            // Drop as the top-most (highest z) children of the target group.
            newParent = targetId;
            const children = Array.from(this.scene.getNodeChildren(targetId)).filter(c => !deduped.has(c));
            index = children.length;
        } else {
            // Reorder as siblings of the target.
            const tParent = this.scene.getNodeParent(targetId);
            newParent = tParent === -1 ? null : tParent;
            const sibs = (newParent === null
                ? Array.from(this.scene.getRootNodes())
                : Array.from(this.scene.getNodeChildren(newParent))
            ).filter(c => !deduped.has(c));
            const tIdx = sibs.indexOf(targetId);
            if (tIdx === -1) return;
            // Visually "above" the target = higher z = after it in the bottom-up vec.
            index = zone === 'above' ? tIdx + 1 : tIdx;
        }

        if (this.scene.reorderNodes(ordered, newParent, index) > 0) {
            // Reveal the result when dropping into a collapsed group.
            if (zone === 'into') this._collapsedGroups.delete(targetId);
            this.updateLayerList();
            this.syncWithSelection();
        }
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

    public rgbToHex(color: { r: number; g: number; b: number }): string {
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
