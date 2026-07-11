/**
 * Floating contextual action bar — Figma-style bottom bar that changes content
 * based on the current editor context (selection, tool, editing mode).
 *
 * The bar follows one strict grammar so every state reads the same way:
 *
 *   [what you're acting on] | [context-specific actions] | [flip/flatten] | [Duplicate · Delete]
 *
 * Rules:
 *  - The bar contains ACTIONS (verbs), never object properties. Fill, stroke,
 *    opacity, radius and typography live in the right-hand properties panel.
 *  - Tool states show a hint describing the gesture, plus tool options where
 *    they exist (the style a drawing tool / the paint bucket will apply).
 *  - Modal states (pen drawing, point editing) show progress + commit/cancel,
 *    with the committing action last.
 *  - Delete is always the last action and always styled as destructive.
 */

import type { AlignMode } from './align';
import { alignSelection, distributeSelection } from './align';
import type { BoolOp } from './boolean_ops';
import { BOOL_OP_BY_INDEX } from './boolean_ops';
import { colorToHex, createColorSwatch, parseHex } from './color_picker';
import type { ContextInfo } from './context';
import { getEditorContext } from './context';
import {
    iconAlignBottom,
    iconAlignCenterH,
    iconAlignCenterV,
    iconAlignLeft,
    iconAlignRight,
    iconAlignTop,
    iconBoolExclude,
    iconBoolIntersect,
    iconBoolSubtract,
    iconBoolUnion,
    iconCopy,
    iconCornerDownRight,
    iconCreateOutlines,
    iconDistributeH,
    iconDistributeV,
    iconFlatten,
    iconFlipH,
    iconFlipV,
    iconGroup,
    iconLink,
    iconMinusCircle,
    iconPencil,
    iconPlusCircle,
    iconScissors,
    iconTrash,
    iconUngroup,
} from './icons';
import type { InputManager } from './input';
import type { Renderer } from './renderer';
import type { UIEngine } from './ui';
import type { WasmScene } from './wasm_scene';
import type { WidthProfile } from './width_profile';

/** What each tool does, shown while the tool is armed and nothing is selected. */
const TOOL_HINTS: Record<string, string> = {
    direct: 'Click a shape to edit its anchor points',
    pen: 'Click to place the first point of a path',
    pencil: 'Drag to draw a freehand path',
    line: 'Drag to draw a line — Shift: constrain to 45°',
    rect: 'Drag to draw a rectangle — Shift: square, Alt: from center',
    ellipse: 'Drag to draw an ellipse — Shift: circle, Alt: from center',
    polygon: 'Drag to draw a polygon — Shift: constrain',
    star: 'Drag to draw a star — Shift: constrain',
    text: 'Click on the canvas to place text',
    scissors: 'Click a path segment or anchor point to cut the path there',
    'paint-bucket': 'Click a region to fill it, or a line to paint the edge',
    eyedropper: 'Click a shape to copy its appearance onto the selection',
};

/** Tools whose next action applies the default style — they get style swatches. */
const TOOLS_WITH_FILL = new Set([
    'pen',
    'pencil',
    'rect',
    'ellipse',
    'polygon',
    'star',
    'paint-bucket',
]);
const TOOLS_WITH_STROKE = new Set([
    'pen',
    'pencil',
    'line',
    'rect',
    'ellipse',
    'polygon',
    'star',
    'paint-bucket',
]);

/** Node types the boolean operations can combine. */
const BOOLEAN_COMPATIBLE = new Set(['Path', 'Rect', 'Ellipse', 'Group']);

/** Label + icon for each boolean op, in the order shown in the dropdown. */
const BOOL_OP_ORDER: readonly BoolOp[] = ['union', 'subtract', 'intersect', 'exclude'];
const BOOL_OP_META: Record<BoolOp, { label: string; icon: () => string }> = {
    union: { label: 'Union', icon: () => iconBoolUnion(14) },
    subtract: { label: 'Subtract', icon: () => iconBoolSubtract(14) },
    intersect: { label: 'Intersect', icon: () => iconBoolIntersect(14) },
    exclude: { label: 'Exclude', icon: () => iconBoolExclude(14) },
};

export class ContextBar {
    private el: HTMLDivElement;
    private canvasContainer: HTMLElement;
    private ui: UIEngine;
    private input: InputManager;
    private scene: WasmScene;

    /** Cache key for the last render — avoids redundant DOM rebuilds. */
    private _lastSignature: string = '';

