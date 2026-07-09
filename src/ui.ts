import type { CanvasKit } from 'canvaskit-wasm';
import type { WasmScene } from './wasm_scene';
import { FileIO } from './file_io';
import type { Color, NodeStyle, Gradient, GradientStop, SceneNode, Paint, Stroke, Artboard } from './types';
import { isGradient, isPattern, StrokeAlignment } from './types';
import { hexToRgb, rgbToHex, parseSVGPathD as parseSVGPathDUtil, parseSVGTransform, composeMatrices, transformPoint, identityMatrix, resolveGradientColor, resolveGradient, parseCssColor, parsePreserveAspectRatio, translateMatrix, scaleMatrix, parseSvgLength } from './svg_utils';
import type { GradientGeo } from './svg_utils';
import { buildSVGFromData, BLEND_MODE_MAP } from './svg_export';
import { parseSvgStylesheet, matchedCssStyles } from './svg_css';
import type { CssDecl } from './svg_css';
import type { SVGExportInput, FilledFace, LivePaintRenderData } from './svg_export';
import type { SVGSubpath, SVGGradientData } from './svg_utils';
import type { ContextBar } from './context_bar';
import type { Toolbar } from './toolbar';
import { iconFolder, iconSquare, iconCircle, iconPenTool, iconType, iconHexagon, iconEye, iconEyeOff, iconLock, iconUnlock, iconFlipH, iconFlipV, iconFlatten, iconRotateCW, iconRotateCCW, iconFrame } from './icons';

/** Minimal HTML escaper for names rendered via innerHTML templates. */
function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
import { GradientEditController, sampleGradientColor } from './gradient_edit';
import { createColorSwatch } from './color_picker';

/** Element tags a <clipPath> may legally contain (basic shapes, text, use).
 *  image/switch/symbol/etc. are invalid clip children and are ignored. */
const CLIP_CHILD_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'text', 'use']);

export class UIEngine {
    ck: CanvasKit;
    scene: WasmScene;
    activeTool: string = 'selection';
    /** When true, a creation tool stays active after drawing instead of
     *  reverting to the Selection tool (Figma one-shot). Set by double-clicking
     *  the tool in the toolbar; cleared whenever a tool is picked normally. */
    toolLocked: boolean = false;
    /** Shared gradient-editing state (panel ramp + on-canvas handles). */
    gradientEdit: GradientEditController;
    contextBar: ContextBar | null = null;
    toolbar: Toolbar | null = null;

    /** Tracks whether we've already taken a history snapshot for the current
     *  property-editing gesture (e.g. a color picker drag). */
    private _propertyEditSnapshotTaken: boolean = false;
    /** W/H proportion constraint (the link button between W and H). */
    private aspectLocked: boolean = false;
    /** Last style the user configured — applied to newly created shapes. */
    private _currentStyleJson: string | null = null;

    /** Named 4×5 color-matrix presets for the Color effect (row-major 20 floats). */
    private static readonly COLOR_PRESETS: Record<string, number[]> = {
        grayscale: [0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0, 0, 0, 1, 0],
        sepia: [0.393, 0.769, 0.189, 0, 0, 0.349, 0.686, 0.168, 0, 0, 0.272, 0.534, 0.131, 0, 0, 0, 0, 0, 1, 0],
        invert: [-1, 0, 0, 0, 1, 0, -1, 0, 0, 1, 0, 0, -1, 0, 1, 0, 0, 0, 1, 0],
        saturate: [0.6063, 0.3575, 0.0361, 0, 0, 0.1065, 0.8575, 0.0361, 0, 0, 0.1065, 0.3575, 0.5361, 0, 0, 0, 0, 0, 1, 0], // ~1.8×
    };

