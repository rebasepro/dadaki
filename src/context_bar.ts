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

import type { UIEngine } from './ui';
import type { InputManager } from './input';
import type { WasmScene } from './wasm_scene';
import type { Renderer } from './renderer';
import { getEditorContext } from './context';
import type { ContextInfo } from './context';
import { alignSelection, distributeSelection } from './align';
import type { AlignMode } from './align';
import { applyBooleanOp } from './boolean_ops';
import type { BoolOp } from './boolean_ops';
import {
    iconPencil, iconTrash, iconCopy,
    iconAlignLeft, iconAlignCenterH, iconAlignRight,
    iconAlignTop, iconAlignCenterV, iconAlignBottom,
    iconDistributeH, iconDistributeV,
    iconBoolUnion, iconBoolSubtract, iconBoolIntersect, iconBoolExclude,
    iconGroup, iconUngroup, iconCornerDownRight,
    iconPlusCircle, iconMinusCircle, iconLink, iconScissors,
    iconFlipH, iconFlipV, iconFlatten,
    iconCreateOutlines,
} from './icons';

/** What each tool does, shown while the tool is armed and nothing is selected. */
const TOOL_HINTS: Record<string, string> = {
    direct: 'Click a shape to edit its anchor points',
    pen: 'Click to place the first point of a path',
    rect: 'Drag to draw a rectangle — Shift: square, Alt: from center',
    ellipse: 'Drag to draw an ellipse — Shift: circle, Alt: from center',
    polygon: 'Drag to draw a polygon — Shift: constrain',
    star: 'Drag to draw a star — Shift: constrain',
    text: 'Click on the canvas to place text',
    scissors: 'Click a path segment or anchor point to cut the path there',
    'paint-bucket': 'Click a region to fill it, or a line to paint the edge',
};

/** Tools whose next action applies the default style — they get style swatches. */
const TOOLS_WITH_FILL = new Set(['pen', 'rect', 'ellipse', 'polygon', 'star', 'paint-bucket']);
const TOOLS_WITH_STROKE = new Set(['pen', 'rect', 'ellipse', 'polygon', 'star', 'paint-bucket']);