    constructor(
        canvasContainer: HTMLElement,
        ui: UIEngine,
        input: InputManager,
        scene: WasmScene,
        _renderer: Renderer,
    ) {
        this.canvasContainer = canvasContainer;
        this.ui = ui;
        this.input = input;
        this.scene = scene;

        // Create the bar element
        this.el = document.createElement('div');
        this.el.id = 'context-bar';
        canvasContainer.appendChild(this.el);

        // Initial render
        this.refresh();
    }

    /** Recompute context and update the bar. Called from syncWithSelection / setActiveTool / etc. */
    refresh() {
        const info = getEditorContext(this.ui, this.input, this.scene);

        // Toggle editing-mode class on canvas container
        const isEditing = info.context === 'path-editing' || info.context === 'pen-drawing';
        this.canvasContainer.classList.toggle('editing-mode', isEditing);

        // Build a signature from the context state that drives the bar's DOM.
        // If nothing relevant changed, skip the expensive innerHTML rebuild.
        const sig = this.buildSignature(info);
        if (sig === this._lastSignature) return;
        this._lastSignature = sig;

        this.render(info);
    }

    /** Build a cache key that captures everything affecting the bar's rendered output. */
    private buildSignature(info: ContextInfo): string {
        const types = info.selectedNodes.map((n) => n.node_type).join(',');
        const names = info.selectedNodes.map((n) => n.name).join(',');
        // Tool contexts render the default-style swatches, so their colors are
        // part of the signature; selection contexts don't show any properties.
        const styleSig =
            info.context === 'tool'
                ? `|${this.ui.rgbToHex(this.ui.getActiveFillColor())}|${this.ui.rgbToHex(this.ui.getActiveStrokeColor())}`
                : info.context === 'live-paint'
                  ? `|${this.ui.rgbToHex(this.ui.getLivePaintFill())}|${this.ui.rgbToHex(this.ui.getLivePaintStroke())}`
                  : '';
        // Live Paint bar depends on whether a group is active.
        const lpSig = info.context === 'live-paint' ? `|lp${this.scene.getLivePaintGroup()}` : '';
        // A selected Boolean Group's controls show its current op, so it's part
        // of the signature (switching the op must re-render the bar).
        const boolSig =
            info.context === 'group-selected' && info.selectedIds.length === 1
                ? `|bop${this.scene.getBooleanOp(info.selectedIds[0])}`
                : '';
        // Single-shape path controls (Simplify point-count gate, Width open-path
        // gate) depend on the path's geometry, which in-place edits mutate — hash
        // it so the bar rebuilds after Simplify/Offset/Width.
        let geoSig = '';
        if (info.context === 'single-shape' && info.selectedIds.length === 1) {
            const subs = this.scene.getNodeGeometry(info.selectedIds[0])?.Path?.subpaths;
            if (subs) {
                const pts = subs.reduce((n, s) => n + s.points.length, 0);
                const anyOpen = subs.some((s) => !s.closed) ? 'o' : 'c';
                geoSig = `|geo${pts}${anyOpen}`;
            }
        }
        return `${info.context}|${this.ui.activeTool}|${info.selectedIds.join(',')}|${types}|${names}|${info.pointCount}|${info.selectedPointCount}|${this.input.addPointMode ? 1 : 0}${styleSig}${lpSig}${boolSig}${geoSig}`;
    }

    /** Rebuild the bar DOM based on context info. */
    private render(info: ContextInfo) {
        this.el.innerHTML = '';

        switch (info.context) {
            case 'empty':
                break; // no selection, no armed tool — the bar hides itself (:empty)
            case 'tool':
                this.renderTool();
                break;
            case 'single-shape':
                this.renderSingleShape(info);
                break;
            case 'text-selected':
                this.renderTextSelected(info);
                break;
            case 'group-selected':
                this.renderGroupSelected(info);
                break;
            case 'multi-select':
                this.renderMultiSelect(info);
                break;
            case 'live-paint':
                this.renderLivePaint(info);
                break;
            case 'live-paint-object':
                this.renderLivePaintObject(info);
                break;
            case 'pen-drawing':
                this.renderPenDrawing(info);
                break;
            case 'path-editing':
                this.renderPathEditing(info);
                break;
        }
    }

    // ─── Context Renderers ──────────────────────────────────────────

