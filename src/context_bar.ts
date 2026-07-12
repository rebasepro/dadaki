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
import { computeBlendSubpaths } from './blend';
import type { BoolOp } from './boolean_ops';
import { applyPathfinder, BOOL_OP_BY_INDEX, transformSubpaths } from './boolean_ops';
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
import { computeOffsetSubpaths } from './offset_path';
import type { Renderer } from './renderer';
import { computeSimplifiedSubpaths } from './simplify_path';
import type { Subpath } from './types';
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
        // Single-shape path controls (Simplify point-count gate, Outline Width
        // open-stroked-path gate) depend on the path's geometry and whether it has
        // a stroke, both of which in-place edits mutate — hash them so the bar
        // rebuilds after Simplify/Offset/adding or removing a stroke.
        let geoSig = '';
        if (info.context === 'single-shape' && info.selectedIds.length === 1) {
            const subs = this.scene.getNodeGeometry(info.selectedIds[0])?.Path?.subpaths;
            if (subs) {
                const pts = subs.reduce((n, s) => n + s.points.length, 0);
                const anyOpen = subs.some((s) => !s.closed) ? 'o' : 'c';
                const hasStroke =
                    (this.scene.getNodeStyle(info.selectedIds[0])?.strokes?.length ?? 0) > 0
                        ? 's'
                        : '';
                geoSig = `|geo${pts}${anyOpen}${hasStroke}`;
            }
        }
        // Guide selection (+ its lock state) drives the guide bar.
        const g = this.input.selectedGuide;
        const guideSig = g
            ? `|guide${g.axis}${g.index}${this.input.selectedGuideLocked() ? 'L' : ''}`
            : '';
        return `${info.context}|${this.ui.activeTool}|${info.selectedIds.join(',')}|${types}|${names}|${info.pointCount}|${info.selectedPointCount}|${this.input.addPointMode ? 1 : 0}${styleSig}${lpSig}${boolSig}${geoSig}${guideSig}`;
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
            case 'guide-selected':
                this.renderGuideSelected();
                break;
        }
    }

    /** A ruler guide is selected: lock/unlock it or delete it. */
    private renderGuideSelected() {
        const axis = this.input.selectedGuide?.axis;
        this.el.appendChild(this.createBadge(axis === 'x' ? 'Vertical guide' : 'Horizontal guide'));
        this.el.appendChild(this.createSeparator());

        const locked = this.input.selectedGuideLocked();
        const lockIcon = locked
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
        this.el.appendChild(
            this.createButton(
                locked ? 'Unlock' : 'Lock',
                lockIcon,
                () => this.input.toggleSelectedGuideLock(),
                false,
                undefined,
                locked
                    ? 'Unlock this guide so it can be moved again.'
                    : 'Lock this guide in place so it can’t be moved by dragging.',
            ),
        );

        this.el.appendChild(
            this.createButton(
                'Delete',
                iconTrash(14),
                () => this.input.deleteSelectedGuide(),
                true,
                '⌫',
            ),
        );
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

        // Edit Path is the only path action important enough to sit inline. Every
        // occasional op is a command in the one "More" menu — including Offset Copy,
        // which (like Illustrator's Object › Path › Offset Path) opens a little value
        // popover when picked instead of parking a number field in the bar. So the
        // bar reads the same in every view: primary → More → transform → Dup/Delete.
        if (info.selectedNodes[0]?.node_type === 'Path') {
            this.el.appendChild(this.buildPathMoreMenu(info));
        }

        this.appendTransformActions(info, { flatten: true });
        this.appendLifecycleActions();
    }

    /** Hand a world-space ghost to the renderer (or clear it). */
    private setShapePreview(subpaths: Subpath[] | null, fillRule = 0) {
        this.input.shapePreview = subpaths?.length ? { subpaths, fillRule } : null;
        this.scene.renderer?.requestRender();
    }

    /** A small value dialog (Illustrator's Offset-Path model) that any customizable
     *  command opens: a scrub field + Apply, Enter to run, Esc/outside to cancel,
     *  with an optional live preview. Nothing happens until you confirm. */
    private openValuePopover(
        anchor: HTMLElement,
        opts: {
            label: string;
            value: number;
            min?: number;
            step?: number;
            title?: string;
            onPreview?: (value: number) => void;
            onClearPreview?: () => void;
            onApply: (value: number) => void;
        },
    ) {
        document.querySelector('.cb-value-popover')?.remove();

        const pop = document.createElement('div');
        pop.className = 'cb-value-popover';

        let input!: HTMLInputElement;
        const field = this.createScrubField(opts.label, opts.value, {
            min: opts.min,
            step: opts.step,
            title: opts.title,
            onChange: () => opts.onPreview?.(parseFloat(input.value)),
        });
        input = field.input;

        const close = () => {
            opts.onClearPreview?.();
            pop.remove();
            document.removeEventListener('pointerdown', onDoc, true);
        };
        const apply = () => {
            const v = parseFloat(input.value);
            close();
            if (Number.isFinite(v)) opts.onApply(v);
        };
        const onDoc = (e: PointerEvent) => {
            if (!pop.contains(e.target as Node)) close();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                apply();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
            }
        });

        const applyBtn = this.createButton(
            'Apply',
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 6"/></svg>',
            apply,
        );

        pop.appendChild(field.wrap);
        pop.appendChild(applyBtn);
        pop.style.position = 'fixed';
        pop.style.visibility = 'hidden';
        document.body.appendChild(pop);

        const r = anchor.getBoundingClientRect();
        const h = pop.offsetHeight;
        pop.style.left = `${Math.round(r.left)}px`;
        pop.style.top = `${Math.round(r.top - h - 8)}px`;
        pop.style.visibility = 'visible';

        // Defer so the click that opened the popover doesn't immediately close it.
        setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
        input.focus();
        input.select();
        opts.onPreview?.(parseFloat(input.value)); // show the ghost immediately
    }

    /** The "More" overflow menu for a single Path — every occasional path op is a
     *  command here (Offset opens a value popover; the rest run immediately). */
    private buildPathMoreMenu(info: ContextInfo): HTMLElement {
        const id = info.selectedIds[0];
        type Item = { label: string; icon: string; onSelect: () => void; danger?: boolean };
        const items: Item[] = [];

        const offsetIcon =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="12" height="12" rx="2"/><rect x="9" y="9" width="12" height="12" rx="2"/></svg>';
        items.push({
            label: 'Offset Copy…',
            icon: offsetIcon,
            onSelect: () =>
                this.openValuePopover(this.el, {
                    label: 'Offset',
                    value: this.input.lastOffsetAmount,
                    title: 'Offset distance (negative = inset)',
                    onPreview: (v) => {
                        const local =
                            Number.isFinite(v) && v !== 0
                                ? computeOffsetSubpaths(this.ui.ck, this.scene, id, v)
                                : null;
                        this.setShapePreview(
                            local
                                ? transformSubpaths(local.subpaths, this.scene.getTransform(id))
                                : null,
                            local?.fillRule ?? 0,
                        );
                    },
                    onClearPreview: () => this.setShapePreview(null),
                    onApply: (v) => {
                        if (v !== 0) this.input.offsetSelectedPath(v);
                    },
                }),
        });

        // Simplify only when the path has enough points to be worth reducing.
        if (this.input.selectedPathPointCount() >= 6) {
            const simplifyIcon =
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c4 0 5-10 9-10s5 6 9 6"/></svg>';
            items.push({
                label: 'Simplify…',
                icon: simplifyIcon,
                onSelect: () =>
                    this.openValuePopover(this.el, {
                        label: 'Amount',
                        value: this.input.lastSimplifyTolerance,
                        min: 0,
                        title: 'Simplify tolerance (larger = fewer points)',
                        onPreview: (v) => {
                            const local =
                                Number.isFinite(v) && v >= 0
                                    ? computeSimplifiedSubpaths(this.scene, id, v)
                                    : null;
                            this.setShapePreview(
                                local
                                    ? transformSubpaths(local, this.scene.getTransform(id))
                                    : null,
                            );
                        },
                        onClearPreview: () => this.setShapePreview(null),
                        onApply: (v) => {
                            if (v >= 0) this.input.simplifySelectedPath(v);
                        },
                    }),
            });
        }

        const reverseIcon =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h14"/><path d="M13 6l6 6-6 6"/><path d="M3 12V8"/></svg>';
        items.push({
            label: 'Reverse direction',
            icon: reverseIcon,
            onSelect: () => this.input.reverseSelectedPath(),
        });

        // Outline Width — destructive: replaces a stroked open path with a filled
        // tapered shape. Only for an open path that actually has a stroke.
        const openWithStroke =
            this.scene.getNodeGeometry(id)?.Path?.subpaths?.some((sp) => !sp.closed) &&
            (this.scene.getNodeStyle(id)?.strokes?.length ?? 0) > 0;
        if (openWithStroke) {
            const sw = (p: string) =>
                `<svg width="14" height="10" viewBox="0 0 28 20" fill="currentColor">${p}</svg>`;
            const profiles: Array<{ id: WidthProfile; label: string; icon: string }> = [
                {
                    id: 'taper-end',
                    label: 'Outline: Taper',
                    icon: sw('<path d="M2 6 L26 10 L2 14 Z"/>'),
                },
                {
                    id: 'taper-both',
                    label: 'Outline: Taper both',
                    icon: sw('<path d="M2 10 Q14 3 26 10 Q14 17 2 10 Z"/>'),
                },
                {
                    id: 'bulge',
                    label: 'Outline: Bulge',
                    icon: sw('<path d="M2 8 Q14 0 26 8 L26 12 Q14 20 2 12 Z"/>'),
                },
            ];
            for (const p of profiles) {
                items.push({
                    label: p.label,
                    icon: p.icon,
                    onSelect: () => this.input.applyWidthProfileToSelection(p.id),
                });
            }
        }

        // Release Compound — only when the path has 2+ subpaths.
        if ((this.scene.getNodeGeometry(id)?.Path?.subpaths?.length ?? 0) >= 2) {
            items.push({
                label: 'Release compound',
                icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="12" r="5"/><circle cx="17" cy="12" r="3"/></svg>',
                onSelect: () => this.input.releaseCompoundPath(),
            });
        }

        const moreIcon =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
        return this.createDropdown('More', moreIcon, items, 'Path operations');
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

        // Detach — only when this text is flowing along a path.
        if (this.scene.getTextPath(nodeId) != null) {
            this.el.appendChild(
                this.createButton('Detach from path', iconLink(14), () => {
                    this.scene.clearTextPath(nodeId);
                    this.ui.syncWithSelection();
                    this.ui.updateLayerList();
                }),
            );
        }

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

        // Text on a path — exactly one Text + one Path selected.
        if (info.selectedIds.length === 2) {
            const types = info.selectedNodes.map((n) => n.node_type);
            const ti = types.indexOf('Text');
            const pi = types.indexOf('Path');
            if (ti >= 0 && pi >= 0) {
                const textId = info.selectedIds[ti];
                const pathId = info.selectedIds[pi];
                const icon =
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15c5 0 5-8 10-8s5 6 8 6"/><path d="M7 9V7h6M10 7v4"/></svg>';
                this.el.appendChild(
                    this.createButton('On Path', icon, () => {
                        this.scene.setTextPath(textId, pathId);
                        this.scene.engine?.clear_selection();
                        this.scene.selectNode(textId, false);
                        this.ui.syncWithSelection();
                        this.ui.updateLayerList();
                    }),
                );
                this.el.appendChild(this.createSeparator());
            }
        }

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

        // Boolean — the one primary "combine" action: a dropdown that unites/
        // subtracts/intersects/excludes into a non-destructive Boolean Group
        // (children stay editable). The destructive/niche combine variants
        // (Compound, Minus Back, Crop, Blend, Join) live in the More menu, so the
        // bar isn't a wall of overlapping combine buttons.
        const allBoolCompatible =
            info.selectedNodes.length === info.selectedIds.length &&
            info.selectedNodes.every((n) => BOOLEAN_COMPATIBLE.has(n.node_type));
        if (allBoolCompatible) {
            this.el.appendChild(this.createSeparator());
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
                    'Combine into a non-destructive boolean group — children stay editable.',
                ),
            );
        }

        const moreMenu = this.buildMultiMoreMenu(info, allBoolCompatible);
        if (moreMenu) this.el.appendChild(moreMenu);

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

    /** "More" overflow for a multi-selection — the occasional combine/path ops that
     *  don't warrant their own top-level button (Compound, the destructive
     *  pathfinders, Blend, Join). Returns null when none apply. */
    private buildMultiMoreMenu(info: ContextInfo, allBoolCompatible: boolean): HTMLElement | null {
        type Item = { label: string; icon: string; onSelect: () => void };
        const items: Item[] = [];
        const ids = [...info.selectedIds];

        if (allBoolCompatible && info.selectedIds.length === 2) {
            const [idA, idB] = info.selectedIds;
            items.push({
                label: 'Blend…',
                icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.5 8.5l7 7" stroke-dasharray="2 2"/></svg>',
                onSelect: () =>
                    this.openValuePopover(this.el, {
                        label: 'Steps',
                        value: this.input.lastBlendSteps,
                        min: 1,
                        step: 1,
                        title: 'Number of in-between shapes',
                        onPreview: (v) =>
                            this.setShapePreview(
                                Number.isFinite(v)
                                    ? computeBlendSubpaths(
                                          this.ui.ck,
                                          this.scene,
                                          idA,
                                          idB,
                                          Math.max(1, Math.round(v)),
                                      )
                                    : null,
                            ),
                        onClearPreview: () => this.setShapePreview(null),
                        onApply: (v) => this.input.blendSelection(Math.max(1, Math.round(v))),
                    }),
            });
        }

        if (allBoolCompatible) {
            items.push({
                label: 'Compound path',
                icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>',
                onSelect: () => this.input.makeCompoundPath(),
            });
            // Minus Back = front shape minus everything behind it (the opposite
            // direction from Boolean › Subtract). Crop was dropped — for two shapes
            // it's identical to Boolean › Intersect, and this build doesn't do
            // Illustrator's real Crop (clip lower objects, keep their own fills).
            items.push({
                label: 'Minus Back',
                icon: iconBoolSubtract(14),
                onSelect: () => {
                    if (applyPathfinder(this.ui.ck, this.scene, ids, 'minus-back') != null) {
                        this.ui.syncWithSelection();
                        this.ui.updateLayerList();
                    }
                },
            });
        }

        const twoPaths =
            info.selectedIds.length === 2 &&
            info.selectedNodes.length === 2 &&
            info.selectedNodes.every((n) => n.node_type === 'Path');
        if (twoPaths) {
            items.push({
                label: 'Join paths',
                icon: iconLink(14),
                onSelect: () => this.input.joinSelectedPaths(),
            });
        }

        if (items.length === 0) return null;
        const moreIcon =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
        return this.createDropdown('More', moreIcon, items, 'More combine & path operations');
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

            // Average the selected anchors onto a common line (Illustrator's Average).
            const avgIcon = (d: string) =>
                `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${d}</svg>`;
            this.el.appendChild(
                this.createDropdown(
                    'Average',
                    avgIcon(
                        '<circle cx="6" cy="8" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="16" r="1.6" fill="currentColor" stroke="none"/><path d="M4 12h16"/>',
                    ),
                    [
                        {
                            label: 'Horizontal',
                            icon: avgIcon('<path d="M4 12h16"/>'),
                            onSelect: () => this.input.averageSelectedPoints('h'),
                        },
                        {
                            label: 'Vertical',
                            icon: avgIcon('<path d="M12 4v16"/>'),
                            onSelect: () => this.input.averageSelectedPoints('v'),
                        },
                        {
                            label: 'Both',
                            icon: avgIcon('<circle cx="12" cy="12" r="4"/>'),
                            onSelect: () => this.input.averageSelectedPoints('both'),
                        },
                    ],
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

    /** A context-bar numeric field that matches the properties panel exactly: a
     *  `.dim-input` box with a draggable `.dim-label` handle (the Figma "slider" —
     *  drag = adjust, Shift = ×10) and a plain text input for typing. `onChange`
     *  fires on every value change (scrub or type). */
    private createScrubField(
        label: string,
        value: number,
        opts?: { min?: number; step?: number; title?: string; onChange?: () => void },
    ): { wrap: HTMLElement; input: HTMLInputElement } {
        const wrap = document.createElement('div');
        wrap.className = 'dim-input cb-dim-input';

        const handle = document.createElement('span');
        handle.className = 'dim-label';
        handle.textContent = label;
        if (opts?.title) handle.title = opts.title;

        const input = document.createElement('input');
        input.type = 'number';
        input.value = String(value);
        if (opts?.min !== undefined) input.min = String(opts.min);
        if (opts?.step !== undefined) input.step = String(opts.step);
        input.addEventListener('click', (e) => e.stopPropagation());
        if (opts?.onChange) input.addEventListener('input', opts.onChange);

        this.makeScrubbable(handle, input, opts?.onChange);

        wrap.appendChild(handle);
        wrap.appendChild(input);
        return { wrap, input };
    }

    /** Scrub `input`'s value by dragging `handle` (the `.dim-label`) — matches the
     *  properties panel: drag = adjust, Shift = ×10, plain click focuses the input
     *  to type. `onChange` fires on each change. */
    private makeScrubbable(handle: HTMLElement, input: HTMLInputElement, onChange?: () => void) {
        handle.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const startX = e.clientX;
            const startVal = parseFloat(input.value) || 0;
            const step = parseFloat(input.step) || 1;
            const min = input.min !== '' ? parseFloat(input.min) : Number.NEGATIVE_INFINITY;
            const max = input.max !== '' ? parseFloat(input.max) : Number.POSITIVE_INFINITY;
            let moved = false;
            try {
                handle.setPointerCapture(e.pointerId);
            } catch {}

            const onMove = (ev: PointerEvent) => {
                const dx = ev.clientX - startX;
                if (!moved && Math.abs(dx) < 3) return; // click-vs-drag threshold
                moved = true;
                document.body.classList.add('scrubbing');
                const mult = ev.shiftKey ? 10 : 1;
                const raw = startVal + Math.round(dx) * step * mult;
                const val = Math.max(min, Math.min(max, raw));
                const next = String(Math.round(val * 100) / 100);
                if (next !== input.value) {
                    input.value = next;
                    onChange?.();
                }
            };
            const onUp = () => {
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.removeEventListener('pointercancel', onUp);
                document.body.classList.remove('scrubbing');
                try {
                    handle.releasePointerCapture(e.pointerId);
                } catch {}
                if (!moved) {
                    input.focus();
                    input.select();
                }
            };
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
        });
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
        tooltip?: string,
    ): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'cb-dropdown';

        const btn = document.createElement('button');
        btn.className = 'cb-btn cb-dropdown-btn';
        if (tooltip) btn.setAttribute('data-tooltip', tooltip);
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

    /** Labeled button. Pass `tooltip` to explain what a non-obvious action does
     *  (shown on hover, wraps to a few lines). Shortcuts never appear in the label
     *  — only in the tooltip; a bare shortcut falls back to the label as tooltip. */
    private createButton(
        title: string,
        icon: string,
        onClick: () => void,
        danger = false,
        shortcut?: string,
        tooltip?: string,
    ): HTMLElement {
        const btn = document.createElement('button');
        btn.className = `cb-btn${danger ? ' cb-btn-danger' : ''}`;
        const tip = tooltip ?? (shortcut ? title : undefined);
        if (tip) btn.setAttribute('data-tooltip', tip);
        if (shortcut) btn.setAttribute('data-shortcut', shortcut);
        btn.innerHTML = `<span class="cb-btn-icon">${icon}</span><span class="cb-btn-text">${title}</span>`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }
}