    // Static lookup tables (avoid re-creation each call)
    private static readonly ICON_MAP: Record<string, () => string> = {
        'Group': () => iconFolder(14),
        'Rect': () => iconSquare(14),
        'Ellipse': () => iconCircle(14),
        'Path': () => iconPenTool(14),
        'Text': () => iconType(14),
        'Image': () => iconSquare(14),
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
    textContentInput: HTMLTextAreaElement;
    textFontFamily: HTMLSelectElement;
    textFontSize: HTMLInputElement;
    textLineHeight: HTMLInputElement;
    textAlign: HTMLSelectElement;
    textWeight!: HTMLSelectElement;
    textItalic!: HTMLSelectElement;
    textLetterSpacing!: HTMLInputElement;
    typographySection: HTMLElement;

    // Export Panel DOM elements
    exportPaneScale: HTMLSelectElement;
    exportPaneFormat: HTMLSelectElement;
    exportPaneSuffix: HTMLInputElement;
    exportPaneTransparent: HTMLInputElement;
    exportPaneBtn: HTMLButtonElement;

    // Context menu
    contextMenuEl: HTMLElement;
    private _contextMenuCallback: ((action: string) => void) | null = null;
    private _dismissContextMenu: ((e: MouseEvent) => void) | null = null;
    private _dismissContextMenuKey: ((e: KeyboardEvent) => void) | null = null;

    // Layer tree state
    private _collapsedGroups: Set<number> = new Set();
    private _collapsedArtboards: Set<number> = new Set();

    /** Node ids currently being dragged in the layer panel (the whole selection
     *  when the grabbed row is part of a multi-selection), or null. */
    private _draggingLayerIds: number[] | null = null;

    constructor(ck: CanvasKit, scene: WasmScene) {
        this.ck = ck;
        this.scene = scene;
        this.gradientEdit = new GradientEditController(scene);

        // Initialize DOM refs — basic
        this.layerList = document.getElementById('layer-list') as HTMLElement;
        this._initLayerListEmptyAreaDrop();
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
        this.textContentInput = document.getElementById('text-content') as HTMLTextAreaElement;
        this.textFontFamily = document.getElementById('text-font-family') as HTMLSelectElement;
        this.textFontSize = document.getElementById('text-font-size') as HTMLInputElement;
        this.textLineHeight = document.getElementById('text-line-height') as HTMLInputElement;
        this.textAlign = document.getElementById('text-align') as HTMLSelectElement;
        this.textWeight = document.getElementById('text-weight') as HTMLSelectElement;
        this.textItalic = document.getElementById('text-italic') as HTMLSelectElement;
        this.textLetterSpacing = document.getElementById('text-letter-spacing') as HTMLInputElement;
        this.typographySection = document.getElementById('typography-section') as HTMLElement;

        // Context menu
        this.contextMenuEl = document.getElementById('context-menu') as HTMLElement;

        // Export Panel
        this.exportPaneScale = document.getElementById('export-pane-scale') as HTMLSelectElement;
        this.exportPaneFormat = document.getElementById('export-pane-format') as HTMLSelectElement;
        this.exportPaneSuffix = document.getElementById('export-pane-suffix') as HTMLInputElement;
        this.exportPaneTransparent = document.getElementById('export-pane-transparent') as HTMLInputElement;
        this.exportPaneBtn = document.getElementById('export-pane-btn') as HTMLButtonElement;

        this.initEvents();
        this.initCollapsibleSections();

        // Seed the current style from the panel's initial (HTML default) values
        this._currentStyleJson = this.buildCurrentStyleJson();
    }

    /** Figma-style label scrubbing: dragging the label inside a dimension
     *  field adjusts its value (Shift = ×10). One undo snapshot per gesture;
     *  live edits apply without history. A plain click focuses the field. */
    /** General Figma-style label scrubbing helper */
    private makeScrubbable(label: HTMLElement, input: HTMLInputElement, onUpdate: () => void) {
        label.addEventListener('pointerdown', (e: PointerEvent) => {
            if (input.disabled) return;
            const isAb = input.id.startsWith('ab-');
            if (!isAb && this.scene.engine!.get_selection().length === 0) return;
            
            e.preventDefault();
            try { label.setPointerCapture(e.pointerId); } catch { }

            const startX = e.clientX;
            const startVal = parseFloat(input.value) || 0;
            const step = parseFloat(input.step) || 1;
            const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
            const max = input.max !== '' ? parseFloat(input.max) : Infinity;
            let moved = false;

            const onMove = (ev: PointerEvent) => {
                const dx = ev.clientX - startX;
                if (!moved && Math.abs(dx) < 3) return; // click-vs-drag threshold
                if (!moved) this.scene.beginGesture(); // one undo snapshot for the whole drag
                moved = true;
                document.body.classList.add('scrubbing');

                const mult = ev.shiftKey ? 10 : 1;
                const val = Math.max(min, Math.min(max, startVal + Math.round(dx) * step * mult));
                const next = String(Math.round(val * 100) / 100);
                if (next === input.value) return;
                input.value = next;

                onUpdate();
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
    }

    /** Figma-style label scrubbing: dragging the label inside a dimension
     *  field adjusts its value (Shift = ×10). One undo snapshot per gesture;
     *  live edits apply without history. A plain click focuses the field. */
    private initScrubbing() {
        document.querySelectorAll<HTMLElement>('.dim-label[data-scrub]').forEach(label => {
            const input = document.getElementById(label.dataset.scrub!) as HTMLInputElement | null;
            if (!input) return;

            const onUpdate = () => {
                if (input.id.startsWith('ab-')) {
                    this.applyArtboardBounds();
                } else if (input === this.cornerRadius) {
                    this.applyCornerRadiusToSelection();
                } else if (input === this.textFontSize || input === this.textLineHeight || input === this.textLetterSpacing) {
                    this.updateTextPropertiesNoHistory();
                } else if (input === this.opacityInput) {
                    this._currentStyleJson = this.buildCurrentStyleJson();
                    this.updateSelectedPropertiesNoHistory();
                } else {
                    this.updateTransform(false);
                }
            };

            this.makeScrubbable(label, input, onUpdate);
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

        // Export Panel events
        this.exportPaneFormat?.addEventListener('change', () => {
            const isSVG = this.exportPaneFormat.value === 'svg';
            if (this.exportPaneScale) this.exportPaneScale.disabled = isSVG;
            if (this.exportPaneTransparent) this.exportPaneTransparent.disabled = isSVG;
        });

        this.exportPaneBtn?.addEventListener('click', () => {
            this.exportSelection();
        });

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
        const typographyInputs = [this.textContentInput, this.textFontFamily, this.textFontSize, this.textLineHeight, this.textAlign, this.textWeight, this.textItalic, this.textLetterSpacing];
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

        // Shift+Arrow = ±10 * step on all dimension fields (Figma convention).
        // Setting the value and dispatching 'change' reuses each field's handler.
        const allScrubbableInputs = [
            ...transformInputs, 
            this.cornerRadius, 
            this.textFontSize, 
            this.textLineHeight, 
            this.textLetterSpacing, 
            this.opacityInput,
            document.getElementById('ab-x') as HTMLInputElement,
            document.getElementById('ab-y') as HTMLInputElement,
            document.getElementById('ab-w') as HTMLInputElement,
            document.getElementById('ab-h') as HTMLInputElement
        ];
        for (const el of allScrubbableInputs) {
            if (!el) continue;
            el.addEventListener('keydown', (e: KeyboardEvent) => {
                if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                e.preventDefault();
                const min = el.min !== '' ? parseFloat(el.min) : -Infinity;
                const max = el.max !== '' ? parseFloat(el.max) : Infinity;
                const cur = parseFloat(el.value) || 0;
                const step = el.step !== '' ? parseFloat(el.step) : 1;
                const val = Math.max(min, Math.min(max, cur + (e.key === 'ArrowUp' ? 10 : -10) * step));
                el.value = String(Math.round(val * 100) / 100);
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

        // Effects: "+" adds a drop shadow to the selected node. stopPropagation so
        // the click doesn't bubble to the section header and collapse the panel
        // (which made the newly-added effect appear to "not add").
        document.getElementById('add-effect-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.addEffectToSelection();
        });

        // Artboard properties panel inputs.
        this.bindArtboardPanel();
    }

    private applyArtboardBounds() {
        const selectedId = this.scene.renderer?.selectedArtboardId ?? null;
        const ab = this.scene.getArtboards().find(a => a.id === selectedId);
        if (!ab) return;
        const x = parseFloat((document.getElementById('ab-x') as HTMLInputElement).value) || 0;
        const y = parseFloat((document.getElementById('ab-y') as HTMLInputElement).value) || 0;
        const w = Math.max(1, parseFloat((document.getElementById('ab-w') as HTMLInputElement).value) || 1);
        const h = Math.max(1, parseFloat((document.getElementById('ab-h') as HTMLInputElement).value) || 1);
        this.scene.setArtboardBounds(ab.id, x, y, w, h);
        this.scene.renderer?.requestRender();
    }

    /** Wire the artboard properties panel inputs (once, from bindEvents). */
    private bindArtboardPanel() {
        const selectedId = () => this.scene.renderer?.selectedArtboardId ?? null;
        const current = () => this.scene.getArtboards().find(a => a.id === selectedId());

        for (const id of ['ab-x', 'ab-y', 'ab-w', 'ab-h']) {
            document.getElementById(id)?.addEventListener('change', () => this.applyArtboardBounds());
        }
        document.getElementById('ab-name')?.addEventListener('change', (e) => {
            const ab = current();
            if (ab) this.scene.setArtboardName(ab.id, (e.target as HTMLInputElement).value);
        });
        document.getElementById('ab-bg')?.addEventListener('input', (e) => {
            const ab = current();
            if (!ab) return;
            const c = hexToRgb((e.target as HTMLInputElement).value);
            this.scene.setArtboardBackground(ab.id, c.r, c.g, c.b, 1);
            (document.getElementById('ab-transparent') as HTMLInputElement).checked = false;
            this.scene.renderer?.requestRender();
        });
        document.getElementById('ab-transparent')?.addEventListener('change', (e) => {
            const ab = current();
            if (!ab) return;
            const transparent = (e.target as HTMLInputElement).checked;
            if (transparent) {
                this.scene.setArtboardBackground(ab.id, ab.background.r, ab.background.g, ab.background.b, 0);
            } else {
                const c = hexToRgb((document.getElementById('ab-bg') as HTMLInputElement).value);
                this.scene.setArtboardBackground(ab.id, c.r, c.g, c.b, 1);
            }
            this.refreshArtboardPanel();
            this.scene.renderer?.requestRender();
        });
        document.getElementById('ab-preset')?.addEventListener('change', (e) => {
            const ab = current();
            const val = (e.target as HTMLSelectElement).value;
            (e.target as HTMLSelectElement).value = ''; // reset to Custom
            if (!ab || !val) return;
            const [w, h] = val.split('x').map(Number);
            if (w > 0 && h > 0) {
                this.scene.setArtboardBounds(ab.id, ab.x, ab.y, w, h);
                this.refreshArtboardPanel();
                this.scene.renderer?.fitToArtboard();
                this.scene.renderer?.requestRender();
            }
        });
        document.getElementById('ab-delete')?.addEventListener('click', () => {
            const ab = current();
            if (!ab) return;
            if (this.scene.removeArtboard(ab.id)) {
                if (this.scene.renderer) this.scene.renderer.selectedArtboardId = null;
                this.refreshArtboardPanel();
                this.updateLayerList();
                this.scene.renderer?.fitToArtboard();
            }
        });
    }

    /** Show/populate the artboard section when an artboard is selected. */
    /**
     * Reflect artboard selection in the right panel: when an artboard is
     * selected show ONLY the Frame properties and hide the node property
     * sections; otherwise show the node sections.
     */
    refreshArtboardPanel() {
        const section = document.getElementById('artboard-section');
        const nodeProps = document.getElementById('node-props');
        if (!section) return;
        const empty = document.getElementById('props-empty');
        const id = this.scene.renderer?.selectedArtboardId ?? null;
        const ab = id !== null ? this.scene.getArtboards().find(a => a.id === id) : undefined;

        this.updateExportPanel();

        if (!ab) {
            section.style.display = 'none';
            // No artboard selected: show the node inspector only when a node is
            // actually selected, otherwise show the empty-state hint. Leaving the
            // node inspector visible with blank, inert controls is confusing.
            const hasNodeSel = (this.scene.engine?.get_selection()?.length ?? 0) > 0;
            if (nodeProps) nodeProps.style.display = hasNodeSel ? '' : 'none';
            if (empty) empty.style.display = hasNodeSel ? 'none' : '';
            return;
        }

        section.style.display = '';
        if (nodeProps) nodeProps.style.display = 'none';
        if (empty) empty.style.display = 'none';
        (document.getElementById('ab-name') as HTMLInputElement).value = ab.name;
        (document.getElementById('ab-x') as HTMLInputElement).value = String(Math.round(ab.x));
        (document.getElementById('ab-y') as HTMLInputElement).value = String(Math.round(ab.y));
        (document.getElementById('ab-w') as HTMLInputElement).value = String(Math.round(ab.w));
        (document.getElementById('ab-h') as HTMLInputElement).value = String(Math.round(ab.h));
        const transparent = ab.background.a <= 0;
        (document.getElementById('ab-transparent') as HTMLInputElement).checked = transparent;
        const bg = document.getElementById('ab-bg') as HTMLInputElement;
        bg.value = this.rgbToHex(ab.background);
        bg.disabled = transparent;
    }

    /** Update the visibility and label of the Export panel. */
    updateExportPanel() {
        const exportSection = document.getElementById('export-pane-section');
        if (!exportSection) return;

        const selection = this.scene.engine?.get_selection() ?? [];
        const artboardId = this.scene.renderer?.selectedArtboardId ?? null;
        const ab = artboardId !== null ? this.scene.getArtboards().find(a => a.id === artboardId) : undefined;

        // If nothing is selected, hide the panel completely.
        if (!ab && selection.length === 0) {
            exportSection.style.display = 'none';
            return;
        }

        // Show the panel
        exportSection.style.display = '';

        const exportBtn = this.exportPaneBtn;
        if (!exportBtn) return;

        if (ab) {
            exportBtn.innerText = `Export ${ab.name || 'Artboard'}`;
        } else if (selection.length > 0) {
            if (selection.length === 1) {
                exportBtn.innerText = `Export ${this.scene.getNodeName(selection[0]) || 'Selection'}`;
            } else {
                exportBtn.innerText = `Export selection (${selection.length})`;
            }
        }
    }

    /** Add a new artboard to the right of the existing ones and select it. */
    addArtboard() {
        const arts = this.scene.getArtboards();
        const maxRight = arts.reduce((m, a) => Math.max(m, a.x + a.w), 0);
        const gap = 100;
        const id = this.scene.addArtboard(maxRight + gap, 0, 1000, 1000);
        if (this.scene.renderer) this.scene.renderer.selectedArtboardId = id;
        this.refreshArtboardPanel();
        this.scene.renderer?.fitToArtboard();
        this.scene.renderer?.requestRender();
    }

    /** Open a file picker and import the chosen SVG. Invoked from the app menu. */
    importSVGViaPicker() {
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
    }

    setActiveTool(toolId: string, lock = false) {
        this.activeTool = toolId;
        this.toolLocked = lock;
        this.toolbar?.sync(toolId);

        // Exit path/text editing when switching tools to clear dimming
        const im = this.scene.renderer?.inputManager;
        if (im) {
            im.commitActiveTextEdit(); // close any open inline text overlay
            if (im.editingNodeId !== null) im.exitEditMode();
        }

        // Set cursor on canvas based on tool
        this.applyToolCursor();

        // Activating Live Paint with a selection makes (or enters) a Live Paint
        // group, so "select shapes → click Live Paint" produces the group.
        if (toolId === 'paint-bucket' && im) {
            im.enterPaintBucketMode();
        }

        this.contextBar?.refresh();
    }

    /** Cursor for each tool. Creation tools use the crosshair. */
    private static readonly TOOL_CURSORS: Record<string, string> = {
        selection: 'default',
        direct: 'default',
        pen: 'crosshair',
        pencil: 'crosshair',
        line: 'crosshair',
        rect: 'crosshair',
        ellipse: 'crosshair',
        polygon: 'crosshair',
        star: 'crosshair',
        text: 'text',
        'paint-bucket': 'crosshair',
        scissors: 'crosshair',
    };

    /** Set the canvas cursor to match the active tool. Callable after a drag
     *  gesture (e.g. mouseup) so a locked creation tool keeps its crosshair
     *  instead of falling back to the default arrow. */
    applyToolCursor() {
        const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement | null;
        if (canvas) canvas.style.cursor = UIEngine.TOOL_CURSORS[this.activeTool] ?? 'default';
    }

    // Live Paint colors are INDEPENDENT of the selection: changing them only
    // sets what the next region/edge click paints — it must never recolor the
    // selected shapes (that was the "color swatch changes all shapes" bug).
    private _livePaintFill: Color = { r: 0.2, g: 0.55, b: 0.9, a: 1 };
    private _livePaintStroke: Color = { r: 0, g: 0, b: 0, a: 1 };
    getLivePaintFill(): Color { return { ...this._livePaintFill }; }
    getLivePaintStroke(): Color { return { ...this._livePaintStroke }; }
    setLivePaintFill(hex: string) { this._livePaintFill = this.hexToRgb(hex); }
    setLivePaintStroke(hex: string) { this._livePaintStroke = this.hexToRgb(hex); }

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
        this.applyStylePanelToSelection(true);
    }

    /** Apply style changes to selected nodes WITHOUT pushing undo history.
     *  Used for live preview during drag-editing (color picker, sliders). */
    updateSelectedPropertiesNoHistory() {
        this.applyStylePanelToSelection(false);
    }

    /** Apply the Opacity + Blend panel widgets.
     *  With a selection: overlay opacity/blend onto each node's OWN style so
     *  fills, strokes and other per-node properties are preserved (we must not
     *  replace the whole style with the global "current style", which would
     *  clobber each shape's paint). Editing an existing object must NOT leak
     *  into the new-shape default, or newly drawn objects would inherit this
     *  object's opacity/blend ("picks up the appearance of the last one").
     *  With no selection the panel is editing that default, so record it. */
    private applyStylePanelToSelection(withHistory: boolean) {
        const opacity = (parseFloat(this.opacityInput?.value) || 100) / 100;
        const blend_mode = this.blendMode ? parseInt(this.blendMode.value) || 0 : 0;

        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) {
            // Editing the default for the next shape (nothing selected).
            try {
                const s = JSON.parse(this._currentStyleJson || "{}");
                s.opacity = opacity;
                s.blend_mode = blend_mode;
                this._currentStyleJson = JSON.stringify(s);
            } catch { }
            return;
        }
        for (const id of selection) {
            const node = this.scene.getNode(id);
            if (!node) continue;
            const newStyle = { ...node.style, opacity, blend_mode };
            const json = JSON.stringify(newStyle);
            if (withHistory) this.scene.setNodeStyle(id, json);
            else this.scene.setNodeStyleNoHistory(id, json);
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
        // Groups have no geometry of their own — report their world bounding box
        // (the same rectangle the selection frame draws).
        if (node.node_type === 'Group') {
            const b = this.scene.getNodeBounds(id);
            if (b && b.length >= 4) {
                const w = b[2] - b[0];
                const h = b[3] - b[1];
                if (w > 0 && h > 0) return { w, h };
            }
            return null;
        }
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
        // Keep gradient-editing state consistent with the selection
        this.gradientEdit.syncSelection();
        const selection = this.scene.engine!.get_selection();
        // Node selection and artboard selection are mutually exclusive: selecting
        // a node clears any selected artboard. Then reconcile which property
        // sections are visible (Frame vs node properties).
        if (selection.length > 0 && this.scene.renderer && this.scene.renderer.selectedArtboardId !== null) {
            this.scene.renderer.selectedArtboardId = null;
        }
        this.refreshArtboardPanel();
        if (selection.length === 0) {
            this.clearPropertyPanel();
            if (!interactive) {
                this.updateLayerSelection();
                this.contextBar?.refresh();
            }
            return;
        }
        
        const node = this.scene.getNode(selection[0]);
        if (!node) {
            this.clearPropertyPanel();
            if (!interactive) {
                this.updateLayerSelection();
                this.contextBar?.refresh();
            }
            return;
        }
        const style = node.style;

        this.opacityInput.value = ((style.opacity !== undefined ? style.opacity : 1) * 100).toFixed(0);
        if (this.blendMode) this.blendMode.value = (style.blend_mode || 0).toString();

        // Effects list (single-selection only)
        this.renderEffectsList(selection.length === 1 ? selection[0] : null);

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
            this.updateLayerSelection();
            this.contextBar?.refresh();
        }

        if (node.geometry.Text) {
            if (this.typographySection) this.typographySection.style.display = '';
            // Don't clobber the content field while the user is typing in it.
            if (this.textContentInput && document.activeElement !== this.textContentInput) {
                this.textContentInput.value = node.geometry.Text.content || '';
            }
            if (this.textFontFamily) this.textFontFamily.value = node.geometry.Text.font_family || '';
            if (this.textFontSize) this.textFontSize.value = String(node.geometry.Text.font_size || 32);
            if (this.textLineHeight) this.textLineHeight.value = String(node.geometry.Text.line_height || 1.2);
            if (this.textAlign) this.textAlign.value = String(node.geometry.Text.text_align || 0);
            if (this.textWeight) this.textWeight.value = String(node.geometry.Text.font_weight || 400);
            if (this.textItalic) this.textItalic.value = node.geometry.Text.italic ? '1' : '0';
            if (this.textLetterSpacing) this.textLetterSpacing.value = String(node.geometry.Text.letter_spacing || 0);
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
        
        const fontWeight = parseInt(this.textWeight?.value ?? '400', 10);
        const italic = (this.textItalic?.value ?? '0') === '1';
        const letterSpacing = parseFloat(this.textLetterSpacing?.value ?? '0') || 0;

        // Content from the panel field (populated on selection, so it reflects
        // the node's text unless the user edited it here).
        const content = this.textContentInput ? this.textContentInput.value : node.geometry.Text.content;
        this.scene.engine!.set_text_content(id, content, fontSize);
        this.scene.engine!.set_text_properties(id, fontFamily, textAlign, lineHeight);
        this.scene.engine!.set_text_style(id, fontWeight, italic, letterSpacing);

        this.scene.invalidateCache();
        this.syncWithSelection({ interactive: true }); // Don't re-focus inputs
    }

    /** Map from numeric node type (engine enum) to string key for icon lookup.
     *  0=Path, 1=Rect, 2=Ellipse, 3=Group, 4=Text */
    private static readonly NODE_TYPE_KEY: readonly string[] = ['Path', 'Rect', 'Ellipse', 'Group', 'Text', 'Image'];


    private getFills(node: SceneNode): Paint[] {
        return node.style.fills || [];
    }

    private getStrokes(node: SceneNode): Stroke[] {
        return node.style.strokes || [];
    }

        /** Cache of data-URI previews for pattern tile images, keyed by image id. */
        private _patternPreviewCache = new Map<number, string | null>();

        /** A data-URI preview for a pattern's tile image (from the engine's bytes). */
        private _patternPreviewUri(imageId: number): string | null {
        if (this._patternPreviewCache.has(imageId)) return this._patternPreviewCache.get(imageId)!;
        let uri: string | null = null;
        try {
            const bytes = this.scene.engine?.get_image_bytes(imageId);
            const mime = this.scene.engine?.get_image_mime(imageId) || 'image/png';
            if (bytes && bytes.length > 0) {
                let bin = '';
                for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                uri = `data:${mime};base64,${btoa(bin)}`;
            }
        } catch { /* noop */ }
        this._patternPreviewCache.set(imageId, uri);
        return uri;
    }

        /** Local-space bounding box of a node's geometry, used to place default
         *  gradient endpoints so a new gradient spans the shape. */
        private nodeLocalExtent(node: SceneNode): { minX: number; minY: number; maxX: number; maxY: number } {
        const g = node.geometry;
        if (g.Rect) return { minX: 0, minY: 0, maxX: g.Rect.width, maxY: g.Rect.height };
        if (g.Image) return { minX: 0, minY: 0, maxX: g.Image.width, maxY: g.Image.height };
        if (g.Ellipse) return { minX: -g.Ellipse.radius_x, minY: -g.Ellipse.radius_y, maxX: g.Ellipse.radius_x, maxY: g.Ellipse.radius_y };
        if (g.Path) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const sp of g.Path.subpaths) for (const p of sp.points) {
                minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
            }
            if (minX <= maxX) return { minX, minY, maxX, maxY };
        }
        if (g.Text) { const fs = g.Text.font_size || 16; return { minX: 0, minY: -fs, maxX: (g.Text.content.length * fs * 0.6) || fs, maxY: 0 }; }
        return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    }

        /** Rotate a gradient's axis to `angleDeg` around its midpoint,
         *  preserving the axis length (so custom endpoints keep their span). */
        private static rotateGradientTo(grad: Gradient, angleDeg: number): void {
        const cx = (grad.start_x + grad.end_x) / 2, cy = (grad.start_y + grad.end_y) / 2;
        const half = Math.hypot(grad.end_x - grad.start_x, grad.end_y - grad.start_y) / 2;
        const a = angleDeg * Math.PI / 180;
        const dx = Math.cos(a) * half, dy = Math.sin(a) * half;
        grad.start_x = cx - dx; grad.start_y = cy - dy;
        grad.end_x = cx + dx; grad.end_y = cy + dy;
    }

        /** Current angle (deg) of a gradient's axis in node-local space. */
        private static gradientAngle(grad: Gradient): number {
        return Math.atan2(grad.end_y - grad.start_y, grad.end_x - grad.start_x) * 180 / Math.PI;
    }

        /** Build a default 2-stop gradient (seed color → transparent) spanning the node. */
        private makeDefaultGradient(type: 'Linear' | 'Radial', node: SceneNode, seed: Color): Gradient {
        const e = this.nodeLocalExtent(node);
        const cx = (e.minX + e.maxX) / 2, cy = (e.minY + e.maxY) / 2;
        const stops: GradientStop[] = [
            { offset: 0, color: { r: seed.r, g: seed.g, b: seed.b, a: seed.a ?? 1 } },
            { offset: 1, color: { r: seed.r, g: seed.g, b: seed.b, a: 0 } },
        ];
        if (type === 'Linear') return { gradient_type: 'Linear', stops, start_x: e.minX, start_y: cy, end_x: e.maxX, end_y: cy };
        return { gradient_type: 'Radial', stops, start_x: cx, start_y: cy, end_x: e.maxX, end_y: cy };
    }

        /** CSS gradient string for a swatch/preview from a Gradient's stops. */
        private gradientPreviewCss(grad: Gradient): string {
        const stops = [...grad.stops].sort((a, b) => a.offset - b.offset)
            .map(s => `rgba(${Math.round(s.color.r * 255)},${Math.round(s.color.g * 255)},${Math.round(s.color.b * 255)},${s.color.a}) ${Math.round(s.offset * 100)}%`)
            .join(', ');
        return grad.gradient_type === 'Radial'
            ? `radial-gradient(circle, ${stops})`
            : `linear-gradient(90deg, ${stops})`;
    }

        renderFillsList(node: SceneNode) {
        if (!this.fillsList) return;
        this.fillsList.innerHTML = '';
        const fills = this.getFills(node);
        const selId: number | undefined = this.scene.getSelection()[0];
        const ge = this.gradientEdit;

        // Commit a mutated copy of the fills array to the engine.
        const commit = (mutate: (f: Paint[]) => void, live = false) => {
            const next = fills.map(f => (isGradient(f) ? { ...f, stops: f.stops.map(s => ({ ...s, color: { ...s.color } })) } : { ...f }) as Paint);
            mutate(next);
            this.updateNodeStyle(node, { fills: next }, live);
        };

        fills.forEach((fill: Paint, index: number) => {
            const item = document.createElement('div');
            item.className = 'fill-item';

            const row = document.createElement('div');
            row.className = 'fill-stroke-row';

            // Fill-type selector: Solid / Linear / Radial (+ Pattern for imported
            // pattern fills — patterns can only be created via SVG import).
            const typeSel = document.createElement('select');
            typeSel.className = 'prop-select fill-type-select';
            typeSel.innerHTML = `<option value="solid">Solid</option><option value="linear">Linear</option><option value="radial">Radial</option>`
                + (isPattern(fill) ? `<option value="pattern">Pattern</option>` : '');
            typeSel.value = isPattern(fill) ? 'pattern' : isGradient(fill) ? (fill.gradient_type === 'Radial' ? 'radial' : 'linear') : 'solid';
            typeSel.addEventListener('change', () => {
                if (typeSel.value === 'pattern') return; // can't switch TO pattern from the UI
                const seed: Color = isGradient(fill) ? (fill.stops[0]?.color ?? { r: 0.5, g: 0.5, b: 0.5, a: 1 })
                    : isPattern(fill) ? { r: 0.5, g: 0.5, b: 0.5, a: 1 } : fill as Color;
                // Switching to a gradient type puts this fill into gradient-edit
                // mode (canvas handles + panel ramp). syncSelection validates
                // this after the commit lands.
                if (typeSel.value !== 'solid' && selId !== undefined) ge.activate(selId, index);
                commit(f => {
                    if (typeSel.value === 'solid') {
                        f[index] = { ...seed };
                    } else {
                        const t: 'Linear' | 'Radial' = typeSel.value === 'radial' ? 'Radial' : 'Linear';
                        // Preserve stops AND axis placement when switching between gradient types.
                        if (isGradient(fill)) {
                            const g: Gradient = {
                                gradient_type: t,
                                stops: fill.stops.map(s => ({ offset: s.offset, color: { ...s.color } })),
                                start_x: fill.start_x, start_y: fill.start_y,
                                end_x: fill.end_x, end_y: fill.end_y,
                            };
                            if (t === 'Radial' && fill.gradient_type === 'Linear') {
                                // Radial center = the linear axis midpoint
                                g.start_x = (fill.start_x + fill.end_x) / 2;
                                g.start_y = (fill.start_y + fill.end_y) / 2;
                            } else if (t === 'Linear' && fill.gradient_type === 'Radial') {
                                // Linear axis spans the radial diameter
                                g.start_x = 2 * fill.start_x - fill.end_x;
                                g.start_y = 2 * fill.start_y - fill.end_y;
                            }
                            f[index] = g;
                        } else {
                            f[index] = this.makeDefaultGradient(t, node, seed);
                        }
                    }
                });
                // commit() → updateNodeStyle → syncWithSelection re-renders the
                // fills list with the FRESH node (re-fetched from the engine);
                // re-rendering here with the stale captured `node` would revert it.
            });
            row.appendChild(typeSel);

            if (isPattern(fill)) {
                // ── Pattern: a tile preview (image fill from import) ──
                const preview = document.createElement('div');
                preview.className = 'gradient-preview';
                preview.title = 'Pattern fill (imported)';
                const uri = this._patternPreviewUri(fill.image_id);
                if (uri) {
                    preview.style.backgroundImage = `url(${uri})`;
                    preview.style.backgroundSize = 'cover';
                } else {
                    preview.style.background = '#888';
                }
                row.appendChild(preview);
            } else if (!isGradient(fill)) {
                // ── Solid: color swatch + hex ──
                const solid = fill as Color;
                const hexInput = document.createElement('input');
                hexInput.type = 'text';
                hexInput.className = 'prop-input';
                hexInput.style.cssText = 'width:60px;flex:0 0 60px';
                hexInput.value = this.rgbToHex(solid).toUpperCase();
                const swatch = createColorSwatch({
                    color: solid,
                    title: 'Fill color',
                    onInput: (c) => { hexInput.value = this.rgbToHex(c).toUpperCase(); commit(f => { f[index] = c; }, true); },
                    onChange: (c) => { hexInput.value = this.rgbToHex(c).toUpperCase(); commit(f => { f[index] = c; }); },
                });
                hexInput.addEventListener('change', () => {
                    const val = hexInput.value.startsWith('#') ? hexInput.value : '#' + hexInput.value;
                    if (/^#[0-9A-F]{6}$/i.test(val)) {
                        const c = { ...this.hexToRgb(val), a: solid.a ?? 1 };
                        swatch.setColor(c); commit(f => { f[index] = c; });
                    }
                });
                row.appendChild(swatch.el);
                row.appendChild(hexInput);
            } else {
                // ── Gradient: clickable preview swatch (activates editing) ──
                const isActiveGrad = ge.isActive() && ge.nodeId === selId && ge.fillIndex === index;
                const preview = document.createElement('div');
                preview.className = 'gradient-preview';
                preview.classList.toggle('active', isActiveGrad);
                preview.title = 'Edit gradient';
                preview.style.backgroundImage = `${this.gradientPreviewCss(fill)}, ${UIEngine.CHECKER_CSS}`;
                preview.style.backgroundSize = 'auto, 8px 8px';
                preview.addEventListener('click', () => {
                    if (selId === undefined) return;
                    ge.activate(selId, index);
                    this.syncWithSelection({ interactive: true });
                });
                row.appendChild(preview);
            }

            const spacer = document.createElement('div');
            spacer.style.flex = '1';
            row.appendChild(spacer);

            const delBtn = document.createElement('button');
            delBtn.className = 'icon-toggle';
            delBtn.innerHTML = '×';
            delBtn.title = 'Remove Fill';
            delBtn.onclick = () => commit(f => { f.splice(index, 1); });
            row.appendChild(delBtn);

            item.appendChild(row);

            // ── Gradient editor (ramp + selected stop + actions) — only for
            //    the fill currently in gradient-edit mode ──
            if (isGradient(fill) && ge.isActive() && ge.nodeId === selId && ge.fillIndex === index) {
                item.appendChild(this.buildGradientEditor(fill, index, commit));
            }

            this.fillsList.appendChild(item);
        });
    }

    /** Checkerboard layer used behind transparent gradient previews. */
    private static readonly CHECKER_CSS = 'repeating-conic-gradient(#c8c8c8 0% 25%, #ffffff 0% 50%)';

    /**
     * Figma-style gradient editor: a ramp with draggable stop chips (click to
     * add, drag away to remove), a detail row for the selected stop, and an
     * angle/reverse/rotate action row.
     */
    private buildGradientEditor(
        fill: Gradient,
        index: number,
        commit: (mutate: (f: Paint[]) => void, live?: boolean) => void,
    ): HTMLElement {
        const ge = this.gradientEdit;
        const editor = document.createElement('div');
        editor.className = 'gradient-editor';

        const cloneStops = (stops: GradientStop[]) => stops.map(s => ({ offset: s.offset, color: { ...s.color } }));
        const rgbCss = (c: Color) => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;

        // ── Ramp with draggable stop chips ──
        const ramp = document.createElement('div');
        ramp.className = 'gradient-ramp';
        const setRampBg = (g: Gradient) => {
            const stops = [...g.stops].sort((a, b) => a.offset - b.offset)
                .map(s => `rgba(${Math.round(s.color.r * 255)},${Math.round(s.color.g * 255)},${Math.round(s.color.b * 255)},${s.color.a ?? 1}) ${(s.offset * 100).toFixed(1)}%`)
                .join(', ');
            ramp.style.backgroundImage = `linear-gradient(90deg, ${stops}), ${UIEngine.CHECKER_CSS}`;
        };
        setRampBg(fill);

        const chips: HTMLElement[] = [];

        /** Drag stop `si` of `orig` along the ramp. Live-writes without
         *  history (one gesture = one undo step); dragging vertically away
         *  removes the stop, Figma-style. `applyNow` places the stop under
         *  the cursor immediately (used for freshly inserted stops). */
        const dragStop = (downEv: MouseEvent, si: number, orig: GradientStop[], applyNow: boolean) => {
            const rampRect = ramp.getBoundingClientRect();
            let gestureStarted = false;
            let removed = false;
            const apply = (ev: MouseEvent) => {
                if (!gestureStarted) { this.scene.beginGesture(); gestureStarted = true; }
                let t = Math.max(0, Math.min(1, (ev.clientX - rampRect.left) / rampRect.width));
                if (ev.shiftKey) t = Math.round(t * 10) / 10; // 10% snap
                removed = orig.length > 2 && Math.abs(ev.clientY - (rampRect.top + rampRect.height / 2)) > 40;
                const stops = cloneStops(orig);
                if (removed) stops.splice(si, 1); else stops[si].offset = t;
                ge.setStopsLive(stops);
                setRampBg({ ...fill, stops });
                const chip = chips[si];
                if (chip) {
                    chip.style.display = removed ? 'none' : '';
                    if (!removed) chip.style.left = `${t * 100}%`;
                }
            };
            if (applyNow) apply(downEv);
            const onMove = (ev: MouseEvent) => {
                // Ignore sub-pixel jitter on a plain click so the offset
                // doesn't drift from where the stop already sits.
                if (!gestureStarted && Math.hypot(ev.clientX - downEv.clientX, ev.clientY - downEv.clientY) < 2) return;
                apply(ev);
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                if (gestureStarted) this.scene.endGesture();
                if (removed) { ge.stopFocused = false; ge.stopIndex = 0; }
                this.syncWithSelection();
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp, { once: true });
        };

        const makeChip = (i: number, s: GradientStop) => {
            const chip = document.createElement('div');
            chip.className = 'gradient-stop-chip';
            chip.style.left = `${s.offset * 100}%`;
            chip.style.background = rgbCss(s.color);
            chip.classList.toggle('selected', i === ge.stopIndex);
            chip.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                ge.stopIndex = i;
                ge.stopFocused = true;
                chips.forEach((c, ci) => c.classList.toggle('selected', ci === i));
                this.scene.renderer?.requestRender(); // canvas highlights the stop
                dragStop(ev, i, cloneStops(fill.stops), false);
            });
            chips[i] = chip;
            ramp.appendChild(chip);
        };
        fill.stops.forEach((s, i) => makeChip(i, s));

        // Click an empty spot on the ramp → insert a stop there and drag it
        ramp.addEventListener('mousedown', (ev) => {
            if (ev.target !== ramp) return;
            ev.preventDefault();
            const rampRect = ramp.getBoundingClientRect();
            const t = Math.max(0, Math.min(1, (ev.clientX - rampRect.left) / rampRect.width));
            const orig = cloneStops(fill.stops);
            orig.push({ offset: t, color: sampleGradientColor(fill, t) });
            const si = orig.length - 1;
            ge.stopIndex = si;
            ge.stopFocused = true;
            makeChip(si, orig[si]);
            chips.forEach((c, ci) => c.classList.toggle('selected', ci === si));
            dragStop(ev, si, orig, true);
        });
        editor.appendChild(ramp);

        // ── Selected stop detail row ──
        const si = Math.max(0, Math.min(ge.stopIndex, fill.stops.length - 1));
        const stop = fill.stops[si];
        const stopRow = document.createElement('div');
        stopRow.className = 'gradient-stop-row';

        const hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.className = 'prop-input';
        hexInput.style.cssText = 'width:56px;flex:0 0 56px';
        hexInput.value = this.rgbToHex(stop.color).toUpperCase();
        // Stop alpha lives in its own numeric field below, so the picker edits
        // RGB only and preserves the stop's current alpha.
        const sw = createColorSwatch({
            color: { ...stop.color, a: 1 },
            alpha: false,
            title: 'Stop color',
            onInput: (c) => {
                hexInput.value = this.rgbToHex(c).toUpperCase();
                commit(f => { const st = (f[index] as Gradient).stops[si]; st.color = { ...c, a: st.color.a }; }, true);
            },
            onChange: (c) => {
                hexInput.value = this.rgbToHex(c).toUpperCase();
                commit(f => { const st = (f[index] as Gradient).stops[si]; st.color = { ...c, a: st.color.a }; });
                this.syncWithSelection();
            },
        });
        hexInput.addEventListener('change', () => {
            const val = hexInput.value.startsWith('#') ? hexInput.value : '#' + hexInput.value;
            if (/^#[0-9A-F]{6}$/i.test(val)) {
                const c = this.hexToRgb(val);
                sw.setColor({ ...c, a: 1 });
                commit(f => { const st = (f[index] as Gradient).stops[si]; st.color = { ...c, a: st.color.a }; });
            }
        });

        const posContainer = document.createElement('div');
        posContainer.className = 'dim-input';
        posContainer.style.cssText = 'width:52px;flex:0 0 52px';
        posContainer.title = 'Stop position %';

        const posLabel = document.createElement('span');
        posLabel.className = 'dim-label';
        posLabel.innerHTML = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1.5l3.5 4v5h-7v-5z"/></svg>`;

        const pos = document.createElement('input');
        pos.type = 'number'; pos.min = '0'; pos.max = '100';
        pos.value = String(Math.round(stop.offset * 100));

        const updatePos = () => {
            const v = Math.max(0, Math.min(100, parseFloat(pos.value) || 0)) / 100;
            commit(f => { (f[index] as Gradient).stops[si].offset = v; });
        };

        pos.addEventListener('change', updatePos);
        pos.addEventListener('input', updatePos);

        this.makeScrubbable(posLabel, pos, updatePos);

        posContainer.appendChild(posLabel);
        posContainer.appendChild(pos);

        const alphaContainer = document.createElement('div');
        alphaContainer.className = 'dim-input';
        alphaContainer.style.cssText = 'width:52px;flex:0 0 52px';
        alphaContainer.title = 'Stop opacity %';

        const alphaLabel = document.createElement('span');
        alphaLabel.className = 'dim-label';
        alphaLabel.innerHTML = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><circle cx="6" cy="6" r="4.5"/><path d="M6 1.5A4.5 4.5 0 0 1 6 10.5V1.5z" fill="currentColor"/></svg>`;

        const alpha = document.createElement('input');
        alpha.type = 'number'; alpha.min = '0'; alpha.max = '100';
        alpha.value = String(Math.round((stop.color.a ?? 1) * 100));

        const updateAlpha = () => {
            const a = Math.max(0, Math.min(100, parseFloat(alpha.value) || 0)) / 100;
            commit(f => { (f[index] as Gradient).stops[si].color.a = a; });
        };

        alpha.addEventListener('change', updateAlpha);
        alpha.addEventListener('input', updateAlpha);

        this.makeScrubbable(alphaLabel, alpha, updateAlpha);

        alphaContainer.appendChild(alphaLabel);
        alphaContainer.appendChild(alpha);

        const delStop = document.createElement('button');
        delStop.className = 'icon-toggle';
        delStop.innerHTML = '×';
        delStop.title = 'Remove stop';
        delStop.disabled = fill.stops.length <= 2;
        delStop.onclick = () => {
            if (fill.stops.length <= 2) return; // keep at least two
            ge.stopIndex = 0;
            ge.stopFocused = false;
            commit(f => { (f[index] as Gradient).stops.splice(si, 1); });
        };

        stopRow.appendChild(sw.el);
        stopRow.appendChild(hexInput);
        stopRow.appendChild(posContainer);
        stopRow.appendChild(alphaContainer);
        const sp = document.createElement('div'); sp.style.flex = '1'; stopRow.appendChild(sp);
        stopRow.appendChild(delStop);
        editor.appendChild(stopRow);

        // ── Actions row: angle (linear) + reverse + rotate 90° ──
        const actions = document.createElement('div');
        actions.className = 'gradient-angle-row';

        if (fill.gradient_type === 'Linear') {
            const angleContainer = document.createElement('div');
            angleContainer.className = 'dim-input';
            angleContainer.style.cssText = 'width:56px;flex:0 0 56px';
            angleContainer.title = 'Gradient angle';

            const angleLabel = document.createElement('span');
            angleLabel.className = 'dim-label';
            angleLabel.innerHTML = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M2.5 1.5v8h8"/><path d="M6.7 9.5a4.2 4.2 0 0 0-4.2-4.2"/></svg>`;

            const angleInput = document.createElement('input');
            angleInput.type = 'number';
            angleInput.value = String(Math.round(UIEngine.gradientAngle(fill)));

            const updateAngle = () => {
                commit(f => { UIEngine.rotateGradientTo(f[index] as Gradient, parseFloat(angleInput.value) || 0); });
            };

            angleInput.addEventListener('change', updateAngle);
            angleInput.addEventListener('input', updateAngle);

            this.makeScrubbable(angleLabel, angleInput, updateAngle);

            angleContainer.appendChild(angleLabel);
            angleContainer.appendChild(angleInput);

            const deg = document.createElement('span'); deg.textContent = '°'; deg.className = 'gradient-sub-label';
            actions.appendChild(angleContainer);
            actions.appendChild(deg);
        }

        const sp2 = document.createElement('div'); sp2.style.flex = '1'; actions.appendChild(sp2);

        const reverseBtn = document.createElement('button');
        reverseBtn.className = 'icon-toggle';
        reverseBtn.textContent = '⇄';
        reverseBtn.title = 'Reverse stops';
        reverseBtn.onclick = () => {
            commit(f => {
                const g = f[index] as Gradient;
                g.stops = g.stops.map(s => ({ offset: 1 - s.offset, color: { ...s.color } })).reverse();
            });
        };
        actions.appendChild(reverseBtn);

        if (fill.gradient_type === 'Linear') {
            const rotateBtn = document.createElement('button');
            rotateBtn.className = 'icon-toggle';
            rotateBtn.innerHTML = iconRotateCW(11);
            rotateBtn.title = 'Rotate 90°';
            rotateBtn.onclick = () => {
                commit(f => { UIEngine.rotateGradientTo(f[index] as Gradient, UIEngine.gradientAngle(fill) + 90); });
            };
            actions.appendChild(rotateBtn);
        }

        editor.appendChild(actions);
        return editor;
    }

        renderStrokesList(node: SceneNode) {
        if (!this.strokesList) return;
        this.strokesList.innerHTML = '';
        const strokes = this.getStrokes(node);
        
        strokes.forEach((stroke: any, index: number) => {
            const row = document.createElement('div');
            row.className = 'fill-stroke-row';
            
            const currentPaint = stroke.paint || {r:0, g:0, b:0, a:1};
            const currentColor = isGradient(currentPaint) && currentPaint.stops.length > 0 ? currentPaint.stops[0].color : (!isGradient(currentPaint) ? currentPaint : {r:0, g:0, b:0, a:1});

            const hexInput = document.createElement('input');
            hexInput.type = 'text';
            hexInput.className = 'prop-input';
            // Flexible so the row never overflows the 232px inspector; everything
            // else in the row is fixed-width, hex absorbs the remaining space.
            hexInput.style.flex = '1 1 0';
            hexInput.style.minWidth = '0';
            hexInput.value = this.rgbToHex(currentColor).toUpperCase();

            const applyStrokeColor = (c: Color, live: boolean) => {
                const newStrokes = [...strokes];
                if (stroke.paint && isGradient(stroke.paint)) {
                    if (stroke.paint.stops.length > 0) stroke.paint.stops[0].color = c;
                } else {
                    newStrokes[index].paint = c;
                }
                this.updateNodeStyle(node, { strokes: newStrokes }, live);
            };

            const colorSwatch = createColorSwatch({
                color: currentColor,
                title: 'Stroke color',
                onInput: (c) => { hexInput.value = this.rgbToHex(c).toUpperCase(); applyStrokeColor(c, true); },
                onChange: (c) => { hexInput.value = this.rgbToHex(c).toUpperCase(); applyStrokeColor(c, false); },
            });

            hexInput.addEventListener('change', () => {
                const val = hexInput.value.startsWith('#') ? hexInput.value : '#' + hexInput.value;
                if (/^#[0-9A-F]{6}$/i.test(val)) {
                    const c = { ...this.hexToRgb(val), a: currentColor.a ?? 1 };
                    colorSwatch.setColor(c);
                    applyStrokeColor(c, false);
                }
            });

            const wContainer = document.createElement('div');
            wContainer.className = 'dim-input';
            wContainer.style.width = '48px';
            wContainer.style.flex = '0 0 48px';
            wContainer.title = 'Stroke thickness';

            const wLabel = document.createElement('span');
            wLabel.className = 'dim-label';
            wLabel.innerHTML = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M1.5 2h9" stroke-width="0.8"/><path d="M1.5 5.5h9" stroke-width="1.6"/><path d="M1.5 9h9" stroke-width="2.4"/></svg>`;

            const wInput = document.createElement('input');
            wInput.type = 'number';
            wInput.value = String(stroke.width);
            wInput.step = '0.5';
            wInput.min = '0';

            const updateStrokeWidth = () => {
                const newStrokes = [...strokes];
                newStrokes[index].width = parseFloat(wInput.value) || 0;
                this.updateNodeStyle(node, { strokes: newStrokes }, true);
            };

            wInput.addEventListener('input', updateStrokeWidth);
            wInput.addEventListener('change', updateStrokeWidth);

            this.makeScrubbable(wLabel, wInput, updateStrokeWidth);

            wContainer.appendChild(wLabel);
            wContainer.appendChild(wInput);

            const alignSelect = document.createElement('select');
            alignSelect.className = 'prop-select';
            alignSelect.style.width = '52px';
            alignSelect.style.flex = '0 0 52px';
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

            row.appendChild(colorSwatch.el);
            row.appendChild(hexInput);
            row.appendChild(wContainer);
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



    /**
     * Update the selection highlight on existing panel rows WITHOUT rebuilding
     * the DOM. Selecting a row must not rebuild the list, or the second click of
     * a double-click-to-rename would land on a replaced element and never fire.
     */
    updateLayerSelection() {
        if (!this.scene.engine) return;
        let sel: Set<number>;
        try { sel = new Set(Array.from(this.scene.engine.get_selection())); } catch { return; }
        const selAb = this.scene.renderer?.selectedArtboardId ?? null;
        this.layerList.querySelectorAll('.layer-item').forEach((el) => {
            const item = el as HTMLElement;
            let selected = false;
            if (item.dataset.nodeId !== undefined) selected = sel.has(Number(item.dataset.nodeId));
            else if (item.dataset.artboardId !== undefined) selected = Number(item.dataset.artboardId) === selAb;
            item.classList.toggle('selected', selected);
        });
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

        // Clear only after we know we can read fresh data. (We still render even
        // with zero nodes, so artboards always show in the Objects panel.)
        this.layerList.innerHTML = '';

        // Figma-style mask roles: within each group, a mask marks the siblings
        // above it (higher paint index, until the next mask) as "masked". The
        // panel renders front-to-back top-to-bottom, so the masked rows appear
        // ABOVE the mask row and get a wrapping bracket.
        const maskRoles = this._computeMaskRoles();

        // Recursive helper to render a node and its children into a container
        // (the flat list, or a .layer-mask-span wrapper for masked spans).
        const renderNode = (id: number, depth: number, container: HTMLElement) => {
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
            let nodeIsMask = false;
            try { nodeIsMask = this.scene.getNodeIsMask(id); } catch { /* noop */ }
            let nodeIsLivePaint = false;
            try { nodeIsLivePaint = isGroup && this.scene.getNodeLivePaint(id); } catch { /* noop */ }

            const item = document.createElement('div');
            item.className = 'layer-item';
            item.dataset.nodeId = id.toString();
            if (selection.includes(id)) item.classList.add('selected');
            if (nodeVisible === false) item.classList.add('layer-hidden');
            if (nodeLocked === true) item.classList.add('layer-locked');
            const maskRole = maskRoles.get(id);
            if (maskRole === 'mask') item.classList.add('layer-mask-node');
            else if (maskRole === 'masked') item.classList.add('layer-masked');

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
            // Mask badge: a small marker so mask layers are recognizable.
            const maskBadge = nodeIsMask ? `<span class="layer-mask-badge" title="Mask">◐</span>` : '';
            const livePaintBadge = nodeIsLivePaint ? `<span class="layer-lp-badge" title="Live Paint group">Live Paint</span>` : '';
            if (nodeIsLivePaint) item.classList.add('layer-livepaint');

            item.innerHTML = `
                <div class="layer-item-row" style="padding-left: ${indent + 4}px">
                    ${chevronHtml}
                    <span class="layer-icon">${icon}</span>
                    <span class="layer-name" data-node-id="${id}">${nodeName || `Node ${id}`}</span>
                    ${maskBadge}${livePaintBadge}
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

            // Right-click → context menu (same actions as the canvas menu). If the
            // row isn't already in the selection, select it first so the actions
            // target the intended node(s).
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const sel = Array.from(this.scene.getSelection());
                if (!sel.includes(id)) {
                    this.scene.selectNode(id, false);
                    this.syncWithSelection();
                }
                const im = this.scene.renderer?.inputManager;
                if (im) {
                    this.showContextMenu(e.clientX, e.clientY, (action) => im.handleContextMenuAction(action));
                }
            });

            // Double-click to rename
            const nameEl = item.querySelector('.layer-name') as HTMLElement;
            nameEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.startLayerRename(nameEl, { node: id });
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

            container.appendChild(item);

            // Render children if group is expanded
            if (hasChildren && !isCollapsed) {
                renderSiblings(Array.from(children!), depth + 1, container);
            }
        };

        /**
         * Render a sibling list top-to-bottom (reverse of paint order),
         * wrapping each mask span — the masked rows plus the mask row that
         * bounds them — in a single `.layer-mask-span` container so the whole
         * span reads as ONE bracketed unit (Figma-style), not per-row bars.
         */
        const renderSiblings = (siblingsPaintOrder: number[], depth: number, container: HTMLElement) => {
            let span: HTMLElement | null = null;
            for (let i = siblingsPaintOrder.length - 1; i >= 0; i--) {
                const sid = siblingsPaintOrder[i];
                const role = maskRoles.get(sid);
                if (role === 'masked' && !span) {
                    span = document.createElement('div');
                    span.className = 'layer-mask-span';
                    container.appendChild(span);
                }
                renderNode(sid, depth, span ?? container);
                if (role === 'mask' && span) {
                    span = null; // the mask row closes its span
                }
            }
        };

        // Group root nodes under the artboard that spatially contains them
        // (display-only; nodes are not reparented in the engine). Artboards are
        // top-level rows; nodes outside every artboard render loose below.
        const artboards = this.scene.getArtboards();
        const selectedArtboard = this.scene.renderer?.selectedArtboardId ?? null;
        const rootArr = Array.from(rootNodes);

        if (artboards.length === 0) {
            renderSiblings(rootArr, 0, this.layerList);
            return;
        }

        const byArtboard = new Map<number, number[]>();
        for (const ab of artboards) byArtboard.set(ab.id, []);
        const loose: number[] = [];
        for (const rid of rootArr) {
            const abId = this.artboardOfNode(rid, artboards);
            if (abId !== null) byArtboard.get(abId)!.push(rid);
            else loose.push(rid);
        }

        for (const ab of artboards) {
            this.renderArtboardRow(ab, selectedArtboard === ab.id);
            if (!this._collapsedArtboards.has(ab.id)) {
                renderSiblings(byArtboard.get(ab.id)!, 1, this.layerList);
            }
        }
        // Loose nodes (outside any artboard) at the root level.
        renderSiblings(loose, 0, this.layerList);
    }

    /** The id of the smallest artboard whose rect contains the node's bbox center, or null. */
    private artboardOfNode(rootId: number, artboards: Artboard[]): number | null {
        let b: Float32Array;
        try { b = this.scene.getNodeBounds(rootId); } catch { return null; }
        const cx = (b[0] + b[2]) / 2;
        const cy = (b[1] + b[3]) / 2;
        let best: number | null = null;
        let bestArea = Infinity;
        for (const a of artboards) {
            if (cx >= a.x && cx <= a.x + a.w && cy >= a.y && cy <= a.y + a.h) {
                const area = a.w * a.h;
                if (area < bestArea) { bestArea = area; best = a.id; }
            }
        }
        return best;
    }

    /** Render an artboard as a top-level panel row (select + rename + collapse). */
    private renderArtboardRow(ab: Artboard, selected: boolean) {
        const item = document.createElement('div');
        item.className = 'layer-item layer-artboard' + (selected ? ' selected' : '');
        item.dataset.artboardId = ab.id.toString();
        const collapsed = this._collapsedArtboards.has(ab.id);

        item.innerHTML = `
            <div class="layer-item-row" style="padding-left: 4px">
                <span class="layer-chevron ${collapsed ? '' : 'expanded'}" data-ab-toggle="${ab.id}">▸</span>
                <span class="layer-icon">${iconFrame(14)}</span>
                <span class="layer-name" data-ab-id="${ab.id}">${escapeHtml(ab.name)}</span>
            </div>
        `;
        const row = item.querySelector('.layer-item-row') as HTMLElement;
        const chevron = item.querySelector('.layer-chevron') as HTMLElement;
        const nameEl = item.querySelector('.layer-name') as HTMLElement;

        chevron.addEventListener('click', (e) => {
            e.stopPropagation();
            if (collapsed) this._collapsedArtboards.delete(ab.id);
            else this._collapsedArtboards.add(ab.id);
            this.updateLayerList();
        });
        row.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).classList.contains('layer-chevron')) return;
            this.selectArtboardFromPanel(ab.id);
        });
        nameEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.startLayerRename(nameEl, { artboard: ab.id });
        });

        this.layerList.appendChild(item);
    }

    /** Select an artboard from the Objects panel. */
    private selectArtboardFromPanel(id: number) {
        const im = this.scene.renderer?.inputManager;
        if (im) im.selectArtboard(id);
        else if (this.scene.renderer) {
            this.scene.engine?.clear_selection();
            this.scene.renderer.selectedArtboardId = id;
            this.refreshArtboardPanel();
            this.syncWithSelection();
        }
    }

    /** Start inline renaming of a layer row (node OR artboard). */
    private startLayerRename(nameEl: HTMLElement, target: { node: number } | { artboard: number }) {
        const currentName = nameEl.textContent || '';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'layer-rename-input';
        input.value = currentName;

        nameEl.textContent = '';
        nameEl.appendChild(input);
        input.focus();
        input.select();

        // A draggable ancestor blocks caret placement in some browsers; disable
        // dragging on the row while renaming.
        const item = nameEl.closest('.layer-item') as HTMLElement | null;
        if (item) item.draggable = false;

        let done = false;
        const finish = (save: boolean) => {
            if (done) return;
            done = true;
            if (item) item.draggable = true;
            const newName = input.value.trim();
            if (save && newName && newName !== currentName) {
                if ('node' in target) this.scene.setNodeName(target.node, newName);
                else this.scene.setArtboardName(target.artboard, newName);
            }
            this.updateLayerList();
        };

        // Keep pointer events on the input from bubbling to the row (which would
        // select + rebuild the list and destroy the input mid-edit).
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('dblclick', (e) => e.stopPropagation());
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
    }

    /** Compute each node's mask role for the layers panel. Masks are
     *  group-scoped (mirrors the renderer): within a group's children, a mask
     *  marks the non-mask siblings that follow it (higher paint index, until
     *  the next mask) as "masked"; the mask itself is "mask". The root list is
     *  not a mask scope — a root-level is_mask flag is inert. */
    private _computeMaskRoles(): Map<number, 'mask' | 'masked'> {
        const roles = new Map<number, 'mask' | 'masked'>();
        const isMask = (id: number): boolean => {
            try { return this.scene.getNodeIsMask(id); } catch { return false; }
        };
        const visitChildren = (siblings: number[]) => {
            let active = false;
            for (let i = 0; i < siblings.length; i++) {
                const cid = siblings[i];
                if (isMask(cid)) {
                    // Acts as a mask only if a non-mask sibling follows it.
                    const masksSomething = siblings.slice(i + 1).some(c => !isMask(c));
                    if (masksSomething) { active = true; roles.set(cid, 'mask'); }
                    else { active = false; }
                } else if (active) {
                    roles.set(cid, 'masked');
                }
            }
            for (const cid of siblings) {
                const children = Array.from(this.scene.getNodeChildren(cid));
                if (children.length) visitChildren(children);
            }
        };
        // Only group children form mask scopes; roots just recurse into groups.
        for (const rid of Array.from(this.scene.getRootNodes())) {
            const children = Array.from(this.scene.getNodeChildren(rid));
            if (children.length) visitChildren(children);
        }
        return roles;
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

        // A mask belongs to its group. Remember the parent group of every
        // dragged mask BEFORE the move so we can dissolve a group that its mask
        // leaves (a mask group without its mask is a pointless wrapper).
        const maskOldParents = new Map<number, number>();
        for (const d of deduped) {
            if (this._safeIsMask(d)) {
                const p = this.scene.getNodeParent(d);
                if (p !== -1) maskOldParents.set(d, p);
            }
        }

        let moved = 0;
        // reorder + dissolve + flag-clear collapse into ONE undo step.
        this.scene.transaction(() => {
            moved = this.scene.reorderNodes(ordered, newParent, index);
            if (moved <= 0) return;

            const dissolved = new Set<number>();
            for (const [maskId, oldParent] of maskOldParents) {
                const nowParent = this.scene.getNodeParent(maskId);
                if (nowParent === oldParent) continue; // stayed in its group

                // Landing at root makes a mask inert (masks are group-scoped),
                // so it's no longer a mask — drop the flag to avoid a dangling
                // badge. Inside another group it becomes that group's mask.
                if (nowParent === -1) this.scene.setNodeIsMask(maskId, false);

                // Dissolve the vacated group once it no longer holds a mask.
                if (dissolved.has(oldParent)) continue;
                const stillHasMask = Array.from(this.scene.getNodeChildren(oldParent))
                    .some(k => this._safeIsMask(k));
                if (!stillHasMask) {
                    this.scene.ungroupNode(oldParent);
                    dissolved.add(oldParent);
                }
            }
        });

        if (moved > 0) {
            // Reveal the result when dropping into a collapsed group.
            if (zone === 'into') this._collapsedGroups.delete(targetId);
            this.updateLayerList();
            this.syncWithSelection();
        }
    }

    /** is_mask flag, guarded against transient missing-node errors. */
    private _safeIsMask(id: number): boolean {
        try { return this.scene.getNodeIsMask(id); } catch { return false; }
    }

    /**
     * Accept drops on the layer list's empty area (below the last row). Rows
     * handle their own drops; without this, dragging past the last item hits
     * the bare container, the browser rejects the drop, and the drag snaps
     * back — making the bottom-most position unreachable. Dropping here sends
     * the dragged nodes to the back of the root z-order (the panel's last row).
     */
    private _initLayerListEmptyAreaDrop() {
        this.layerList.addEventListener('dragover', (e) => {
            if (!this._draggingLayerIds) return;
            if ((e.target as HTMLElement).closest('.layer-item')) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            this._clearLayerDropIndicators();
            this.layerList.querySelector('.layer-item:last-child .layer-item-row')
                ?.classList.add('drop-below');
        });
        this.layerList.addEventListener('drop', (e) => {
            const dragIds = this._draggingLayerIds;
            if (!dragIds || (e.target as HTMLElement).closest('.layer-item')) return;
            e.preventDefault();
            this._clearLayerDropIndicators();
            this._draggingLayerIds = null;
            const deduped = new Set(this.scene.dedupSelection(dragIds));
            const ordered = this._flattenDrawOrder().filter(id => deduped.has(id));
            if (ordered.length === 0) return;
            if (this.scene.reorderNodes(ordered, null, 0) > 0) {
                this.updateLayerList();
                this.syncWithSelection();
            }
        });
    }

    setZoom(level: number) {
        this.zoomText.innerText = `${Math.round(level * 100)}%`;
        // Keep the context bar's zoom label in sync
        this.contextBar?.refresh();
    }

    exportSVG(bounds?: { x: number; y: number; w: number; h: number }, background?: Color) {
        const svg = this.buildSVGString(bounds, background);
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'export.svg';
        a.click();
        URL.revokeObjectURL(url);
    }

    /** Read the selected node's effects (parsed JSON array). */
    private getSelectedEffects(nodeId: number): any[] {
        try { return JSON.parse(this.scene.getNodeEffects(nodeId)) || []; }
        catch { return []; }
    }

    /** Build a fresh effect object for the given UI type key. */
    private defaultEffect(type: 'blur' | 'shadow' | 'color'): any {
        if (type === 'shadow') return { DropShadow: { dx: 0, dy: 4, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.35 } } };
        if (type === 'color') return { ColorMatrix: { matrix: UIEngine.COLOR_PRESETS.grayscale.slice(), linear_rgb: true } };
        return { Blur: { radius: 6 } };
    }

    /** Add a default drop shadow to the currently-selected node. */
    private addEffectToSelection() {
        const sel = Array.from(this.scene.engine?.get_selection() ?? []);
        if (sel.length !== 1) return;
        const effects = this.getSelectedEffects(sel[0]);
        effects.push(this.defaultEffect('shadow'));
        this.scene.setNodeEffects(sel[0], JSON.stringify(effects));
        this.scene.renderer?.invalidateRenderCaches();
        this.scene.renderer?.requestRender();
        this.renderEffectsList(sel[0]);
    }

    /** Rebuild the effects list UI for a node (or clear it when nodeId is null). */
    private renderEffectsList(nodeId: number | null) {
        const list = document.getElementById('effects-list');
        if (!list) return;
        list.innerHTML = '';
        if (nodeId === null) return;
        const effects = this.getSelectedEffects(nodeId);

        if (effects.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'effect-empty';
            empty.textContent = 'No effects';
            list.appendChild(empty);
            return;
        }

        // Persist edits back to the engine and repaint. `structural` also rebuilds
        // the list DOM (needed when the effect count or type changed).
        const commit = (structural = false) => {
            this.scene.setNodeEffects(nodeId, JSON.stringify(effects));
            this.scene.renderer?.invalidateRenderCaches();
            this.scene.renderer?.requestRender();
            if (structural) this.renderEffectsList(nodeId);
        };

        // Live edits (typing in a number field, dragging the colour picker) fire
        // continuously; wrap them in a gesture so the whole edit collapses into a
        // single undo step while still previewing on every keystroke. The gesture
        // starts lazily on the first real edit, so focusing/tabbing through a
        // field without changing it pushes no undo snapshot.
        const withGesture = (el: HTMLElement, onInput: () => void) => {
            let active = false;
            el.addEventListener('input', () => {
                if (!active) { this.scene.beginGesture(); active = true; }
                onInput();
            });
            el.addEventListener('blur', () => {
                if (active) { this.scene.endGesture(); active = false; }
            });
        };

        // A compact labeled number field (label above a small input), matching
        // the density of the fill/stroke rows.
        const numField = (label: string, val: number, on: (v: number) => void,
                          opts: { step?: number; min?: number; max?: number; suffix?: string } = {}) => {
            const field = document.createElement('div');
            field.className = 'dim-input';
            field.style.flex = '1';
            field.style.height = '24px';
            
            const cap = document.createElement('span');
            cap.className = 'dim-label';
            cap.textContent = label;
            
            const input = document.createElement('input');
            input.type = 'number';
            input.value = String(val);
            if (opts.step !== undefined) input.step = String(opts.step);
            if (opts.min !== undefined) input.min = String(opts.min);
            if (opts.max !== undefined) input.max = String(opts.max);

            const updateVal = () => {
                let v = parseFloat(input.value);
                if (!isFinite(v)) v = 0;
                if (opts.min !== undefined) v = Math.max(opts.min, v);
                if (opts.max !== undefined) v = Math.min(opts.max, v);
                on(v);
                commit();
            };

            withGesture(input, updateVal);
            
            this.makeScrubbable(cap, input, updateVal);

            field.appendChild(cap);
            field.appendChild(input);

            if (opts.suffix) {
                const unit = document.createElement('span');
                unit.className = 'dim-unit';
                unit.textContent = opts.suffix;
                field.appendChild(unit);
            }
            return field;
        };

        effects.forEach((eff, idx) => {
            const item = document.createElement('div');
            item.className = 'effect-item';

            const isShadow = 'DropShadow' in eff;
            const isColor = 'ColorMatrix' in eff;

            // ── Header: type selector + remove ──────────────────────────────
            const head = document.createElement('div');
            head.className = 'effect-head';

            const typeSel = document.createElement('select');
            typeSel.className = 'prop-select';
            typeSel.innerHTML = `<option value="shadow">Drop shadow</option><option value="blur">Layer blur</option><option value="color">Color</option>`;
            typeSel.value = isShadow ? 'shadow' : isColor ? 'color' : 'blur';
            typeSel.addEventListener('change', () => {
                effects[idx] = this.defaultEffect(typeSel.value as 'blur' | 'shadow' | 'color');
                commit(true);
            });
            head.appendChild(typeSel);

            const del = document.createElement('button');
            del.className = 'icon-toggle';
            del.innerHTML = '×';
            del.title = 'Remove effect';
            del.addEventListener('click', () => {
                effects.splice(idx, 1);
                commit(true);
            });
            head.appendChild(del);
            item.appendChild(head);

            // ── Body: type-specific controls ────────────────────────────────
            const body = document.createElement('div');
            body.className = 'effect-body';

            if (isShadow) {
                const d = eff.DropShadow;

                // Color + opacity share the first row.
                const colorRow = document.createElement('div');
                colorRow.className = 'effect-row';
                let shadowGesture = false;
                const applyShadow = (c: Color) => { d.color.r = c.r; d.color.g = c.g; d.color.b = c.b; commit(); };
                const color = createColorSwatch({
                    color: { r: d.color.r, g: d.color.g, b: d.color.b, a: 1 },
                    alpha: false, // opacity has its own field on this row
                    title: 'Shadow color',
                    onInput: (c) => {
                        if (!shadowGesture) { this.scene.beginGesture(); shadowGesture = true; }
                        applyShadow(c);
                    },
                    onChange: (c) => {
                        if (!shadowGesture) { this.scene.beginGesture(); shadowGesture = true; }
                        applyShadow(c);
                        this.scene.endGesture(); shadowGesture = false;
                    },
                });
                colorRow.appendChild(color.el);
                colorRow.appendChild(numField('Opacity', Math.round((d.color.a ?? 0) * 100),
                    v => d.color.a = Math.max(0, Math.min(1, v / 100)), { min: 0, max: 100, suffix: '%' }));
                body.appendChild(colorRow);

                // Offset X / Y and blur.
                const geomRow = document.createElement('div');
                geomRow.className = 'effect-row';
                geomRow.appendChild(numField('X', d.dx, v => d.dx = v, { step: 1 }));
                geomRow.appendChild(numField('Y', d.dy, v => d.dy = v, { step: 1 }));
                geomRow.appendChild(numField('Blur', d.blur, v => d.blur = v, { step: 1, min: 0 }));
                body.appendChild(geomRow);
            } else if (isColor) {
                const cm = eff.ColorMatrix;
                const presetRow = document.createElement('div');
                presetRow.className = 'effect-row';
                const presetSel = document.createElement('select');
                presetSel.className = 'prop-select';
                presetSel.style.flex = '1';
                const names = Object.keys(UIEngine.COLOR_PRESETS);
                const cur = names.find(nm => UIEngine.COLOR_PRESETS[nm].every((x, i) => Math.abs(x - cm.matrix[i]) < 1e-4));
                presetSel.innerHTML = names.map(nm => `<option value="${nm}">${nm[0].toUpperCase() + nm.slice(1)}</option>`).join('')
                    + (cur ? '' : `<option value="__custom" selected>Custom</option>`);
                if (cur) presetSel.value = cur;
                presetSel.addEventListener('change', () => {
                    const preset = UIEngine.COLOR_PRESETS[presetSel.value];
                    if (preset) { cm.matrix = preset.slice(); commit(); }
                });
                presetRow.appendChild(presetSel);
                body.appendChild(presetRow);
            } else {
                const b = eff.Blur;
                const blurRow = document.createElement('div');
                blurRow.className = 'effect-row';
                blurRow.appendChild(numField('Blur', b.radius, v => b.radius = v, { step: 1, min: 0 }));
                body.appendChild(blurRow);
            }

            item.appendChild(body);
            list.appendChild(item);
        });
    }

    /** Export the document as a PNG raster (2× by default) and download it. */
    exportPNG(scale = 2, bounds?: { x: number; y: number; w: number; h: number }, background?: Color) {
        const blob = this.scene.renderer?.exportPNG(scale, bounds, background);
        if (!blob) {
            console.error('PNG export failed (no renderer or surface unavailable)');
            return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'export.png';
        a.click();
        URL.revokeObjectURL(url);
    }

    /** Build a high-fidelity SVG string containing ONLY the selected shape nodes and their children. */
    buildSVGStringForSelection(selection: number[], bounds?: { x: number; y: number; w: number; h: number }, background?: Color): string {
        const docW = this.scene.engine?.get_document_width() ?? 1000;
        const docH = this.scene.engine?.get_document_height() ?? 1000;

        const topSelected = Array.from(this.scene.dedupSelection(selection));

        const nodes: SVGExportInput['nodes'] = {};
        const localTransforms: SVGExportInput['localTransforms'] = {};
        const imageIds = new Set<number>();

        const collectNodeData = (id: number, isTopLevel: boolean) => {
            const node = this.scene.getNode(id);
            if (!node) return;
            if (node.geometry?.Path && this.scene.engine) {
                const resolved = this.scene.getResolvedSubpaths(id);
                if (resolved.length) node.geometry.Path.subpaths = resolved;
            }
            nodes[id] = node;

            if (isTopLevel) {
                const t = this.scene.getTransform(id);
                // Convert Skia row-major [a, b, tx, c, d, ty, ...] to column-major [a, b, 0, c, d, 0, tx, ty, 1]
                localTransforms[id] = [t[0], t[1], 0, t[3], t[4], 0, t[2], t[5], 1];
            } else {
                localTransforms[id] = Array.from(this.scene.getNodeLocalTransform(id));
            }

            if (node.geometry?.Image) imageIds.add(node.geometry.Image.image_id);
            for (const p of node.style?.fills ?? []) if (p && (p as { image_id?: number }).image_id != null) imageIds.add((p as { image_id: number }).image_id);
            for (const st of node.style?.strokes ?? []) { const p = st?.paint as { image_id?: number } | undefined; if (p?.image_id != null) imageIds.add(p.image_id); }
            if (node.node_type === 'Group') {
                const children = this.scene.getNodeChildren(id);
                for (const childId of Array.from(children)) {
                    collectNodeData(childId, false);
                }
            }
        };

        for (const rootId of topSelected) {
            collectNodeData(rootId, true);
        }

        // Encode referenced images as base64 data URIs
        let imageDataUris: Record<number, string> | undefined;
        if (imageIds.size > 0 && this.scene.engine) {
            imageDataUris = {};
            for (const imgId of imageIds) {
                const bytes = this.scene.engine.get_image_bytes(imgId);
                if (!bytes || bytes.length === 0) continue;
                const mime = this.scene.engine.get_image_mime(imgId) || 'image/png';
                let bin = '';
                for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                imageDataUris[imgId] = `data:${mime};base64,${btoa(bin)}`;
            }
        }

        let livePaint: LivePaintRenderData | undefined;
        let filledFaces: FilledFace[] | undefined;
        if (this.scene.engine) {
            try {
                const data = JSON.parse(this.scene.engine.get_live_paint_render_data()) as LivePaintRenderData;
                if (data.groups && data.groups.length > 0) livePaint = data;
            } catch { /* no live paint */ }
            if (!livePaint) {
                try {
                    const parsed = JSON.parse(this.scene.engine.get_filled_faces()) as FilledFace[];
                    if (parsed.length > 0) filledFaces = parsed;
                } catch { /* no faces */ }
            }
        }

        const svg = buildSVGFromData({
            docWidth: docW,
            docHeight: docH,
            nodes,
            rootNodeIds: topSelected,
            localTransforms,
            filledFaces,
            livePaint,
            imageDataUris,
            viewBox: bounds,
            background,
        });

        return svg;
    }

    /** Handle Figma-style exporting of selections, artboards, or canvas. */
    async exportSelection() {
        const scaleSelect = this.exportPaneScale;
        const formatSelect = this.exportPaneFormat;
        const suffixInput = this.exportPaneSuffix;
        const transparentInput = this.exportPaneTransparent;

        const scale = parseFloat(scaleSelect?.value || '1');
        const format = (formatSelect?.value || 'png') as 'png' | 'svg';
        const suffix = suffixInput?.value || '';
        const transparent = transparentInput ? transparentInput.checked : true;

        const selection = Array.from(this.scene.engine?.get_selection() ?? []);
        const artboardId = this.scene.renderer?.selectedArtboardId ?? null;
        const ab = artboardId !== null ? this.scene.getArtboards().find(a => a.id === artboardId) : undefined;

        let filename = 'export';
        let bounds: { x: number; y: number; w: number; h: number } | undefined = undefined;
        let background: { r: number; g: number; b: number; a: number } | undefined = undefined;

        if (ab) {
            filename = ab.name || 'artboard';
            bounds = { x: ab.x, y: ab.y, w: ab.w, h: ab.h };
            if (!transparent) {
                background = ab.background;
            }
        } else if (selection.length > 0) {
            if (selection.length === 1) {
                filename = this.scene.getNodeName(selection[0]) || 'selection';
            } else {
                filename = 'selection';
            }

            // Calculate bounds of selection
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const id of selection) {
                const b = this.scene.getNodeBounds(id);
                if (b) {
                    minX = Math.min(minX, b[0]);
                    minY = Math.min(minY, b[1]);
                    maxX = Math.max(maxX, b[2]);
                    maxY = Math.max(maxY, b[3]);
                }
            }
            if (minX !== Infinity) {
                bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
            }

            if (!transparent) {
                background = { r: 1, g: 1, b: 1, a: 1 }; // Default to white background if not transparent
            }
        } else {
            filename = 'canvas';
            bounds = {
                x: 0,
                y: 0,
                w: this.scene.engine?.get_document_width() ?? 1000,
                h: this.scene.engine?.get_document_height() ?? 1000
            };
            if (!transparent) {
                background = { r: 1, g: 1, b: 1, a: 1 };
            }
        }

        // Apply suffix
        filename = filename + suffix + '.' + format;

        if (format === 'svg') {
            let svgString = '';
            if (selection.length > 0) {
                svgString = this.buildSVGStringForSelection(selection, bounds, background);
            } else {
                svgString = this.buildSVGString(bounds, background);
            }

            const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 100);
        } else {
            // PNG format
            let blob: Blob | null | undefined = null;

            if (selection.length > 0) {
                // High-fidelity selection-only export via native CanvasKit visibility toggling
                const originalVisibility: Record<number, boolean> = {};
                const collectAllNodes = (id: number) => {
                    originalVisibility[id] = this.scene.getNodeVisible(id);
                    const children = this.scene.getNodeChildren(id);
                    for (const childId of Array.from(children)) {
                        collectAllNodes(childId);
                    }
                };
                for (const rootId of Array.from(this.scene.getRootNodes())) {
                    collectAllNodes(rootId);
                }

                // Collect descendants of selection
                const selectionDescendants = new Set<number>();
                const collectDescendants = (id: number) => {
                    selectionDescendants.add(id);
                    const children = this.scene.getNodeChildren(id);
                    for (const childId of Array.from(children)) {
                        collectDescendants(childId);
                    }
                };
                for (const id of selection) {
                    collectDescendants(id);
                }

                // Temporarily hide anything that is not a selected node or its descendant
                for (const id of Object.keys(originalVisibility).map(Number)) {
                    if (!selectionDescendants.has(id)) {
                        this.scene.setNodeVisible(id, false);
                    }
                }

                // Call the regular working artboard/canvas PNG exporter inside CanvasKit
                blob = this.scene.renderer?.exportPNG(scale, bounds, background);

                // Restore original visibility flags instantly
                for (const id of Object.keys(originalVisibility).map(Number)) {
                    this.scene.setNodeVisible(id, originalVisibility[id]);
                }
            } else {
                // Artboard / Canvas exports use Skia/CanvasKit renderer directly
                blob = this.scene.renderer?.exportPNG(scale, bounds, background);
            }

            if (blob) {
                const downloadUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = downloadUrl;
                a.download = filename;
                a.click();
                setTimeout(() => URL.revokeObjectURL(downloadUrl), 100);
            } else {
                console.error('PNG export failed (no renderer or surface unavailable)');
            }
        }
    }

    /** Build the full SVG document string (with embedded .dataki payload). */
    buildSVGString(bounds?: { x: number; y: number; w: number; h: number }, background?: Color): string {
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
            if (node.geometry?.Image) imageIds.add(node.geometry.Image.image_id);
            // Pattern fills/strokes reference a tile image that must be exported too.
            for (const p of node.style?.fills ?? []) if (p && (p as { image_id?: number }).image_id != null) imageIds.add((p as { image_id: number }).image_id);
            for (const st of node.style?.strokes ?? []) { const p = st?.paint as { image_id?: number } | undefined; if (p?.image_id != null) imageIds.add(p.image_id); }
            if (node.node_type === 'Group') {
                const children = this.scene.getNodeChildren(id);
                for (const childId of Array.from(children)) {
                    collectNodeData(childId);
                }
            }
        };
        const imageIds = new Set<number>();
        for (const rootId of rootNodeIds) {
            collectNodeData(rootId);
        }

        // Encode referenced images as base64 data URIs for <image href>.
        let imageDataUris: Record<number, string> | undefined;
        if (imageIds.size > 0 && this.scene.engine) {
            imageDataUris = {};
            for (const imgId of imageIds) {
                const bytes = this.scene.engine.get_image_bytes(imgId);
                if (!bytes || bytes.length === 0) continue;
                const mime = this.scene.engine.get_image_mime(imgId) || 'image/png';
                let bin = '';
                for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                imageDataUris[imgId] = `data:${mime};base64,${btoa(bin)}`;
            }
        }

        // Collect per-group Live Paint render data — faces (effective color)
        // draw under each group's member strokes, painted edges on top, mirroring
        // the in-app compositing. Falls back to `filledFaces` if none.
        let livePaint: LivePaintRenderData | undefined;
        let filledFaces: FilledFace[] | undefined;
        if (this.scene.engine) {
            try {
                const data = JSON.parse(this.scene.engine.get_live_paint_render_data()) as LivePaintRenderData;
                if (data.groups && data.groups.length > 0) livePaint = data;
            } catch { /* no live paint */ }
            if (!livePaint) {
                try {
                    const parsed = JSON.parse(this.scene.engine.get_filled_faces()) as FilledFace[];
                    if (parsed.length > 0) filledFaces = parsed;
                } catch { /* no faces */ }
            }
        }

        let svg = buildSVGFromData({
            docWidth: docW,
            docHeight: docH,
            nodes,
            rootNodeIds,
            localTransforms,
            filledFaces,
            livePaint,
            imageDataUris,
            viewBox: bounds,
            background,
        });

        // Embed the binary .dataki payload for round-tripping
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

    /** Type of a rasterized `<pattern>` tile, keyed by pattern element id. */
    // (map value shape is inlined; see rasterizePatterns)

    /**
     * Import an SVG document as ONE undo step. `<pattern>` fills are rasterized
     * to tile images first (async), then the rest of the import runs
     * synchronously so post-processing (`afterImport`, e.g. drop-centering)
     * still happens inside the same transaction.
     */
    async parseSVG(svgText: string, afterImport?: (newRootIds: number[]) => void) {
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const patternImages = await this.rasterizePatterns(doc);
        // Rasterize elements whose filter has primitives we can't map natively;
        // this tags them with __rasterFilter which parseSVGInternal turns into an
        // image node. (Uses the SAME doc so the tags survive to the sync pass.)
        await this.rasterizeFilteredElements(doc);
        // Decode <image> elements up-front (intrinsic size, preserveAspectRatio
        // fitting, SVG-in-image rasterization); tags each with __imageFit.
        await this.preprocessImages(doc);
        this.scene.transaction(() => {
            const before = new Set(this.scene.getRootNodes());
            this.parseSVGInternal(svgText, patternImages, doc);
            if (afterImport) {
                const newRoots = Array.from(this.scene.getRootNodes()).filter(id => !before.has(id));
                afterImport(newRoots);
            }
        });
    }

    /** Gather all referenced definitions (for a standalone rasterize tile) as an
     *  HTML string. Filters/gradients/patterns are frequently declared as DIRECT
     *  children of <svg>, not inside <defs> — collecting only <defs> leaves the
     *  reference unresolved, so the element rasterizes raw (unfiltered). This
     *  collects <defs> contents PLUS any definition element declared outside a
     *  <defs>. */
    private collectDefsHtml(doc: Document): string {
        const parts: string[] = [];
        for (const d of Array.from(doc.querySelectorAll('defs'))) parts.push(d.innerHTML);
        for (const def of Array.from(doc.querySelectorAll(
            'filter, linearGradient, radialGradient, pattern, clipPath, mask, symbol, marker, style'))) {
            if (!def.closest('defs')) parts.push(def.outerHTML);
        }
        return parts.join('');
    }

    /** For each element whose filter can't be mapped to native effects,
     *  rasterize element+filter to an image and tag it with `__rasterFilter`. */
    private async rasterizeFilteredElements(doc: Document): Promise<void> {
        const svg = doc.querySelector('svg');
        if (!svg) return;
        // Candidates: elements with a filter= attr whose filter is unsupported.
        const candidates: Element[] = [];
        for (const el of Array.from(doc.querySelectorAll('[filter]'))) {
            if (this.parseFilterEffects(el, doc) === 'rasterize') candidates.push(el);
        }
        if (candidates.length === 0) return;

        // getBBox needs the SVG live in the document; attach a hidden clone-host.
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden';
        const liveSvg = svg.cloneNode(true) as SVGSVGElement;
        host.appendChild(liveSvg);
        document.body.appendChild(host);
        const defsHtml = this.collectDefsHtml(doc);
        try {
            for (const el of candidates) {
                const id = el.getAttribute('id');
                // Find the matching live element for getBBox.
                const live = id ? liveSvg.querySelector(`#${CSS.escape(id)}`) : null;
                let bx = 0, by = 0, bw = 0, bh = 0;
                try {
                    const bb = (live as SVGGraphicsElement | null)?.getBBox?.();
                    if (bb) { bx = bb.x; by = bb.y; bw = bb.width; bh = bb.height; }
                } catch { /* getBBox may throw for empty geometry */ }
                if (bw <= 0 || bh <= 0) continue;
                // Expand for filter overflow (blur/offset spill past the geometry).
                const mx = Math.max(bw, bh) * 0.4 + 10;
                bx -= mx; by -= mx; bw += 2 * mx; bh += 2 * mx;
                const scale = 2;
                const tile = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
                    `width="${bw * scale}" height="${bh * scale}" viewBox="${bx} ${by} ${bw} ${bh}"><defs>${defsHtml}</defs>${el.outerHTML}</svg>`;
                const bytes = await this.rasterizeSvgToPng(tile, Math.round(bw * scale), Math.round(bh * scale), true);
                if (!bytes) continue; // blank tile → fall back to normal element rendering
                let imageId = 0;
                try { imageId = this.scene.engine!.register_image(bytes, 'image/png'); } catch { continue; }
                (el as unknown as { __rasterFilter?: unknown }).__rasterFilter = { imageId, x: bx, y: by, w: bw, h: bh };
            }
        } finally {
            document.body.removeChild(host);
        }
    }

    /**
     * Decode every data-URI `<image>` up-front and tag it with `__imageFit`
     * (image id + the final local rect). Handles: intrinsic sizing when
     * width/height are omitted/auto; `preserveAspectRatio` (meet letterboxing,
     * slice cropping, alignment); and SVG-in-`<image>` (CanvasKit can't decode
     * SVG, so we rasterize it to PNG). External hrefs are left for the sync pass
     * (unsupported). Runs in the async pre-pass so the sync importer stays sync.
     */
    private async preprocessImages(doc: Document): Promise<void> {
        const XLINK = 'http://www.w3.org/1999/xlink';
        for (const el of Array.from(doc.querySelectorAll('image'))) {
            const href = el.getAttribute('href') || el.getAttributeNS(XLINK, 'href') || '';
            if (!href.startsWith('data:')) continue; // external → sync pass warns
            const parsed = this.parseImageDataUri(href);
            if (!parsed) continue;
            // svgz: gunzip to plain SVG so the browser can load/rasterize it.
            if (parsed.bytes.length > 2 && parsed.bytes[0] === 0x1f && parsed.bytes[1] === 0x8b) {
                const svgText = await this.gunzip(parsed.bytes);
                if (!svgText) continue;
                parsed.bytes = new TextEncoder().encode(svgText);
                parsed.loadUri = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)));
            }
            // Browser decodes png/jpeg/gif/svg → gives us the intrinsic size.
            const img = await this.loadImage(parsed.loadUri).catch(() => null);
            if (!img) continue;
            const natW = img.naturalWidth || img.width;
            const natH = img.naturalHeight || img.height;
            if (!natW || !natH) continue;

            // Viewport rect from x/y/width/height, with intrinsic fallback for
            // omitted/auto dimensions (a single given side keeps the aspect).
            const x = parseSvgLength(el.getAttribute('x'), 0);
            const y = parseSvgLength(el.getAttribute('y'), 0);
            const wAttr = el.getAttribute('width');
            const hAttr = el.getAttribute('height');
            const hasW = !!wAttr && wAttr !== 'auto';
            const hasH = !!hAttr && hAttr !== 'auto';
            let vw = hasW ? parseSvgLength(wAttr, 0) : 0;
            let vh = hasH ? parseSvgLength(hAttr, 0) : 0;
            if (!hasW && !hasH) { vw = natW; vh = natH; }
            else if (!hasW) { vw = vh * natW / natH; }
            else if (!hasH) { vh = vw * natH / natW; }
            if (vw <= 0 || vh <= 0) continue;

            const par = (el.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim();
            // A raster image needs re-rasterizing ONLY when preserveAspectRatio
            // actually letterboxes/crops it — i.e. when the box aspect differs
            // from the image's. Otherwise register the original bytes (keeps
            // full fidelity, e.g. 16-bit PNGs, and avoids a re-encode).
            const aspectMatches = Math.abs(vw / vh - natW / natH) < 1e-3;
            const stretch = !parsed.isSvg && (par.startsWith('none') || aspectMatches);
            let imageId: number;
            if (stretch) {
                try { imageId = this.scene.engine!.register_image(parsed.bytes, parsed.mime); }
                catch { continue; }
            } else {
                // Rasterize onto a viewport-sized canvas honoring
                // preserveAspectRatio (letterbox/crop/align + clipping), or
                // convert SVG→PNG. 2× for crispness.
                const bytes = await this.rasterizeImageFit(img, vw, vh, natW, natH, par);
                if (!bytes) continue;
                try { imageId = this.scene.engine!.register_image(bytes, 'image/png'); }
                catch { continue; }
            }
            (el as unknown as { __imageFit?: unknown }).__imageFit = { imageId, x, y, w: vw, h: vh };
        }
    }

    /** Parse a `data:` URI into raw bytes + mime + an <img>-loadable URI,
     *  transparently gunzipping `.svgz` (gzip-compressed SVG). */
    private parseImageDataUri(href: string): { bytes: Uint8Array; mime: string; isSvg: boolean; loadUri: string } | null {
        const m = href.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
        if (!m) return null;
        let mime = (m[1] || 'image/png').toLowerCase();
        let bytes: Uint8Array;
        if (m[2]) {
            const bin = atob(m[3]);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
            bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
        }
        // gzip magic → svgz. (DecompressionStream isn't sync; handled in loadImage.)
        const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
        const isSvg = mime.includes('svg') || isGzip ||
            (mime === 'image/png' && /^\s*<(\?xml|svg)/.test(new TextDecoder().decode(bytes.slice(0, 64))));
        if (isSvg && !mime.includes('svg')) mime = 'image/svg+xml';
        // For <img> loading we hand back the original href (browsers load svg/
        // svgz/png/jpeg data URIs directly); gzip svgz is expanded in loadImage.
        return { bytes, mime, isSvg, loadUri: href };
    }

    /** Load a data URI into an HTMLImageElement (decodes intrinsic size). */
    private loadImage(uri: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('image load failed'));
            img.src = uri;
        });
    }

    /** Gunzip bytes to a UTF-8 string (for .svgz), or null on failure. */
    private async gunzip(bytes: Uint8Array): Promise<string | null> {
        try {
            const ds = new (window as unknown as { DecompressionStream: new (f: string) => GenericTransformStream }).DecompressionStream('gzip');
            const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
            const buf = await new Response(stream).arrayBuffer();
            return new TextDecoder().decode(buf);
        } catch { return null; }
    }

    /** Draw `img` onto a `vw×vh` canvas honoring preserveAspectRatio (align +
     *  meet/slice), clipping to the viewport, and return PNG bytes. */
    private rasterizeImageFit(img: HTMLImageElement, vw: number, vh: number, natW: number, natH: number, par: string): Promise<Uint8Array | null> {
        const scale = 2;
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(vw * scale));
        c.height = Math.max(1, Math.round(vh * scale));
        const ctx = c.getContext('2d');
        if (!ctx) return Promise.resolve(null);
        const tokens = par.split(/\s+/);
        const align = tokens[0] || 'xMidYMid';
        const slice = tokens[1] === 'slice';
        let dw: number, dh: number, dx: number, dy: number;
        if (align === 'none') {
            dw = vw; dh = vh; dx = 0; dy = 0;
        } else {
            const s = slice ? Math.max(vw / natW, vh / natH) : Math.min(vw / natW, vh / natH);
            dw = natW * s; dh = natH * s;
            const ax = align.includes('xMax') ? 1 : align.includes('xMid') ? 0.5 : 0;
            const ay = align.includes('YMax') ? 1 : align.includes('YMid') ? 0.5 : 0;
            dx = (vw - dw) * ax;
            dy = (vh - dh) * ay;
        }
        ctx.drawImage(img, dx * scale, dy * scale, dw * scale, dh * scale);
        return new Promise((resolve) => {
            c.toBlob(async (b) => resolve(b ? new Uint8Array(await b.arrayBuffer()) : null), 'image/png');
        });
    }

    /** Rasterize every `<pattern>` in the doc to a tile image (via the browser's
     *  SVG renderer), registering each and returning id → tile descriptor. */
    private async rasterizePatterns(doc: Document): Promise<Map<string, { image_id: number; width: number; height: number; transform: number[] }>> {
        const map = new Map<string, { image_id: number; width: number; height: number; transform: number[] }>();
        const defsHtml = this.collectDefsHtml(doc);
        for (const pat of Array.from(doc.querySelectorAll('pattern'))) {
            const id = pat.getAttribute('id');
            if (!id) continue;
            const w = parseSvgLength(pat.getAttribute('width'), 0);
            const h = parseSvgLength(pat.getAttribute('height'), 0);
            // Only userSpaceOnUse-style pixel tiles are supported in v1;
            // objectBoundingBox fractions (<=2) can't be sized without the shape.
            if (!(w > 2 && h > 2)) continue;
            const scale = 2; // rasterize at 2× for crispness
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
                `width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}"><defs>${defsHtml}</defs>${pat.innerHTML}</svg>`;
            const bytes = await this.rasterizeSvgToPng(svg, Math.round(w * scale), Math.round(h * scale));
            if (!bytes) continue;
            let imageId = 0;
            try { imageId = this.scene.engine!.register_image(bytes, 'image/png'); } catch { continue; }
            // patternTransform (3×3 col-major) → SVG 2×3 [a,b,c,d,e,f].
            const pt = pat.getAttribute('patternTransform');
            let transform = [1, 0, 0, 1, 0, 0];
            if (pt) { const m = parseSVGTransform(pt); transform = [m[0], m[1], m[3], m[4], m[6], m[7]]; }
            map.set(id, { image_id: imageId, width: w, height: h, transform });
        }
        return map;
    }

    /** Render an SVG string to PNG bytes at the given pixel size (async). */
    private rasterizeSvgToPng(svgString: string, pxW: number, pxH: number, requireContent = false): Promise<Uint8Array | null> {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const c = document.createElement('canvas');
                    c.width = pxW; c.height = pxH;
                    const ctx = c.getContext('2d');
                    if (!ctx) { resolve(null); return; }
                    ctx.drawImage(img, 0, 0, pxW, pxH);
                    // When rasterizing a filtered element, a fully-transparent tile
                    // means the browser couldn't render the filter (e.g. feComposite
                    // with no in2, or degenerate no-op filters Chrome drops). In that
                    // case the fallback would be strictly worse than just rendering
                    // the element normally, so bail and let normal processing run.
                    if (requireContent && this.canvasIsBlank(ctx, pxW, pxH)) { resolve(null); return; }
                    c.toBlob(async (b) => resolve(b ? new Uint8Array(await b.arrayBuffer()) : null), 'image/png');
                } catch { resolve(null); }
            };
            img.onerror = () => resolve(null);
            img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgString)));
        });
    }

    /** True when every pixel of the canvas is (near-)transparent. Sampled on a
     *  grid so large tiles stay cheap. */
    private canvasIsBlank(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
        if (w <= 0 || h <= 0) return true;
        try {
            const data = ctx.getImageData(0, 0, w, h).data;
            const stride = Math.max(1, Math.floor((w * h) / 40000)); // cap samples
            for (let i = 3; i < data.length; i += 4 * stride) {
                if (data[i] > 2) return false;
            }
            return true;
        } catch { return false; } // tainted/oversized → assume content, keep tile
    }

    private parseSVGInternal(svgText: string, patternImages?: Map<string, { image_id: number; width: number; height: number; transform: number[] }>, docIn?: Document) {
        // Reuse the doc from parseSVG when given (so __rasterFilter tags on
        // elements survive); otherwise parse fresh.
        const doc = docIn ?? new DOMParser().parseFromString(svgText, 'image/svg+xml');
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
        // Many SVGs (Illustrator "Style Elements" export, SVGO output, hand-
        // authored files) put fills/strokes in <style> blocks and reference
        // them by class / id / element selector — e.g. `.cls-1{fill:#e00}`,
        // `#logo{...}`, `path{...}`. The parse/match logic lives in svg_css.ts
        // (pure + unit-tested); here we just build the rule list once and
        // memoize the per-element result. These sit between inline style="" and
        // presentation attributes in the cascade (see getStyleAttr).
        const cssRules = parseSvgStylesheet(svg);
        const cssMatchCache = new Map<Element, Record<string, CssDecl>>();

        /** Winning CSS declaration per property for an element (cascade-resolved, memoized). */
        const getMatchedCSSStyles = (el: Element): Record<string, CssDecl> => {
            const cached = cssMatchCache.get(el);
            if (cached) return cached;
            const result = matchedCssStyles(el, cssRules);
            cssMatchCache.set(el, result);
            return result;
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

        // Get attribute with cascade:
        //   !important CSS rule > inline style="" > normal CSS rule > presentation attribute
        // (inline !important is not distinguished — a rare simplification.)
        const getStyleAttr = (el: Element, attr: string, inlineStyles: Record<string, string>): string | null => {
            const css = getMatchedCSSStyles(el)[attr];
            if (css && css.important) return css.value;
            if (inlineStyles[attr]) return inlineStyles[attr];
            if (css) return css.value;
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
        type ParsedPaint =
            | { type: 'solid'; hex: string; alpha: number }
            | { type: 'gradient'; data: SVGGradientData }
            | { type: 'pattern'; pattern: { image_id: number; width: number; height: number; transform: number[] } };

        /** If `paintUrl` is url(#id) referencing a rasterized <pattern>, return it. */
        const resolvePatternRef = (paintUrl: string): ParsedPaint | null => {
            const m = paintUrl.match(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/);
            const p = m && patternImages?.get(m[1]);
            return p ? { type: 'pattern', pattern: p } : null;
        };

        const parseFill = (el: Element, inlineStyles: Record<string, string>, inherited: InheritedStyles, geo?: GradientGeo): ParsedPaint | null => {
            const fill = resolveAttr(el, 'fill', inlineStyles, inherited, '#000000');
            if (fill === 'none' || fill === 'transparent') return null;
            // Paint-server url(#...): pattern (rasterized tile) or gradient.
            if (fill && fill.match(/url\s*\(/)) {
                const pat = resolvePatternRef(fill);
                if (pat) return pat;
                const grad = resolveGradient(doc, fill, geo);
                if (grad) return { type: 'gradient', data: grad };
                return null;
            }
            const parsed = parseCssColor(fill || '');
            return parsed ? { type: 'solid', hex: parsed.hex, alpha: parsed.alpha } : null;
        };

        const parseStroke = (el: Element, inlineStyles: Record<string, string>, inherited: InheritedStyles, geo?: GradientGeo): ParsedPaint | null => {
            const stroke = resolveAttr(el, 'stroke', inlineStyles, inherited, null);
            if (!stroke || stroke === 'none' || stroke === 'transparent') return null;
            if (stroke.match(/url\s*\(/)) {
                const pat = resolvePatternRef(stroke);
                if (pat) return pat;
                const grad = resolveGradient(doc, stroke, geo);
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
            if (paint.type === 'pattern') {
                // Matches the engine's Pattern struct (image_id discriminates it).
                return { ...paint.pattern };
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
                spread: paint.data.spread ?? 0,
                ...(paint.data.focal ? { focal: paint.data.focal } : {}),
            };
        };

        const applyStyle = (id: number, el: Element, inherited: InheritedStyles, geo?: GradientGeo) => {
            const inlineStyles = parseInlineStyle(el);
            const fillPaint = parseFill(el, inlineStyles, inherited, geo);
            const strokePaint = parseStroke(el, inlineStyles, inherited, geo);
            const sw = parseSvgLength(resolveAttr(el, 'stroke-width', inlineStyles, inherited, '1'), 1);
            const op = parseFloat(resolveAttr(el, 'opacity', inlineStyles, inherited, '1') || '1');

            // Parse fill-opacity and stroke-opacity (multiply into paint alpha)
            const fillOpacity = parseFloat(resolveAttr(el, 'fill-opacity', inlineStyles, inherited, '1') || '1');
            const strokeOpacity = parseFloat(resolveAttr(el, 'stroke-opacity', inlineStyles, inherited, '1') || '1');

            // Paint objects (solid {r,g,b,a} or gradient) for the engine's
            // multi-fill/multi-stroke Style. NOTE: the engine's Style requires
            // `fills`/`strokes` ARRAYS — emitting the legacy singular
            // `fill`/`stroke` keys makes set_node_style silently drop the whole
            // style (missing required `fills`), so imported shapes fall back to
            // the default gray. Always emit the array shape.
            const fill = paintToJson(fillPaint, fillOpacity);
            const strokePaintJson = paintToJson(strokePaint, strokeOpacity);

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

            // Parse stroke-dasharray / -dashoffset
            let dashArray: number[] = [];
            const dashArr = resolveAttr(el, 'stroke-dasharray', inlineStyles, inherited, null);
            if (dashArr && dashArr !== 'none') {
                dashArray = dashArr.split(/[,\s]+/).map(Number).filter(n => !isNaN(n));
            }
            let dashOffset = 0;
            const dashOff = resolveAttr(el, 'stroke-dashoffset', inlineStyles, inherited, null);
            if (dashOff) dashOffset = parseFloat(dashOff) || 0;

            // Corner radius (rects)
            let cornerRadius = 0;
            const rx = el.getAttribute('rx');
            if (rx) cornerRadius = parseSvgLength(rx, 0);

            // mix-blend-mode from inline style
            let blendMode = 0;
            const blendStr = inlineStyles['mix-blend-mode'];
            if (blendStr) {
                const bmIdx = BLEND_MODE_MAP.indexOf(blendStr.trim() as typeof BLEND_MODE_MAP[number]);
                if (bmIdx > 0) blendMode = bmIdx;
            }

            const style = {
                fills: fill ? [fill] : [],
                strokes: strokePaintJson ? [{
                    paint: strokePaintJson,
                    width: sw,
                    cap: strokeCap,
                    join: strokeJoin,
                    dash_array: dashArray,
                    dash_offset: dashOffset,
                    miter_limit: miterLimit,
                    alignment: 'Center',
                }] : [],
                opacity: op,
                blend_mode: blendMode,
                fill_rule: fillRule,
                corner_radius: cornerRadius,
            };

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

        // ─── Markers (marker-start / -mid / -end, arrowheads) ────────────────
        // Resolved at import: the referenced <marker>'s shapes are baked as
        // nodes at each vertex, oriented to the path tangent and scaled by the
        // stroke width, since the engine has no native marker concept.
        const bisector = (a1: number, a2: number) =>
            Math.atan2(Math.sin(a1) + Math.sin(a2), Math.cos(a1) + Math.cos(a2));

        /** Resolve a marker-* property (or the `marker` shorthand) to a def id. */
        const markerRef = (el: Element, prop: string, inlineStyles: Record<string, string>, inherited: InheritedStyles): string | null => {
            const specific = resolveAttr(el, prop, inlineStyles, inherited, null);
            const shorthand = resolveAttr(el, 'marker', inlineStyles, inherited, null);
            const v = (specific && specific !== 'none') ? specific : (shorthand && shorthand !== 'none' ? shorthand : null);
            const m = v?.match(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/);
            return m ? m[1] : null;
        };

        /** Vertices (local coords) with tangent angle (radians) and marker kind. */
        const markerVertices = (el: Element, tag: string): { x: number; y: number; angle: number; kind: 'start' | 'mid' | 'end' }[] => {
            const anchors: { x: number; y: number; out?: number; in_?: number }[] = [];
            let closed = false;
            if (tag === 'line') {
                anchors.push({ x: parseSvgLength(el.getAttribute('x1'), 0), y: parseSvgLength(el.getAttribute('y1'), 0) });
                anchors.push({ x: parseSvgLength(el.getAttribute('x2'), 0), y: parseSvgLength(el.getAttribute('y2'), 0) });
            } else if (tag === 'polyline' || tag === 'polygon') {
                const nums = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
                for (let i = 0; i + 1 < nums.length; i += 2) anchors.push({ x: nums[i], y: nums[i + 1] });
                closed = tag === 'polygon';
            } else if (tag === 'path') {
                for (const sp of parseSVGPathDUtil(el.getAttribute('d') || '', 0, 0)) {
                    for (const p of sp.points) {
                        const out = (Math.abs(p.cp2[0] - p.x) > 1e-6 || Math.abs(p.cp2[1] - p.y) > 1e-6) ? Math.atan2(p.cp2[1] - p.y, p.cp2[0] - p.x) : undefined;
                        const in_ = (Math.abs(p.x - p.cp1[0]) > 1e-6 || Math.abs(p.y - p.cp1[1]) > 1e-6) ? Math.atan2(p.y - p.cp1[1], p.x - p.cp1[0]) : undefined;
                        anchors.push({ x: p.x, y: p.y, out, in_ });
                    }
                }
            }
            const n = anchors.length;
            if (n < 1) return [];
            const dirTo = (i: number, j: number) => Math.atan2(anchors[j].y - anchors[i].y, anchors[j].x - anchors[i].x);
            const out: { x: number; y: number; angle: number; kind: 'start' | 'mid' | 'end' }[] = [];
            for (let i = 0; i < n; i++) {
                const a = anchors[i];
                const prev = i > 0 ? i - 1 : (closed ? n - 1 : -1);
                const next = i < n - 1 ? i + 1 : (closed ? 0 : -1);
                const inAng = a.in_ ?? (prev >= 0 ? dirTo(prev, i) : (next >= 0 ? dirTo(i, next) : 0));
                const outAng = a.out ?? (next >= 0 ? dirTo(i, next) : (prev >= 0 ? dirTo(prev, i) : 0));
                if (i === 0 && !closed) out.push({ x: a.x, y: a.y, angle: outAng, kind: 'start' });
                else if (i === n - 1 && !closed) out.push({ x: a.x, y: a.y, angle: inAng, kind: 'end' });
                else out.push({ x: a.x, y: a.y, angle: bisector(inAng, outAng), kind: 'mid' });
            }
            return out;
        };

        const applyMarkers = (el: Element, tag: string, composedMat: number[], inherited: InheritedStyles, useRefStack: Set<string>) => {
            const inlineStyles = parseInlineStyle(el);
            const refs = {
                start: markerRef(el, 'marker-start', inlineStyles, inherited),
                mid: markerRef(el, 'marker-mid', inlineStyles, inherited),
                end: markerRef(el, 'marker-end', inlineStyles, inherited),
            };
            if (!refs.start && !refs.mid && !refs.end) return;
            const strokeWidth = parseSvgLength(resolveAttr(el, 'stroke-width', inlineStyles, inherited, '1'), 1);
            const rot = (rad: number): number[] => { const c = Math.cos(rad), s = Math.sin(rad); return [c, s, 0, -s, c, 0, 0, 0, 1]; };

            for (const v of markerVertices(el, tag)) {
                const refId = v.kind === 'start' ? refs.start : v.kind === 'end' ? refs.end : refs.mid;
                if (!refId || useRefStack.has(refId)) continue;
                const markerEl = doc.getElementById(refId);
                if (!markerEl || markerEl.tagName.toLowerCase() !== 'marker') continue;

                const mW = parseSvgLength(markerEl.getAttribute('markerWidth'), 3);
                const mH = parseSvgLength(markerEl.getAttribute('markerHeight'), 3);
                const refX = parseSvgLength(markerEl.getAttribute('refX'), 0);
                const refY = parseSvgLength(markerEl.getAttribute('refY'), 0);
                const scale = (markerEl.getAttribute('markerUnits') || 'strokeWidth') === 'userSpaceOnUse' ? 1 : strokeWidth;

                const orient = markerEl.getAttribute('orient') || '0';
                let angle: number;
                if (orient === 'auto') angle = v.angle;
                else if (orient === 'auto-start-reverse') angle = v.angle + (v.kind === 'start' ? Math.PI : 0);
                else { const num = parseFloat(orient); angle = isNaN(num) ? 0 : num * Math.PI / 180; }

                // Content matrix: viewBox fit + refX/refY reference point.
                let cm: number[];
                const vb = markerEl.getAttribute('viewBox');
                const p = vb ? vb.trim().split(/[\s,]+/).map(Number) : null;
                if (p && p.length >= 4 && p[2] > 0 && p[3] > 0) {
                    const sx = mW / p[2], sy = mH / p[3];
                    cm = composeMatrices(translateMatrix(-(refX - p[0]) * sx, -(refY - p[1]) * sy),
                        composeMatrices(scaleMatrix(sx, sy), translateMatrix(-p[0], -p[1])));
                } else {
                    cm = translateMatrix(-refX, -refY);
                }

                // T(vertex)·R(angle)·S(scale)·cm in local space, then the element CTM.
                const placement = composeMatrices(translateMatrix(v.x, v.y),
                    composeMatrices(rot(angle), composeMatrices(scaleMatrix(scale, scale), cm)));
                const full = composeMatrices(composedMat, placement);
                const stack = new Set(useRefStack); stack.add(refId);
                // Marker content does NOT inherit the referencing element's paint
                // (else an arrowhead would pick up the line's stroke); it uses its
                // own styles on a clean context.
                processChildren(markerEl, full, {}, stack); // baked ids land in createdIds
            }
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
            // The viewport width/height can carry absolute units (Inkscape
            // exports e.g. width="210mm"); convert to user px for the viewBox fit.
            const vpW = parseSvgLength(el.getAttribute('width'), 0);
            const vpH = parseSvgLength(el.getAttribute('height'), 0);
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
        // Build a GradientGeo for a baked shape (path/line/poly): its geometry
        // lives in the composed space (node transform is identity), so the OBB
        // box is the baked bbox and userSpaceOnUse coords map via composedMat.
        const bakedGradientGeo = (subpaths: { points: { x: number; y: number }[] }[], mat: number[]): GradientGeo => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const sp of subpaths) for (const p of sp.points) {
                if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
            }
            if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
            return { bx: minX, by: minY, bw: maxX - minX, bh: maxY - minY, userToLocal: mat };
        };

        const processElement = (el: Element, parentMat: number[], inherited: InheritedStyles, useRefStack: Set<string> = new Set(), suppressMask = false) => {
            // localName strips any namespace prefix, so `<svg:rect>` (explicit
            // svg namespace) dispatches the same as `<rect>`.
            const tag = (el.localName || el.tagName).toLowerCase();

            // Skip metadata, defs, style, desc, title, clipPath
            // Note: <symbol> is NOT skipped — it is processed when referenced by <use>
            if (['defs', 'style', 'metadata', 'desc', 'title', 'clippath', 'mask', 'pattern', 'lineargradient', 'radialgradient', 'filter', 'marker'].includes(tag)) return;

            // <symbol> is only renderable when referenced by <use>, not as a top-level element
            if (tag === 'symbol') return;

            // display:none removes the element AND its subtree (unlike
            // visibility, display is not inherited, so groups must be handled
            // here — the child-visibility path only covers leaf shapes). Our own
            // exporter also wraps every hidden node in `<g display="none">`, so
            // honoring this is what makes hidden state survive a round-trip.
            const _ownInline = parseInlineStyle(el);
            if ((el.getAttribute('display') || _ownInline['display']) === 'none') return;

            // A filter that is empty or references an invalid target makes the
            // element (and its subtree) not render at all (SVG semantics).
            if (this.parseFilterEffects(el, doc) === 'hide') return;

            // Parse this element's transform and compose with parent
            const transformAttr = el.getAttribute('transform');
            const localMat = transformAttr ? parseSVGTransform(transformAttr) : identityMatrix();
            const composedMat = composeMatrices(parentMat, localMat);

            // Rasterize-fallback: an element whose filter couldn't be mapped to
            // native effects was pre-rendered to an image (see
            // rasterizeFilteredElements) — place that image instead of the shape.
            const raster = (el as unknown as { __rasterFilter?: { imageId: number; x: number; y: number; w: number; h: number } }).__rasterFilter;
            if (raster) {
                try {
                    const imgNode = this.scene.engine!.add_image(0, 0, raster.w, raster.h, raster.imageId);
                    this.scene.setNodeTransform(imgNode, composeMatrices(composedMat, translateMatrix(raster.x, raster.y)));
                    const nm = el.getAttribute('id') || el.getAttribute('class');
                    if (nm) { try { this.scene.engine!.set_node_name(imgNode, nm); } catch { /* noop */ } }
                    createdIds.push(imgNode);
                } catch (err) { console.warn('Filter rasterize placement failed:', err); }
                return;
            }

            // Resolve a clip-path / mask attribute into an is_mask group. We
            // render the element's own content (suppressing this branch on the
            // re-entry), import the referenced <clipPath>/<mask> children as
            // mask shapes in the SAME user space, mark them is_mask, and group
            // [mask..., content...] with the mask at the bottom. clipPath
            // shapes are opaque, so alpha-masking reproduces clipping.
            if (!suppressMask) {
                const ref = el.getAttribute('mask') || el.getAttribute('clip-path');
                const refMatch = ref && ref.match(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/);
                const defEl = refMatch ? doc.getElementById(refMatch[1]) : null;
                const defTag = defEl?.tagName.toLowerCase();
                if (defEl && (defTag === 'clippath' || defTag === 'mask')) {
                    const contentStart = createdIds.length;
                    processElement(el, parentMat, inherited, useRefStack, true);
                    const contentIds = createdIds.slice(contentStart);

                    // Mask shapes live in the element's user space (composedMat).
                    const maskStart = createdIds.length;
                    for (const dc of Array.from(defEl.children)) {
                        // Skip children that don't contribute to the clip/mask:
                        // display:none / visibility:hidden never paint, and a
                        // <clipPath> only accepts basic shapes / text / use
                        // (image, switch, symbol, … are invalid clip children).
                        const dcInline = parseInlineStyle(dc);
                        if ((dc.getAttribute('display') || dcInline['display']) === 'none') continue;
                        if ((dc.getAttribute('visibility') || dcInline['visibility']) === 'hidden') continue;
                        if (defTag === 'clippath' &&
                            !CLIP_CHILD_TAGS.has((dc.localName || dc.tagName).toLowerCase())) continue;
                        processElement(dc, composedMat, inherited, useRefStack, true);
                    }
                    const maskIds = createdIds.slice(maskStart);

                    // An empty/invalid clipPath or mask clips the element away
                    // entirely (SVG semantics) — remove the content we created.
                    if (contentIds.length > 0 && maskIds.length === 0) {
                        for (const id of contentIds) { try { this.scene.removeNode(id); } catch { /* noop */ } }
                        const dropped = new Set(contentIds);
                        let w = 0;
                        for (let r = 0; r < createdIds.length; r++) {
                            if (!dropped.has(createdIds[r])) createdIds[w++] = createdIds[r];
                        }
                        createdIds.length = w;
                        return;
                    }

                    if (contentIds.length > 0 && maskIds.length > 0) {
                        // Union multiple mask shapes under one group so they mask
                        // together (a single mask span, not one-per-shape).
                        let maskNode = maskIds[0];
                        if (maskIds.length > 1) {
                            maskNode = this.scene.groupNodes(maskIds);
                            try { this.scene.engine!.set_node_name(maskNode, 'Mask'); } catch { /* noop */ }
                        }
                        try { this.scene.engine!.set_node_is_mask(maskNode, true); } catch { /* noop */ }
                        // SVG <mask> defaults to luminance masking unless
                        // mask-type="alpha" is explicitly set. <clipPath> is
                        // always alpha (coverage).
                        if (defTag === 'mask') {
                            const maskTypeAttr = (defEl.getAttribute('mask-type') ||
                                defEl.style?.getPropertyValue?.('mask-type') || '').trim().toLowerCase();
                            const mt = maskTypeAttr === 'alpha' ? 0 : 1; // luminance by default
                            try { this.scene.engine!.set_node_mask_type(maskNode, mt); } catch { /* noop */ }
                        }

                        const groupId = this.scene.groupNodes([maskNode, ...contentIds]);
                        try {
                            this.scene.engine!.set_node_name(groupId, el.getAttribute('id') || (defTag === 'mask' ? 'Masked' : 'Clipped'));
                        } catch { /* noop */ }

                        // Reconcile createdIds: drop the individual content+mask
                        // shapes, push the wrapping group.
                        const consumed = new Set([...contentIds, ...maskIds]);
                        let write = 0;
                        for (let read = 0; read < createdIds.length; read++) {
                            if (!consumed.has(createdIds[read])) createdIds[write++] = createdIds[read];
                        }
                        createdIds.length = write;
                        createdIds.push(groupId);
                    }
                    return;
                }
            }

            // Merge this element's styles on top of inherited ones
            const mergedStyles = collectInheritedStyles(el, inherited);

            // Handle <g> groups — recurse into children
            if (tag === 'g') {
                const childIds = processChildren(el, composedMat, mergedStyles, useRefStack);
                const groupName = el.getAttribute('id') || el.getAttribute('class') || 'Group';
                groupChildIds(childIds, groupName);
                return;
            }

            // Handle nested <svg> — a new viewport with its own viewBox transform
            // that CLIPS its content to the viewport rect (unless overflow:visible).
            if (tag === 'svg') {
                // Percentage x/y/width/height resolve against the viewport size
                // (approximated by the document size for single-level nesting).
                const docW = this.scene.engine?.get_document_width() ?? 1000;
                const docH = this.scene.engine?.get_document_height() ?? 1000;
                const x = parseSvgLength(el.getAttribute('x'), 0, { percentBasis: docW });
                const y = parseSvgLength(el.getAttribute('y'), 0, { percentBasis: docH });
                // width/height default to 100% of the viewport when omitted.
                const wAttr = el.getAttribute('width');
                const hAttr = el.getAttribute('height');
                const vw = wAttr != null ? parseSvgLength(wAttr, docW, { percentBasis: docW }) : docW;
                const vh = hAttr != null ? parseSvgLength(hAttr, docH, { percentBasis: docH }) : docH;
                const offsetMat = (x !== 0 || y !== 0)
                    ? composeMatrices(composedMat, translateMatrix(x, y))
                    : composedMat;
                const nestedVbMat = computeViewBoxMatrix(el);
                const nestedMat = composeMatrices(offsetMat, nestedVbMat);
                const childIds = processChildren(el, nestedMat, mergedStyles, useRefStack);
                const groupName = el.getAttribute('id') || 'Nested SVG';

                const overflow = (el.getAttribute('overflow')
                    || (el.getAttribute('style') || '').match(/(?:^|;)\s*overflow\s*:\s*([^;]+)/i)?.[1]
                    || '').trim();
                const clip = overflow !== 'visible' && overflow !== 'auto' && vw > 0 && vh > 0;
                if (clip && childIds.length > 0) {
                    // Clip via the mask system: a solid viewport rect (in PARENT
                    // space) as an alpha mask below the content.
                    const clipRect = this.scene.addRect(0, 0, vw, vh);
                    this.scene.setNodeTransform(clipRect, composeMatrices(composedMat, translateMatrix(x, y)));
                    // Clean opaque fill, no stroke (a stroke would leak past the
                    // viewport edge and fuzz the clip).
                    try {
                        this.scene.setNodeStyleNoHistory(clipRect, JSON.stringify({
                            fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], opacity: 1,
                            blend_mode: 0, fill_rule: 0, corner_radius: 0, effects: [],
                        }));
                    } catch { /* keep default style */ }
                    try { this.scene.engine!.set_node_is_mask(clipRect, true); } catch { /* noop */ }
                    // Content ids move inside the clip group.
                    const removeSet = new Set(childIds);
                    let write = 0;
                    for (let read = 0; read < createdIds.length; read++) {
                        if (!removeSet.has(createdIds[read])) createdIds[write++] = createdIds[read];
                    }
                    createdIds.length = write;
                    const groupId = this.scene.groupNodes([clipRect, ...childIds]);
                    try { this.scene.engine!.set_node_name(groupId, groupName); } catch { /* noop */ }
                    createdIds.push(groupId);
                } else {
                    groupChildIds(childIds, groupName);
                }
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
            // Geometry descriptor for mapping url(#gradient) fills into this
            // node's LOCAL space. rect/ellipse keep geometry at the origin with
            // x/y baked into the transform, so userSpaceOnUse coords convert via
            // translate(-offset); baked shapes (path/line/poly) live in the
            // composed space, so userToLocal = composedMat and the bbox is the
            // baked bbox. See resolveGradient / GradientGeo.
            let gradientGeo: GradientGeo | undefined;

            if (tag === 'rect') {
                const x = parseSvgLength(el.getAttribute('x'), 0);
                const y = parseSvgLength(el.getAttribute('y'), 0);
                const w = parseSvgLength(el.getAttribute('width'), 100);
                const h = parseSvgLength(el.getAttribute('height'), 100);
                // Create at origin, then set full transform (origin offset baked into matrix)
                nodeId = this.scene.addRect(0, 0, w, h);
                const offsetMat = composeMatrices(composedMat, translateMatrix(x, y));
                this.scene.setNodeTransform(nodeId, offsetMat);
                gradientGeo = { bx: 0, by: 0, bw: w, bh: h, userToLocal: translateMatrix(-x, -y) };
            } else if (tag === 'ellipse') {
                const cx = parseSvgLength(el.getAttribute('cx'), 0);
                const cy = parseSvgLength(el.getAttribute('cy'), 0);
                const rx = parseSvgLength(el.getAttribute('rx'), 50);
                const ry = parseSvgLength(el.getAttribute('ry'), 50);
                // Create at origin, then set full transform (center offset baked into matrix)
                nodeId = this.scene.addEllipse(0, 0, rx, ry);
                const offsetMat = composeMatrices(composedMat, translateMatrix(cx, cy));
                this.scene.setNodeTransform(nodeId, offsetMat);
                gradientGeo = { bx: -rx, by: -ry, bw: 2 * rx, bh: 2 * ry, userToLocal: translateMatrix(-cx, -cy) };
            } else if (tag === 'circle') {
                const cx = parseSvgLength(el.getAttribute('cx'), 0);
                const cy = parseSvgLength(el.getAttribute('cy'), 0);
                const r = parseSvgLength(el.getAttribute('r'), 50);
                nodeId = this.scene.addEllipse(0, 0, r, r);
                const offsetMat = composeMatrices(composedMat, translateMatrix(cx, cy));
                this.scene.setNodeTransform(nodeId, offsetMat);
                gradientGeo = { bx: -r, by: -r, bw: 2 * r, bh: 2 * r, userToLocal: translateMatrix(-cx, -cy) };
            } else if (tag === 'text') {
                // Resolve font-size through the CSS cascade. em/% are relative to
                // the inherited (parent) font-size; absolute units (pt, mm, …)
                // convert to user px.
                const inlineStyles = parseInlineStyle(el);
                // em/% on font-size are relative to the INHERITED (parent)
                // font-size — the `inherited` context, NOT mergedStyles (which
                // already folds in this element's own font-size).
                const parentFs = parseSvgLength(inherited['font-size'], 16);
                const fontSize = parseSvgLength(resolveAttr(el, 'font-size', inlineStyles, mergedStyles, '24'), 24, { fontSize: parentFs, percentBasis: parentFs });
                const textX = parseSvgLength(el.getAttribute('x'), 0, { fontSize });
                const textY = parseSvgLength(el.getAttribute('y'), 0, { fontSize });

                // Check for <tspan> children
                const tspans = el.querySelectorAll('tspan');
                if (tspans.length > 0) {
                    const tspanIds: number[] = [];
                    for (const tspan of tspans) {
                        const tspanInline = parseInlineStyle(tspan);
                        const tspanStyles = collectInheritedStyles(tspan, mergedStyles);
                        const tx = parseSvgLength(tspan.getAttribute('x'), textX, { fontSize });
                        const ty = parseSvgLength(tspan.getAttribute('y'), textY, { fontSize });
                        const tfs = parseSvgLength(resolveAttr(tspan, 'font-size', tspanInline, tspanStyles, String(fontSize)), fontSize, { fontSize, percentBasis: fontSize });
                        const content = tspan.textContent?.trim() || '';
                        if (!content) continue;
                        const tid = this.scene.addText(0, 0, content, tfs);
                        const tMat = composeMatrices(composedMat, translateMatrix(tx, ty));
                        this.scene.setNodeTransform(tid, tMat);
                        applyStyle(tid, tspan, tspanStyles);
                        this.applyTextStyleFromEl(tid, tspan, tspanInline, tspanStyles);
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
                this.applyTextStyleFromEl(nodeId, el, inlineStyles, mergedStyles);
            } else if (tag === 'line') {
                const x1 = parseSvgLength(el.getAttribute('x1'), 0);
                const y1 = parseSvgLength(el.getAttribute('y1'), 0);
                const x2 = parseSvgLength(el.getAttribute('x2'), 100);
                const y2 = parseSvgLength(el.getAttribute('y2'), 100);
                // Bake transform into point coordinates
                const [tx1, ty1] = transformPoint(composedMat, x1, y1);
                const [tx2, ty2] = transformPoint(composedMat, x2, y2);
                const points = [
                    { x: tx1, y: ty1, cp1: [tx1, ty1], cp2: [tx1, ty1] },
                    { x: tx2, y: ty2, cp1: [tx2, ty2], cp2: [tx2, ty2] },
                ];
                const subpaths = [{ points, closed: false }];
                nodeId = this.scene.addPath(JSON.stringify(subpaths));
                gradientGeo = bakedGradientGeo(subpaths, composedMat);
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
                    gradientGeo = bakedGradientGeo(subpaths, composedMat);
                }
            } else if (tag === 'path') {
                const d = el.getAttribute('d') || '';
                // Parse path at origin, then bake the composed transform into coordinates
                const subpaths = this.parseSVGPathDWithMatrix(d, composedMat);
                if (subpaths.length > 0) {
                    nodeId = this.scene.addPath(JSON.stringify(subpaths));
                    gradientGeo = bakedGradientGeo(subpaths, composedMat);
                }
            } else if (tag === 'image') {
                // preprocessImages (async pre-pass) decoded the image: intrinsic
                // size, preserveAspectRatio fit, and SVG-in-image rasterization.
                const fit = (el as unknown as { __imageFit?: { imageId: number; x: number; y: number; w: number; h: number } }).__imageFit;
                if (fit) {
                    nodeId = this.scene.engine!.add_image(0, 0, fit.w, fit.h, fit.imageId);
                    const offsetMat = composeMatrices(composedMat, translateMatrix(fit.x, fit.y));
                    this.scene.setNodeTransform(nodeId, offsetMat);
                } else {
                    // Fallback: preprocessImages didn't tag this one (decode/encode
                    // failed, or an image type it skipped) — register the raw
                    // data-URI bytes stretched to the box, as before.
                    const href = el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
                    const ix = parseSvgLength(el.getAttribute('x'), 0);
                    const iy = parseSvgLength(el.getAttribute('y'), 0);
                    const iw = parseSvgLength(el.getAttribute('width'), 0) || 100;
                    const ih = parseSvgLength(el.getAttribute('height'), 0) || 100;
                    const m = href.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
                    if (m && m[2]) {
                        const mime = m[1] || 'image/png';
                        try {
                            const binStr = atob(m[3]);
                            const bytes = new Uint8Array(binStr.length);
                            for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
                            const imageId = this.scene.engine!.register_image(bytes, mime);
                            nodeId = this.scene.engine!.add_image(0, 0, iw, ih, imageId);
                            this.scene.setNodeTransform(nodeId, composeMatrices(composedMat, translateMatrix(ix, iy)));
                        } catch (err) { console.warn('Failed to import <image>:', err); }
                    } else if (href) {
                        console.warn('Skipping external <image> href (unsupported):', href.slice(0, 64));
                    }
                }
            }

            if (nodeId !== null) {
                applyStyle(nodeId, el, mergedStyles, gradientGeo);
                // Set name from id attribute if present
                const elName = el.getAttribute('id') || el.getAttribute('class');
                if (elName) {
                    try { this.scene.engine!.set_node_name(nodeId, elName); } catch { /* noop */ }
                }
                // Effects: resolve filter="url(#id)" into blur/shadow/color-matrix.
                // ('rasterize' filters are handled up-front — see below — so here
                // we only apply natively-mappable effect arrays.)
                const fx = this.parseFilterEffects(el, doc);
                if (Array.isArray(fx) && fx.length) {
                    try { this.scene.engine!.set_node_effects(nodeId, JSON.stringify(fx)); } catch { /* noop */ }
                }
                createdIds.push(nodeId);

                // Markers (arrowheads etc.): bake marker shapes at the vertices.
                if (tag === 'line' || tag === 'polyline' || tag === 'polygon' || tag === 'path') {
                    applyMarkers(el, tag, composedMat, mergedStyles, useRefStack);
                }
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

    /** Apply font-weight / font-style / letter-spacing from an SVG text element
     *  (or tspan) to a created text node. Resolves attribute → inline style →
     *  inherited cascade. */
    private applyTextStyleFromEl(nodeId: number, el: Element, inline: Record<string, string>, inherited: unknown) {
        const inh = inherited as Record<string, string> | undefined;
        const get = (name: string): string | null =>
            el.getAttribute(name) ?? inline[name] ?? inh?.[name] ?? null;

        let weight = 400;
        const fw = get('font-weight');
        if (fw) {
            if (fw === 'bold') weight = 700;
            else if (fw === 'normal') weight = 400;
            else { const n = parseInt(fw, 10); if (!isNaN(n)) weight = n; }
        }
        const fs = get('font-style');
        const italic = fs === 'italic' || fs === 'oblique';
        let ls = 0;
        const lsRaw = get('letter-spacing');
        if (lsRaw && lsRaw !== 'normal') { const n = parseFloat(lsRaw); if (!isNaN(n)) ls = n; }

        if (weight !== 400 || italic || ls !== 0) {
            try { this.scene.engine!.set_text_style(nodeId, weight, italic, ls); } catch { /* noop */ }
        }
    }

    /**
     * Resolve an element's `filter="url(#id)"` into an effects array
     * (feGaussianBlur → Blur, feDropShadow → DropShadow). If the filter
     * contains any other primitive, the whole filter is skipped (a partial
     * approximation would look worse than none).
     */
    /** The 20-float (4×5, row-major) color matrix for an feColorMatrix primitive. */
    private feColorMatrix(prim: Element): number[] {
        const type = (prim.getAttribute('type') || 'matrix').toLowerCase();
        const vals = (prim.getAttribute('values') || '').trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
        if (type === 'matrix') {
            return vals.length === 20 ? vals : [1,0,0,0,0, 0,1,0,0,0, 0,0,1,0,0, 0,0,0,1,0];
        }
        if (type === 'saturate') {
            const s = vals.length ? vals[0] : 1;
            return [
                0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0,
                0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0,
                0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0,
                0, 0, 0, 1, 0,
            ];
        }
        if (type === 'huerotate') {
            const a = (vals.length ? vals[0] : 0) * Math.PI / 180;
            const c = Math.cos(a), s = Math.sin(a);
            return [
                0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0, 0,
                0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283, 0, 0,
                0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0, 0,
                0, 0, 0, 1, 0,
            ];
        }
        if (type === 'luminancetoalpha') {
            return [0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, 0.2125, 0.7154, 0.0721, 0, 0];
        }
        return [1,0,0,0,0, 0,1,0,0,0, 0,0,1,0,0, 0,0,0,1,0];
    }

    /**
     * Resolve an element's filter into engine effects.
     * Returns the effects array when every primitive maps natively
     * (feGaussianBlur, feDropShadow, feColorMatrix), 'rasterize' when the filter
     * has an unsupported primitive (caller bakes the element to an image), or
     * null when there is no filter.
     */
    private parseFilterEffects(el: Element, doc: Document): any[] | 'rasterize' | 'hide' | null {
        // `filter` may be a url(#id) reference or a CSS filter-function list,
        // on the presentation attribute or in the inline style.
        const styleFilter = (el.getAttribute('style') || '').match(/(?:^|;)\s*filter\s*:\s*([^;]+)/i);
        const ref = ((styleFilter ? styleFilter[1] : el.getAttribute('filter')) || '').trim();
        if (!ref || ref === 'none') return null;
        const m = ref.match(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/);
        if (!m) {
            // No url() → a CSS filter-function list (blur(), grayscale(), …).
            return this.parseFilterFunctions(ref, el);
        }
        // A url() combined with anything else (extra urls / functions) can't be
        // composed natively — let the caller rasterize it.
        if (ref.replace(m[0], '').trim() !== '') return 'rasterize';
        const filterEl = doc.getElementById(m[1]);
        // An invalid filter reference (missing target or not a <filter>) makes
        // the referencing element not render at all (SVG 1.1).
        if (!filterEl || filterEl.tagName.toLowerCase() !== 'filter') return 'hide';

        const primitives = Array.from(filterEl.children).filter(c => c.tagName.toLowerCase().startsWith('fe'));
        const hasHref = filterEl.hasAttribute('href') || filterEl.hasAttribute('xlink:href');
        // A filter with no primitives (and no template it inherits them from)
        // produces empty output → the element is not rendered.
        if (primitives.length === 0) return hasHref ? 'rasterize' : 'hide';
        // The native effect path can only represent a plain effect stack over
        // the default region/inputs. Anything with a custom filter region,
        // primitive subregion, non-default units, explicit inputs, or href
        // inheritance is rasterized through the browser, which implements all of
        // that (incl. region clipping) correctly.
        const regionAttrs = ['x', 'y', 'width', 'height', 'filterUnits', 'primitiveUnits'];
        const hasRegion = regionAttrs.some(a => filterEl.hasAttribute(a));
        const hasSubregion = primitives.some(p => ['x', 'y', 'width', 'height'].some(a => p.hasAttribute(a)));
        const hasInputs = primitives.some(p => p.hasAttribute('in') || p.hasAttribute('in2'));
        if (hasHref || hasRegion || hasSubregion || hasInputs) return 'rasterize';

        const effects: any[] = [];
        const firstNum = (s: string | null, def = 0): number => {
            if (!s) return def;
            const v = parseFloat(s.trim().split(/[\s,]+/)[0]);
            return isNaN(v) ? def : v;
        };
        // color-interpolation-filters: default is linearRGB per SVG spec.
        // Check the <filter> element for a blanket override, then each
        // primitive can override individually.
        const filterCIF = (filterEl.getAttribute('color-interpolation-filters') || '').trim().toLowerCase();
        const filterLinearRGB = filterCIF !== 'srgb'; // linearRGB or auto → true
        for (const prim of primitives) {
            const t = prim.tagName.toLowerCase();
            if (t === 'fegaussianblur') {
                effects.push({ Blur: { radius: firstNum(prim.getAttribute('stdDeviation')) } });
            } else if (t === 'fedropshadow') {
                const flood = prim.getAttribute('flood-color') || '#000000';
                const fo = firstNum(prim.getAttribute('flood-opacity'), 1);
                const c = flood.startsWith('#') ? hexToRgb(flood) : { r: 0, g: 0, b: 0 };
                effects.push({ DropShadow: {
                    dx: firstNum(prim.getAttribute('dx')),
                    dy: firstNum(prim.getAttribute('dy')),
                    blur: firstNum(prim.getAttribute('stdDeviation')),
                    color: { r: c.r, g: c.g, b: c.b, a: fo },
                } });
            } else if (t === 'fecolormatrix') {
                // Per-primitive override of color-interpolation-filters.
                const primCIF = (prim.getAttribute('color-interpolation-filters') || '').trim().toLowerCase();
                const linearRGB = primCIF ? primCIF !== 'srgb' : filterLinearRGB;
                effects.push({ ColorMatrix: { matrix: this.feColorMatrix(prim), linear_rgb: linearRGB } });
            } else {
                // Unsupported primitive — fall back to rasterizing the element.
                return 'rasterize';
            }
        }
        return effects.length ? effects : null;
    }

    /**
     * Parse a CSS `filter:` function list — `blur()`, `grayscale()`, `sepia()`,
     * `saturate()`, `hue-rotate()`, `invert()`, `brightness()`, `contrast()`,
     * `opacity()`, `drop-shadow()` — into our native effect list. Returns
     * 'rasterize' if any function is unknown, or null if empty. The color-adjust
     * functions map to a ColorMatrix; per the CSS Filter Effects spec they use
     * the default color-interpolation-filters (linearRGB).
     */
    private parseFilterFunctions(str: string, el: Element): any[] | 'rasterize' | null {
        const effects: any[] = [];
        const re = /([a-z-]+)\s*\(([^)]*)\)/gi;
        let match: RegExpExecArray | null;
        let sawAny = false;
        // CSS rule: if ANY function in the list is invalid, the whole `filter`
        // is treated as `none` (no filter). We signal that by returning null.
        // A number/percentage amount; empty → default. Returns NaN when invalid.
        const amount = (a: string, def: number): number => {
            a = a.trim();
            if (a === '') return def;
            if (!/^[-+]?[\d.]+%?$/.test(a)) return NaN;
            const v = parseFloat(a);
            return a.endsWith('%') ? v / 100 : v;
        };
        while ((match = re.exec(str)) !== null) {
            sawAny = true;
            const name = match[1].toLowerCase();
            const args = match[2].trim();
            if (name === 'blur') {
                // <length> only (no %, non-negative); empty = 0.
                if (args !== '' && !/^[+]?[\d.]+(px|pt|pc|mm|cm|in|q|em|ex|rem)?$/i.test(args)) return null;
            } else if (name === 'drop-shadow') {
                if (!this.parseDropShadowFunction(args, el)) return null;
            } else if (name === 'hue-rotate') {
                // <angle> or unitless 0 or empty. Unitless nonzero is invalid.
                if (args !== '' && !/^[-+]?[\d.]+(deg|grad|rad|turn)$/i.test(args) && !/^[-+]?0*\.?0*$/.test(args)) return null;
            } else if (name === 'grayscale' || name === 'sepia' || name === 'saturate'
                || name === 'invert' || name === 'brightness' || name === 'contrast'
                || name === 'opacity') {
                if (isNaN(amount(args, 1))) return null;
            } else {
                return null; // unknown/invalid function → whole filter is none
            }
            effects.push(name);
        }
        if (!sawAny) return null; // no parseable function → treat as no filter
        // Every function validated. The browser implements CSS filter functions
        // accurately (matrices + color space), so rasterize the element through
        // it rather than reimplementing each function's exact semantics natively.
        return effects.length ? 'rasterize' : null;
    }

    /** Validate a CSS `drop-shadow(<color>? <length>{2,3} <color>?)` function.
     *  Returns true when well-formed (so the caller can rasterize it), false
     *  when invalid (which makes the whole `filter` property `none`). */
    private parseDropShadowFunction(args: string, _el: Element): boolean {
        const tokens = args.match(/(?:rgba?|hsla?)\([^)]*\)|[^\s]+/gi) || [];
        let numCount = 0, colorCount = 0;
        for (const tok of tokens) {
            if (/^[-+.\d]/.test(tok)) {
                // Numeric token → must be a valid length (no %). Percentages and
                // garbage make the whole drop-shadow invalid.
                if (tok.endsWith('%') || isNaN(parseSvgLength(tok, NaN))) return false;
                numCount++;
            } else {
                colorCount++;
            }
        }
        // CSS requires 2 or 3 lengths and at most one color.
        return numCount >= 2 && numCount <= 3 && colorCount <= 1;
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

        // "Use as Mask" toggles depending on the current selection state.
        const sel = Array.from(this.scene.engine?.get_selection() ?? []);
        const anyMask = sel.some(id => { try { return this.scene.getNodeIsMask(id); } catch { return false; } });
        const maskLabel = anyMask ? 'Release Mask' : 'Use as Mask';

        // Live Paint toggles: a selected Live Paint group offers Release; any
        // other selection offers Make.
        const singleLivePaint = sel.length === 1
            && (() => { try { return this.scene.getNodeLivePaint(sel[0]); } catch { return false; } })();
        const livePaintItems: Array<{ label: string; action: string; shortcut: string }> = singleLivePaint
            ? [{ label: 'Expand Live Paint', action: 'expand-live-paint', shortcut: '' }]
            : [{ label: 'Make Live Paint', action: 'make-live-paint', shortcut: '⌘⌥X' }];

        const items: Array<{ label: string; action: string; shortcut: string } | 'separator'> = [
            { label: 'Bring to Front', action: 'bring-to-front', shortcut: '⌘]' },
            { label: 'Bring Forward', action: 'bring-forward', shortcut: ']' },
            { label: 'Send Backward', action: 'send-backward', shortcut: '[' },
            { label: 'Send to Back', action: 'send-to-back', shortcut: '⌘[' },
            'separator',
            { label: 'Group', action: 'group', shortcut: '⌘G' },
            { label: 'Ungroup', action: 'ungroup', shortcut: '⌘⇧G' },
            ...livePaintItems,
            { label: 'Flatten', action: 'flatten', shortcut: '⌘E' },
            { label: maskLabel, action: 'toggle-mask', shortcut: '' },
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

        // Dismiss on click-outside. Runs in the capture phase and swallows the
        // event so the dismissing click ONLY closes the menu — it must not also
        // reach the canvas (which would deselect) or any other handler.
        this._dismissContextMenu = (e: MouseEvent) => {
            if (this.contextMenuEl.contains(e.target as Node)) return;
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.hideContextMenu();
        };
        this._dismissContextMenuKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') this.hideContextMenu();
        };
        setTimeout(() => {
            window.addEventListener('mousedown', this._dismissContextMenu!, true);
            window.addEventListener('keydown', this._dismissContextMenuKey!);
        }, 0);
    }

    hideContextMenu() {
        this.contextMenuEl.style.display = 'none';
        this.contextMenuEl.innerHTML = '';
        this._contextMenuCallback = null;
        if (this._dismissContextMenu) {
            window.removeEventListener('mousedown', this._dismissContextMenu, true);
            this._dismissContextMenu = null;
        }
        if (this._dismissContextMenuKey) {
            window.removeEventListener('keydown', this._dismissContextMenuKey);
            this._dismissContextMenuKey = null;
        }
    }
}