    /** Armed tool, nothing selected: what the tool will do + the style it applies. */
    private renderTool() {
        const tool = this.ui.activeTool;

        if (TOOLS_WITH_FILL.has(tool)) {
            this.el.appendChild(
                this.createColorSwatch(
                    'fill',
                    this.ui.rgbToHex(this.ui.getActiveFillColor()),
                    (color) => {
                        this.ui.updateActiveFillColor(color);
                    },
                ),
            );
        }
        if (TOOLS_WITH_STROKE.has(tool)) {
            this.el.appendChild(
                this.createColorSwatch(
                    'stroke',
                    this.ui.rgbToHex(this.ui.getActiveStrokeColor()),
                    (color) => {
                        this.ui.updateActiveStrokeColor(color);
                    },
                ),
            );
        }
        if (TOOLS_WITH_FILL.has(tool)) {
            this.el.appendChild(this.createSeparator());
        }

        // Live Paint gap closing: bridge small openings so not-quite-closed
        // regions become fillable (Illustrator's Gap Options).
        if (tool === 'paint-bucket') {
            this.el.appendChild(this.createGapControl());
            this.el.appendChild(this.createSeparator());
        }

        this.el.appendChild(this.createHint(TOOL_HINTS[tool] || `${tool} tool`));
    }

    /** A Live Paint group selected with the Selection tool: it's a special
     *  object, so it gets Edit/Release instead of Enter Group/Ungroup. */
    private renderLivePaintObject(info: ContextInfo) {
        const id = info.selectedIds[0];
        this.el.appendChild(this.createBadge(this.scene.getNodeName(id) || 'Live Paint'));
        this.el.appendChild(this.createSeparator());

        this.el.appendChild(
            this.createButton(
                'Edit',
                iconPencil(14),
                () => {
                    this.input.enterLivePaintGroup(id);
                },
                false,
                '⏎',
            ),
        );

        // Expand bakes the painted faces/edges into real, editable shapes.
        this.el.appendChild(
            this.createButton('Expand', iconCreateOutlines(14), () => {
                this.input.expandLivePaintGroup(id);
            }),
        );

        this.appendTransformActions(info, { flatten: false });
        this.appendLifecycleActions();
    }

    /** Gap-closing preset selector for the Live Paint tool. */
    private createGapControl(): HTMLElement {
        const presets: Array<[string, number]> = [
            ['No gaps', 0],
            ['Small gaps', 4],
            ['Medium gaps', 12],
            ['Large gaps', 32],
        ];
        const wrapper = document.createElement('div');
        wrapper.className = 'cb-swatch-wrapper';
        wrapper.setAttribute('data-tooltip', 'Close gaps up to this size before filling');

        const select = document.createElement('select');
        select.className = 'cb-select';
        const current = this.scene.getGapBridgeDistance();
        for (const [label, px] of presets) {
            const opt = document.createElement('option');
            opt.value = String(px);
            opt.textContent = label;
            // Nearest preset reflects the stored distance.
            if (px === current) opt.selected = true;
            select.appendChild(opt);
        }
        // If the stored value matches no preset, prepend a custom entry.
        if (!presets.some(([, px]) => px === current)) {
            const opt = document.createElement('option');
            opt.value = String(current);
            opt.textContent = `Custom (${current})`;
            opt.selected = true;
            select.insertBefore(opt, select.firstChild);
        }
        select.addEventListener('change', () => {
            this.scene.setGapBridgeDistance(parseFloat(select.value));
            this.input.renderer.requestRender();
        });

        const labelSpan = document.createElement('span');
        labelSpan.className = 'cb-swatch-label';
        labelSpan.textContent = 'Gaps';

        wrapper.appendChild(select);
        wrapper.appendChild(labelSpan);
        return wrapper;
    }

    /** Live Paint tool bar: colors, gaps, and Make/Release group. */
    private renderLivePaint(info: ContextInfo) {
        // Fill (regions) and Stroke (edges) colors. These set only the Live Paint
        // paint color — they do NOT modify the selected shapes.
        this.el.appendChild(
            this.createColorSwatch(
                'fill',
                this.ui.rgbToHex(this.ui.getLivePaintFill()),
                (color) => {
                    this.ui.setLivePaintFill(color);
                },
            ),
        );
        this.el.appendChild(
            this.createColorSwatch(
                'stroke',
                this.ui.rgbToHex(this.ui.getLivePaintStroke()),
                (color) => {
                    this.ui.setLivePaintStroke(color);
                },
            ),
        );
        this.el.appendChild(this.createSeparator());
        this.el.appendChild(this.createGapControl());
        this.el.appendChild(this.createSeparator());

        const group = this.scene.getLivePaintGroup();
        if (group >= 0) {
            this.el.appendChild(this.createBadge('Editing Live Paint'));
            this.el.appendChild(
                this.createHint('Click a region to fill · ⌥-click a line to paint its edge'),
            );
            this.el.appendChild(this.createSeparator());
            this.el.appendChild(
                this.createButton(
                    'Done',
                    '✓',
                    () => {
                        this.input.exitLivePaintGroup();
                    },
                    false,
                    '⏎',
                ),
            );
        } else if (info.selectedIds.length > 0) {
            this.el.appendChild(
                this.createButton('Make Live Paint Group', iconGroup(14), () => {
                    this.input.makeLivePaintGroup();
                }),
            );
            this.el.appendChild(this.createSeparator());
            this.el.appendChild(
                this.createHint('Groups the selected shapes so you can paint inside them'),
            );
        } else {
            this.el.appendChild(
                this.createHint(
                    'Select shapes and click Live Paint to make a group, then fill its regions',
                ),
            );
        }
    }