/** Node types the boolean operations can combine. */
const BOOLEAN_COMPATIBLE = new Set(['Path', 'Rect', 'Ellipse']);

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
        const types = info.selectedNodes.map(n => n.node_type).join(',');
        const names = info.selectedNodes.map(n => n.name).join(',');
        // Tool contexts render the default-style swatches, so their colors are
        // part of the signature; selection contexts don't show any properties.
        const styleSig = info.context === 'tool'
            ? `|${this.ui.rgbToHex(this.ui.getActiveFillColor())}|${this.ui.rgbToHex(this.ui.getActiveStrokeColor())}`
            : info.context === 'live-paint'
                ? `|${this.ui.rgbToHex(this.ui.getLivePaintFill())}|${this.ui.rgbToHex(this.ui.getLivePaintStroke())}`
                : '';
        // Live Paint bar depends on whether a group is active.
        const lpSig = info.context === 'live-paint' ? `|lp${this.scene.getLivePaintGroup()}` : '';
        return `${info.context}|${this.ui.activeTool}|${info.selectedIds.join(',')}|${types}|${names}|${info.pointCount}|${info.selectedPointCount}|${this.input.addPointMode ? 1 : 0}${styleSig}${lpSig}`;
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
            this.el.appendChild(this.createColorSwatch('fill', this.ui.rgbToHex(this.ui.getActiveFillColor()), (color) => { this.ui.updateActiveFillColor(color); }));
        }
        if (TOOLS_WITH_STROKE.has(tool)) {
            this.el.appendChild(this.createColorSwatch('stroke', this.ui.rgbToHex(this.ui.getActiveStrokeColor()), (color) => { this.ui.updateActiveStrokeColor(color); }));
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

        this.el.appendChild(this.createButton('Edit', iconPencil(14), () => {
            this.input.enterLivePaintGroup(id);
        }, false, '⏎'));

        // Expand bakes the painted faces/edges into real, editable shapes.
        this.el.appendChild(this.createButton('Expand', iconCreateOutlines(14), () => {
            this.input.expandLivePaintGroup(id);
        }));

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
        this.el.appendChild(this.createColorSwatch('fill',
            this.ui.rgbToHex(this.ui.getLivePaintFill()),
            (color) => { this.ui.setLivePaintFill(color); }));
        this.el.appendChild(this.createColorSwatch('stroke',
            this.ui.rgbToHex(this.ui.getLivePaintStroke()),
            (color) => { this.ui.setLivePaintStroke(color); }));
        this.el.appendChild(this.createSeparator());
        this.el.appendChild(this.createGapControl());
        this.el.appendChild(this.createSeparator());

        const group = this.scene.getLivePaintGroup();
        if (group >= 0) {
            this.el.appendChild(this.createBadge('Editing Live Paint'));
            this.el.appendChild(this.createHint('Click a region to fill · ⌥-click a line to paint its edge'));
            this.el.appendChild(this.createSeparator());
            this.el.appendChild(this.createButton('Done', '✓', () => {
                this.input.exitLivePaintGroup();
            }, false, '⏎'));
        } else if (info.selectedIds.length > 0) {
            this.el.appendChild(this.createButton('Make Live Paint Group', iconGroup(14), () => {
                this.input.makeLivePaintGroup();
            }));
            this.el.appendChild(this.createSeparator());
            this.el.appendChild(this.createHint('Groups the selected shapes so you can paint inside them'));
        } else {
            this.el.appendChild(this.createHint('Select shapes and click Live Paint to make a group, then fill its regions'));
        }
    }

    /** One Rect/Ellipse/Path selected. */
    private renderSingleShape(info: ContextInfo) {
        this.appendSelectionBadge(info);

        this.el.appendChild(this.createButton('Edit Path', iconPencil(14), () => {
            if (info.selectedIds.length === 1) {
                this.ui.setActiveTool('direct');
                this.input.enterPathEditMode(info.selectedIds[0]);
            }
        }, false, '⏎'));

        this.appendTransformActions(info, { flatten: true });
        this.appendLifecycleActions();
    }

    /** One Text node selected: text actions, not text properties (those are in the panel). */
    private renderTextSelected(info: ContextInfo) {
        this.appendSelectionBadge(info);

        const nodeId = info.selectedIds[0];

        this.el.appendChild(this.createButton('Edit Text', iconPencil(14), () => {
            this.input.editTextNode(nodeId);
        }, false, '⏎'));

        this.el.appendChild(this.createButton('Create Outlines', iconCreateOutlines(14), () => {
            void this.input.createOutlines(nodeId);
        }, false, '⌘⇧O'));

        this.appendTransformActions(info, { flatten: false });
        this.appendLifecycleActions();
    }

    /** Exactly one Group selected. */
    private renderGroupSelected(info: ContextInfo) {
        this.appendSelectionBadge(info);

        this.el.appendChild(this.createButton('Enter Group', iconCornerDownRight(14), () => {
            if (info.selectedIds.length === 1) {
                this.input.enterSelectedNode(info.selectedIds[0]);
            }
        }, false, '⏎'));

        this.el.appendChild(this.createButton('Ungroup', iconUngroup(14), () => {
            this.input.ungroupSelection();
        }, false, '⌘⇧G'));

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
            this.el.appendChild(this.createIconButton(title, icon, () => {
                alignSelection(this.scene, [...info.selectedIds], mode);
                this.ui.syncWithSelection();
            }));
        }
        if (info.selectedIds.length >= 3) {
            this.el.appendChild(this.createIconButton('Distribute horizontally', iconDistributeH(14), () => {
                distributeSelection(this.scene, [...info.selectedIds], 'h');
                this.ui.syncWithSelection();
            }));
            this.el.appendChild(this.createIconButton('Distribute vertically', iconDistributeV(14), () => {
                distributeSelection(this.scene, [...info.selectedIds], 'v');
                this.ui.syncWithSelection();
            }));
        }

        // Boolean operations — only when every selected node is combinable geometry
        const allBoolCompatible = info.selectedNodes.length === info.selectedIds.length
            && info.selectedNodes.every(n => BOOLEAN_COMPATIBLE.has(n.node_type));
        if (allBoolCompatible) {
            this.el.appendChild(this.createSeparator());
            const boolActions: Array<[string, string, BoolOp]> = [
                ['Union', iconBoolUnion(14), 'union'],
                ['Subtract', iconBoolSubtract(14), 'subtract'],
                ['Intersect', iconBoolIntersect(14), 'intersect'],
                ['Exclude', iconBoolExclude(14), 'exclude'],
            ];
            for (const [title, icon, op] of boolActions) {
                this.el.appendChild(this.createIconButton(title, icon, () => {
                    const newId = applyBooleanOp(this.ui.ck, this.scene, [...info.selectedIds], op);
                    if (newId !== null) {
                        this.ui.syncWithSelection();
                        this.ui.updateLayerList();
                    }
                }));
            }
        }

        this.el.appendChild(this.createSeparator());

        // Join Paths — only when exactly two Path nodes are selected
        const twoPaths = info.selectedIds.length === 2
            && info.selectedNodes.length === 2
            && info.selectedNodes.every(n => n.node_type === 'Path');
        if (twoPaths) {
            this.el.appendChild(this.createButton('Join', iconLink(14), () => {
                this.input.joinSelectedPaths();
            }, false, '⌘J'));
        }

        this.el.appendChild(this.createButton('Group', iconGroup(14), () => {
            this.input.groupSelection();
        }, false, '⌘G'));

        this.appendTransformActions(info, { flatten: false });
        this.appendLifecycleActions();
    }

    /** Pen tool with a path in progress: progress + commit/cancel. */
    private renderPenDrawing(info: ContextInfo) {
        this.el.appendChild(this.createBadge(`${info.pointCount} pts`));
        this.el.appendChild(this.createSeparator());

        this.el.appendChild(this.createHint(
            'Click to add points · drag for curves · Enter to finish · Esc to cancel · click first point to close'
        ));

        this.el.appendChild(this.createSeparator());

        this.el.appendChild(this.createButton('Finish', '✓', () => {
            this.input.finalizePenPath();
        }, false, '⏎'));

        this.el.appendChild(this.createButton('Cancel', '✕', () => {
            this.input.currentPathPoints = [];
            this.refresh();
        }, true, '⎋'));
    }

    /** Node-editing mode: point counts + point actions + exit. */
    private renderPathEditing(info: ContextInfo) {
        const countText = info.selectedPointCount > 0
            ? `${info.selectedPointCount} / ${info.pointCount} points`
            : `${info.pointCount} points`;
        this.el.appendChild(this.createBadge(countText));

        this.el.appendChild(this.createSeparator());

        // Add Point (toggles; highlighted while armed)
        const addBtn = this.createIconButton('Add Point', iconPlusCircle(14), () => {
            this.input.addPointMode = !this.input.addPointMode;
            this.refresh();
        }, '+');
        if (this.input.addPointMode) addBtn.classList.add('cb-btn-active');
        this.el.appendChild(addBtn);

        // Delete Point (needs a selection)
        const delBtn = this.createIconButton('Delete Point', iconMinusCircle(14), () => {
            this.input.deleteSelectedPoints();
        }, '⌫');
        if (info.selectedPointCount === 0) delBtn.setAttribute('disabled', '');
        this.el.appendChild(delBtn);

        // Cut at the selected anchor (scissors with zero aiming — the point is
        // already selected). Only offered for exactly one anchor.
        if (info.selectedPointCount === 1) {
            this.el.appendChild(this.createButton('Cut at Point', iconScissors(14), () => {
                this.input.cutAtSelectedPoint();
            }));
        }

        // Merge selected points into one (endpoints weld/close, adjacent collapse)
        if (info.selectedPointCount >= 2) {
            this.el.appendChild(this.createButton('Merge', iconLink(14), () => {
                this.input.mergeSelectedPoints();
            }, false, '⌘J'));
        }

        this.el.appendChild(this.createSeparator());

        // Hint tracks what the NEXT click will do
        let hint = 'Drag points · ⇧click or marquee to multi-select · Esc to finish';
        if (this.input.addPointMode) hint = 'Click a segment to insert a point';
        else if (info.selectedPointCount === 1) hint = 'Cut splits the path at the selected point';
        else if (info.selectedPointCount >= 2) hint = '⌘J merges the selected points';
        this.el.appendChild(this.createHint(hint));

        this.el.appendChild(this.createSeparator());

        // Done (exit edit mode) — the committing action is always last
        this.el.appendChild(this.createButton('Done', '✓', () => {
            this.input.exitEditMode();
            this.ui.setActiveTool('selection');
        }, false, '⏎'));
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

        this.el.appendChild(this.createIconButton('Flip Horizontal', iconFlipH(), () => {
            this.input.flipSelection('h');
        }, '⇧H'));
        this.el.appendChild(this.createIconButton('Flip Vertical', iconFlipV(), () => {
            this.input.flipSelection('v');
        }, '⇧V'));
        if (opts.flatten) {
            this.el.appendChild(this.createIconButton('Flatten', iconFlatten(), () => {
                this.input.flattenSelection();
            }, '⌘E'));
        }
    }

    /** Trailing Duplicate · Delete — identical in every selection state. */
    private appendLifecycleActions() {
        this.el.appendChild(this.createSeparator());

        this.el.appendChild(this.createButton('Duplicate', iconCopy(14), () => {
            this.input.duplicateSelection();
        }, false, '⌘D'));

        this.el.appendChild(this.createButton('Delete', iconTrash(14), () => {
            this.input.deleteSelection();
        }, true, '⌫'));
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

        const swatch = document.createElement('input');
        swatch.type = 'color';
        swatch.className = 'cb-swatch';
        swatch.value = currentValue;
        swatch.addEventListener('input', () => onChange(swatch.value));
        swatch.addEventListener('change', () => onChange(swatch.value));

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

    /** Compact icon-only button (align/boolean/flip rows). The label lives in
     *  the tooltip, with the shortcut appended when the action has one. */
    private createIconButton(title: string, icon: string, onClick: () => void, shortcut?: string): HTMLElement {
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