    /** One Rect/Ellipse/Path selected. */
    private renderSingleShape(info: ContextInfo) {
        this.appendSelectionBadge(info);

        this.el.appendChild(
            this.createButton(
                'Edit Path',
                iconPencil(14),
                () => {
                    if (info.selectedIds.length === 1) {
                        this.ui.setActiveTool('direct');
                        this.input.enterPathEditMode(info.selectedIds[0]);
                    }
                },
                false,
                '⏎',
            ),
        );

        // Offset Path — only for a Path node. A small distance field (negative =
        // inset) plus a button; creates a new parallel path.
        if (info.selectedNodes[0]?.node_type === 'Path') {
            const wrap = document.createElement('div');
            wrap.style.display = 'inline-flex';
            wrap.style.alignItems = 'center';
            wrap.style.gap = '4px';
            const amt = document.createElement('input');
            amt.type = 'number';
            amt.className = 'cb-num';
            amt.value = String(this.input.lastOffsetAmount);
            amt.title = 'Offset distance (negative = inset)';
            const applyOffset = () => {
                const d = parseFloat(amt.value);
                if (Number.isFinite(d) && d !== 0) this.input.offsetSelectedPath(d);
            };
            amt.addEventListener('click', (e) => e.stopPropagation());
            amt.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    applyOffset();
                }
            });
            const offsetIcon =
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="12" height="12" rx="2"/><rect x="9" y="9" width="12" height="12" rx="2"/></svg>';
            wrap.appendChild(amt);
            wrap.appendChild(this.createButton('Offset', offsetIcon, applyOffset));
            this.el.appendChild(wrap);

            // Simplify — only surfaces when the path has enough points to be worth
            // reducing (progressive disclosure). Tolerance field + button.
            if (this.input.selectedPathPointCount() >= 6) {
                const sWrap = document.createElement('div');
                sWrap.style.display = 'inline-flex';
                sWrap.style.alignItems = 'center';
                sWrap.style.gap = '4px';
                const tol = document.createElement('input');
                tol.type = 'number';
                tol.className = 'cb-num';
                tol.min = '0';
                tol.value = String(this.input.lastSimplifyTolerance);
                tol.title = 'Simplify tolerance (larger = fewer points)';
                const applySimplify = () => {
                    const t = parseFloat(tol.value);
                    if (Number.isFinite(t) && t >= 0) this.input.simplifySelectedPath(t);
                };
                tol.addEventListener('click', (e) => e.stopPropagation());
                tol.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        applySimplify();
                    }
                });
                const simplifyIcon =
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c4 0 5-10 9-10s5 6 9 6"/></svg>';
                sWrap.appendChild(tol);
                sWrap.appendChild(this.createButton('Simplify', simplifyIcon, applySimplify));
                this.el.appendChild(sWrap);
            }

            // Width profile — only for an OPEN path (that's what a profile shapes).
            // A single dropdown of profiles that outline the stroke into a tapered
            // filled shape (matches the Boolean dropdown pattern).
            const hasOpen = this.scene
                .getNodeGeometry(info.selectedIds[0])
                ?.Path?.subpaths?.some((sp) => !sp.closed);
            if (hasOpen) {
                const sw = (d: string) =>
                    `<svg width="14" height="10" viewBox="0 0 28 20" fill="currentColor">${d}</svg>`;
                const profiles: Array<{ id: WidthProfile; label: string; icon: string }> = [
                    {
                        id: 'uniform',
                        label: 'Uniform',
                        icon: sw('<rect x="2" y="8" width="24" height="4"/>'),
                    },
                    {
                        id: 'taper-end',
                        label: 'Taper',
                        icon: sw('<path d="M2 6 L26 10 L2 14 Z"/>'),
                    },
                    {
                        id: 'taper-both',
                        label: 'Taper both',
                        icon: sw('<path d="M2 10 Q14 3 26 10 Q14 17 2 10 Z"/>'),
                    },
                    {
                        id: 'bulge',
                        label: 'Bulge',
                        icon: sw('<path d="M2 8 Q14 0 26 8 L26 12 Q14 20 2 12 Z"/>'),
                    },
                ];
                this.el.appendChild(
                    this.createDropdown(
                        'Width',
                        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12 Q12 4 21 12 Q12 20 3 12 Z"/></svg>',
                        profiles.map((p) => ({
                            label: p.label,
                            icon: p.icon,
                            onSelect: () => this.input.applyWidthProfileToSelection(p.id),
                        })),
                    ),
                );
            }
        }

        this.appendTransformActions(info, { flatten: true });
        this.appendLifecycleActions();
    }

    /** One Text node selected: text actions, not text properties (those are in the panel). */
    private renderTextSelected(info: ContextInfo) {
        this.appendSelectionBadge(info);

        const nodeId = info.selectedIds[0];

        this.el.appendChild(
            this.createButton(
                'Edit Text',
                iconPencil(14),
                () => {
                    this.input.editTextNode(nodeId);
                },
                false,
                '⏎',
            ),
        );

        this.el.appendChild(
            this.createButton(
                'Create Outlines',
                iconCreateOutlines(14),
                () => {
                    void this.input.createOutlines(nodeId);
                },
                false,
                '⌘⇧O',
            ),
        );

        this.appendTransformActions(info, { flatten: false });
        this.appendLifecycleActions();
    }

    /** Exactly one Group selected. */
    private renderGroupSelected(info: ContextInfo) {
        this.appendSelectionBadge(info);

        const id = info.selectedIds[0];
        // A Boolean Group gets a dedicated control set: switch op, edit operands,
        // flatten to a path, or release back to a plain group.
        if (info.selectedIds.length === 1 && this.scene.isBooleanGroup(id)) {
            this.renderBooleanGroupControls(id, info);
            return;
        }

        this.el.appendChild(
            this.createButton(
                'Enter Group',
                iconCornerDownRight(14),
                () => {
                    if (info.selectedIds.length === 1) {
                        this.input.enterSelectedNode(info.selectedIds[0]);
                    }
                },
                false,
                '⏎',
            ),
        );

        this.el.appendChild(
            this.createButton(
                'Ungroup',
                iconUngroup(14),
                () => {
                    this.input.ungroupSelection();
                },
                false,
                '⌘⇧G',
            ),
        );

        this.appendTransformActions(info, { flatten: true });
        this.appendLifecycleActions();
    }

    /** Controls for a selected non-destructive Boolean Group. */
    private renderBooleanGroupControls(id: number, info: ContextInfo) {
        const curOp = BOOL_OP_BY_INDEX[this.scene.getBooleanOp(id)] ?? 'union';

        this.el.appendChild(
            this.createDropdown(
                `Boolean · ${BOOL_OP_META[curOp].label}`,
                BOOL_OP_META[curOp].icon(),
                BOOL_OP_ORDER.map((op) => ({
                    label: BOOL_OP_META[op].label,
                    icon: BOOL_OP_META[op].icon(),
                    active: op === curOp,
                    onSelect: () => {
                        this.scene.setBooleanOp(this.ui.ck, id, op);
                        this.ui.syncWithSelection();
                    },
                })),
            ),
        );

        this.el.appendChild(this.createSeparator());

        this.el.appendChild(
            this.createButton(
                'Edit',
                iconCornerDownRight(14),
                () => {
                    this.input.enterSelectedNode(id);
                },
                false,
                '⏎',
            ),
        );

        this.el.appendChild(
            this.createButton('Flatten', iconCreateOutlines(14), () => {
                const pid = this.scene.flattenBoolean(this.ui.ck, id);
                if (pid >= 0) {
                    this.ui.syncWithSelection();
                    this.ui.updateLayerList();
                }
            }),
        );

        this.el.appendChild(
            this.createButton('Release', iconUngroup(14), () => {
                this.scene.releaseBoolean(id);
                this.ui.syncWithSelection();
                this.ui.updateLayerList();
            }),
        );

        this.appendTransformActions(info, { flatten: true });
        this.appendLifecycleActions();
    }

    /** Two or more nodes selected. */
    private renderMultiSelect(info: ContextInfo) {
        this.el.appendChild(this.createBadge(`${info.selectedIds.length} selected`));
        this.el.appendChild(this.createSeparator());

        // Align / distribute
        const alignActions: Array<[string, string, AlignMode]> = [
            ['Align left', iconAlignLeft(14), 'left'],
            ['Align center', iconAlignCenterH(14), 'hcenter'],
            ['Align right', iconAlignRight(14), 'right'],
            ['Align top', iconAlignTop(14), 'top'],
            ['Align middle', iconAlignCenterV(14), 'vcenter'],
            ['Align bottom', iconAlignBottom(14), 'bottom'],
        ];
        for (const [title, icon, mode] of alignActions) {
            this.el.appendChild(
                this.createIconButton(title, icon, () => {
                    alignSelection(this.scene, [...info.selectedIds], mode);
                    this.ui.syncWithSelection();
                }),
            );
        }
        if (info.selectedIds.length >= 3) {
            this.el.appendChild(
                this.createIconButton('Distribute horizontally', iconDistributeH(14), () => {
                    distributeSelection(this.scene, [...info.selectedIds], 'h');
                    this.ui.syncWithSelection();
                }),
            );
            this.el.appendChild(
                this.createIconButton('Distribute vertically', iconDistributeV(14), () => {
                    distributeSelection(this.scene, [...info.selectedIds], 'v');
                    this.ui.syncWithSelection();
                }),
            );
        }

        // Boolean operations — only when every selected node is combinable geometry
        const allBoolCompatible =
            info.selectedNodes.length === info.selectedIds.length &&
            info.selectedNodes.every((n) => BOOLEAN_COMPATIBLE.has(n.node_type));
        if (allBoolCompatible) {
            this.el.appendChild(this.createSeparator());
            // Figma-style: a single Boolean dropdown creates a non-destructive
            // Boolean Group (children stay editable, op re-evaluates live).
            this.el.appendChild(
                this.createDropdown(
                    'Boolean',
                    iconBoolUnion(14),
                    BOOL_OP_ORDER.map((op) => ({
                        label: BOOL_OP_META[op].label,
                        icon: BOOL_OP_META[op].icon(),
                        onSelect: () => {
                            const gid = this.scene.makeBooleanGroup(
                                this.ui.ck,
                                [...info.selectedIds],
                                op,
                            );
                            if (gid >= 0) {
                                this.ui.syncWithSelection();
                                this.ui.updateLayerList();
                            }
                        },
                    })),
                ),
            );
        }

        // Blend — exactly two combinable shapes: generate in-between shapes.
        // Minimal UI: a steps field + a Blend button (matches the Offset control).
        if (allBoolCompatible && info.selectedIds.length === 2) {
            const wrap = document.createElement('div');
            wrap.style.display = 'inline-flex';
            wrap.style.alignItems = 'center';
            wrap.style.gap = '4px';
            const steps = document.createElement('input');
            steps.type = 'number';
            steps.className = 'cb-num';
            steps.min = '1';
            steps.value = String(this.input.lastBlendSteps);
            steps.title = 'Number of in-between shapes';
            const doBlend = () => {
                const n = Math.max(1, Math.round(parseFloat(steps.value) || 0));
                if (n >= 1) this.input.blendSelection(n);
            };
            steps.addEventListener('click', (e) => e.stopPropagation());
            steps.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    doBlend();
                }
            });
            const blendIcon =
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.5 8.5l7 7" stroke-dasharray="2 2"/></svg>';
            wrap.appendChild(steps);
            wrap.appendChild(this.createButton('Blend', blendIcon, doBlend));
            this.el.appendChild(wrap);
        }

        this.el.appendChild(this.createSeparator());

        // Join Paths — only when exactly two Path nodes are selected
        const twoPaths =
            info.selectedIds.length === 2 &&
            info.selectedNodes.length === 2 &&
            info.selectedNodes.every((n) => n.node_type === 'Path');
        if (twoPaths) {
            this.el.appendChild(
                this.createButton(
                    'Join',
                    iconLink(14),
                    () => {
                        this.input.joinSelectedPaths();
                    },
                    false,
                    '⌘J',
                ),
            );
        }

        this.el.appendChild(
            this.createButton(
                'Group',
                iconGroup(14),
                () => {
                    this.input.groupSelection();
                },
                false,
                '⌘G',
            ),
        );

        this.appendTransformActions(info, { flatten: false });
        this.appendLifecycleActions();
    }

    /** Pen tool with a path in progress: progress + commit/cancel. */
    private renderPenDrawing(info: ContextInfo) {
        this.el.appendChild(this.createBadge(`${info.pointCount} pts`));
        this.el.appendChild(this.createSeparator());

        this.el.appendChild(
            this.createHint(
                'Click to add points · drag for curves · Enter or Esc to finish · click first point to close',
            ),
        );

        this.el.appendChild(this.createSeparator());

        this.el.appendChild(
            this.createButton(
                'Finish',
                '✓',
                () => {
                    this.input.finalizePenPath();
                },
                false,
                '⏎',
            ),
        );

        this.el.appendChild(
            this.createButton(
                'Cancel',
                '✕',
                () => {
                    this.input.abandonPenPath();
                    this.refresh();
                },
                true,
            ),
        );
    }

    /** Node-editing mode: point counts + point actions + exit. */
    private renderPathEditing(info: ContextInfo) {
        const countText =
            info.selectedPointCount > 0
                ? `${info.selectedPointCount} / ${info.pointCount} points`
                : `${info.pointCount} points`;
        this.el.appendChild(this.createBadge(countText));

        this.el.appendChild(this.createSeparator());

        // Add Point (toggles; highlighted while armed)
        const addBtn = this.createIconButton(
            'Add Point',
            iconPlusCircle(14),
            () => {
                this.input.addPointMode = !this.input.addPointMode;
                this.refresh();
            },
            '+',
        );
        if (this.input.addPointMode) addBtn.classList.add('cb-btn-active');
        this.el.appendChild(addBtn);

        // Delete Point (needs a selection)
        const delBtn = this.createIconButton(
            'Delete Point',
            iconMinusCircle(14),
            () => {
                this.input.deleteSelectedPoints();
            },
            '⌫',
        );
        if (info.selectedPointCount === 0) delBtn.setAttribute('disabled', '');
        this.el.appendChild(delBtn);

        // Cut at the selected anchor (scissors with zero aiming — the point is
        // already selected). Only offered for exactly one anchor.
        if (info.selectedPointCount === 1) {
            this.el.appendChild(
                this.createButton('Cut at Point', iconScissors(14), () => {
                    this.input.cutAtSelectedPoint();
                }),
            );
        }

        // Merge selected points into one (endpoints weld/close, adjacent collapse)
        if (info.selectedPointCount >= 2) {
            this.el.appendChild(
                this.createButton(
                    'Merge',
                    iconLink(14),
                    () => {
                        this.input.mergeSelectedPoints();
                    },
                    false,
                    '⌘J',
                ),
            );
        }

        this.el.appendChild(this.createSeparator());

        // Hint tracks what the NEXT click will do
        let hint =
            'Drag points · ⌥drag an anchor for handles · ⇧click or marquee to multi-select · Esc to finish';
        if (this.input.addPointMode) hint = 'Click a segment to insert a point';
        else if (info.selectedPointCount === 1) hint = 'Cut splits the path at the selected point';
        else if (info.selectedPointCount >= 2) hint = '⌘J merges the selected points';
        this.el.appendChild(this.createHint(hint));

        this.el.appendChild(this.createSeparator());

        // Done (exit edit mode) — the committing action is always last
        this.el.appendChild(
            this.createButton(
                'Done',
                '✓',
                () => {
                    this.input.exitEditMode();
                    this.ui.setActiveTool('selection');
                },
                false,
                '⏎',
            ),
        );
    }

    // ─── Shared segments (keep every selection state on the same grammar) ──

    /** Leading "what you're acting on" badge for single-node selections. */
    private appendSelectionBadge(info: ContextInfo) {
        const node = info.selectedNodes[0];
        if (!node) return;
        this.el.appendChild(this.createBadge(node.name || `${node.node_type} ${node.id}`));
        this.el.appendChild(this.createSeparator());
    }

    /** Flip H / Flip V (+ optional Flatten), preceded by a separator. */
    private appendTransformActions(_info: ContextInfo, opts: { flatten: boolean }) {
        this.el.appendChild(this.createSeparator());

        this.el.appendChild(
            this.createIconButton(
                'Flip Horizontal',
                iconFlipH(),
                () => {
                    this.input.flipSelection('h');
                },
                '⇧H',
            ),
        );
        this.el.appendChild(
            this.createIconButton(
                'Flip Vertical',
                iconFlipV(),
                () => {
                    this.input.flipSelection('v');
                },
                '⇧V',
            ),
        );
        if (opts.flatten) {
            this.el.appendChild(
                this.createIconButton(
                    'Flatten',
                    iconFlatten(),
                    () => {
                        this.input.flattenSelection();
                    },
                    '⌘E',
                ),
            );
        }
    }

    /** Trailing Duplicate · Delete — identical in every selection state. */
    private appendLifecycleActions() {
        this.el.appendChild(this.createSeparator());

        this.el.appendChild(
            this.createButton(
                'Duplicate',
                iconCopy(14),
                () => {
                    this.input.duplicateSelection();
                },
                false,
                '⌘D',
            ),
        );

        this.el.appendChild(
            this.createButton(
                'Delete',
                iconTrash(14),
                () => {
                    this.input.deleteSelection();
                },
                true,
                '⌫',
            ),
        );
    }

    // ─── DOM Helpers ────────────────────────────────────────────────

    private createColorSwatch(
        label: string,
        currentValue: string,
        onChange: (color: string) => void,
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cb-swatch-wrapper';
        wrapper.setAttribute('data-tooltip', `Default ${label}`);

        const initial = parseHex(currentValue) ?? { r: 0, g: 0, b: 0, a: 1 };
        const { el: swatch } = createColorSwatch({
            color: initial,
            alpha: false,
            title: `Default ${label}`,
            className: 'cb-swatch',
            onInput: (c) => onChange(colorToHex(c, false)),
        });

        wrapper.appendChild(swatch);

        const labelSpan = document.createElement('span');
        labelSpan.className = 'cb-swatch-label';
        labelSpan.textContent = label.charAt(0).toUpperCase() + label.slice(1);
        wrapper.appendChild(labelSpan);

        return wrapper;
    }

    private createSeparator(): HTMLElement {
        const sep = document.createElement('div');
        sep.className = 'cb-separator';
        return sep;
    }

    private createBadge(text: string): HTMLElement {
        const badge = document.createElement('span');
        badge.className = 'cb-badge';
        badge.textContent = text;
        return badge;
    }

    private createHint(text: string): HTMLElement {
        const hint = document.createElement('span');
        hint.className = 'cb-hint';
        hint.textContent = text;
        return hint;
    }

    /** A labeled button that opens a small popup menu (Figma-style split control).
     *  The menu is appended to <body> with fixed positioning so it can't be
     *  clipped by the bar, and dismisses on any outside pointerdown. */
    private createDropdown(
        label: string,
        icon: string,
        items: Array<{
            label: string;
            icon: string;
            shortcut?: string;
            danger?: boolean;
            active?: boolean;
            onSelect: () => void;
        }>,
    ): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'cb-dropdown';

        const btn = document.createElement('button');
        btn.className = 'cb-btn cb-dropdown-btn';
        btn.innerHTML = `<span class="cb-btn-icon">${icon}</span><span class="cb-btn-text">${label}</span><span class="cb-caret">▾</span>`;
        wrap.appendChild(btn);

        let menu: HTMLElement | null = null;
        const onDoc = (e: PointerEvent) => {
            if (menu && !menu.contains(e.target as Node) && !wrap.contains(e.target as Node))
                close();
        };
        const close = () => {
            if (menu) {
                menu.remove();
                menu = null;
            }
            document.removeEventListener('pointerdown', onDoc, true);
        };
        const open = () => {
            menu = document.createElement('div');
            menu.className = 'cb-menu';
            for (const it of items) {
                const mi = document.createElement('button');
                mi.className =
                    'cb-menu-item' +
                    (it.danger ? ' cb-menu-item-danger' : '') +
                    (it.active ? ' cb-menu-item-active' : '');
                mi.innerHTML =
                    `<span class="cb-btn-icon">${it.icon}</span>` +
                    `<span class="cb-menu-item-label">${it.label}</span>` +
                    (it.shortcut
                        ? `<span class="cb-menu-item-shortcut">${it.shortcut}</span>`
                        : '');
                mi.addEventListener('click', (e) => {
                    e.stopPropagation();
                    close();
                    it.onSelect();
                });
                menu.appendChild(mi);
            }
            menu.style.position = 'fixed';
            menu.style.visibility = 'hidden';
            document.body.appendChild(menu);
            // The bar lives at the bottom of the screen, so open upward.
            const r = btn.getBoundingClientRect();
            const h = menu.offsetHeight;
            menu.style.left = `${Math.round(r.left)}px`;
            menu.style.top = `${Math.round(r.top - h - 4)}px`;
            menu.style.visibility = 'visible';
            document.addEventListener('pointerdown', onDoc, true);
        };
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (menu) close();
            else open();
        });
        return wrap;
    }

    /** Compact icon-only button (align/boolean/flip rows). The label lives in
     *  the tooltip, with the shortcut appended when the action has one. */
    private createIconButton(
        title: string,
        icon: string,
        onClick: () => void,
        shortcut?: string,
    ): HTMLElement {
        const btn = document.createElement('button');
        btn.className = 'cb-btn cb-btn-icon-only';
        btn.setAttribute('data-tooltip', title);
        if (shortcut) btn.setAttribute('data-shortcut', shortcut);
        btn.innerHTML = icon;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    /** Labeled button. Shortcuts never appear in the label — only in the
     *  tooltip, so a tooltip is added exactly when the action has a shortcut. */
    private createButton(
        title: string,
        icon: string,
        onClick: () => void,
        danger = false,
        shortcut?: string,
    ): HTMLElement {
        const btn = document.createElement('button');
        btn.className = `cb-btn${danger ? ' cb-btn-danger' : ''}`;
        if (shortcut) {
            btn.setAttribute('data-tooltip', title);
            btn.setAttribute('data-shortcut', shortcut);
        }
        btn.innerHTML = `<span class="cb-btn-icon">${icon}</span><span class="cb-btn-text">${title}</span>`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }
}
