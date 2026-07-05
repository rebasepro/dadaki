/**
 * Floating contextual action bar — Figma-style bottom bar that changes content
 * based on the current editor context (selection, tool, editing mode).
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
import { addAnchorPoint, deleteAnchorPoint, findNearestSegment, joinSubpaths, type SegmentHitResult } from './path_ops';
import { outlineStroke } from './outline_stroke';
import {
    iconUndo, iconRedo, iconPencil, iconTrash, iconCopy,
    iconAlignLeft, iconAlignCenterH, iconAlignRight,
    iconAlignTop, iconAlignCenterV, iconAlignBottom,
    iconDistributeH, iconDistributeV,
    iconBoolUnion, iconBoolSubtract, iconBoolIntersect, iconBoolExclude,
    iconGroup, iconUngroup, iconCornerDownRight,
    iconPlusCircle, iconMinusCircle, iconScissors, iconLink, iconBoxSelect,
    iconFlipH, iconFlipV, iconFlatten,
    iconTextAlignLeft, iconTextAlignCenter, iconTextAlignRight,
    iconCreateOutlines,
} from './icons';

/** Tool-specific hint text for shape-tool and text-tool contexts. */
const TOOL_HINTS: Record<string, string> = {
    rect: 'Drag to draw a rectangle — Shift: square, Alt: from center',
    ellipse: 'Drag to draw an ellipse — Shift: circle, Alt: from center',
    polygon: 'Drag to draw a polygon — Shift: constrain',
    star: 'Drag to draw a star — Shift: constrain',
    pen: 'Click to place the first point of a path',
    text: 'Click on the canvas to place text',
};

export class ContextBar {
    private el: HTMLDivElement;
    private canvasContainer: HTMLElement;
    private ui: UIEngine;
    private input: InputManager;
    private scene: WasmScene;
    private renderer: Renderer;

    /** Cache key for the last render — avoids redundant DOM rebuilds. */
    private _lastSignature: string = '';

    constructor(
        canvasContainer: HTMLElement,
        ui: UIEngine,
        input: InputManager,
        scene: WasmScene,
        renderer: Renderer,
    ) {
        this.canvasContainer = canvasContainer;
        this.ui = ui;
        this.input = input;
        this.scene = scene;
        this.renderer = renderer;

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
        // Include values that the various render* methods read from the UI inputs
        let textSig = '';
        if (info.primaryNodeType === 'Text' && info.selectedIds.length === 1) {
            const geo = this.scene.getNodeGeometry(info.selectedIds[0])?.Text;
            if (geo) textSig = `|ff:${geo.font_family}|ta:${geo.text_align}|lh:${geo.line_height}|fs:${geo.font_size}`;
        }
        return `${info.context}|${info.selectedIds.join(',')}|${info.pointCount}|${info.primaryNodeType}|${this.ui.fillInput.value}|${this.ui.strokeInput.value}|${this.ui.opacityInput.value}|${this.ui.cornerRadius?.value ?? ''}|${Math.round(this.renderer.zoom * 100)}${textSig}`;
    }

    /** Rebuild the bar DOM based on context info. */
    private render(info: ContextInfo) {
        this.el.innerHTML = '';

        switch (info.context) {
            case 'empty':
                this.renderEmpty();
                break;
            case 'single-shape':
                this.renderSingleShape(info);
                break;
            case 'multi-select':
                this.renderMultiSelect(info);
                break;
            case 'group-selected':
                this.renderGroupSelected(info);
                break;
            case 'pen-drawing':
                this.renderPenDrawing(info);
                break;
            case 'path-editing':
                this.renderPathEditing(info);
                break;
            case 'shape-tool':
                this.renderShapeTool();
                break;
            case 'text-tool':
                this.renderTextTool();
                break;
        }
    }

    // ─── Context Renderers ──────────────────────────────────────────

    private renderEmpty() {
        // Fill swatch (default style)
        this.el.appendChild(this.createColorSwatch('fill', this.ui.fillInput.value, (color) => {
            this.ui.fillInput.value = color;
            this.ui.fillInput.dispatchEvent(new Event('input', { bubbles: true }));
            this.ui.fillInput.dispatchEvent(new Event('change', { bubbles: true }));
        }));

        // Stroke swatch (default style)
        this.el.appendChild(this.createColorSwatch('stroke', this.ui.strokeInput.value, (color) => {
            this.ui.strokeInput.value = color;
            this.ui.strokeInput.dispatchEvent(new Event('input', { bubbles: true }));
            this.ui.strokeInput.dispatchEvent(new Event('change', { bubbles: true }));
        }));

        this.el.appendChild(this.createSeparator());

        // Zoom %
        const zoomPct = Math.round(this.renderer.zoom * 100);
        this.el.appendChild(this.createLabel(`${zoomPct}%`, 'cb-zoom'));

        this.el.appendChild(this.createSeparator());

        // Undo / Redo
        this.el.appendChild(this.createButton('Undo', iconUndo(14), () => {
            this.scene.undo();
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
        }));
        this.el.appendChild(this.createButton('Redo', iconRedo(14), () => {
            this.scene.redo();
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
        }));
    }

    private renderSingleShape(info: ContextInfo) {
        // Fill swatch
        this.el.appendChild(this.createColorSwatch('fill', this.ui.fillInput.value, (color) => {
            this.ui.fillInput.value = color;
            this.ui.fillInput.dispatchEvent(new Event('input', { bubbles: true }));
            this.ui.fillInput.dispatchEvent(new Event('change', { bubbles: true }));
        }));

        // Stroke swatch
        this.el.appendChild(this.createColorSwatch('stroke', this.ui.strokeInput.value, (color) => {
            this.ui.strokeInput.value = color;
            this.ui.strokeInput.dispatchEvent(new Event('input', { bubbles: true }));
            this.ui.strokeInput.dispatchEvent(new Event('change', { bubbles: true }));
        }));

        this.el.appendChild(this.createSeparator());

        // Opacity input
        this.el.appendChild(this.createNumberInput('Opacity', this.ui.opacityInput.value, '%', (val) => {
            this.ui.opacityInput.value = val;
            this.ui.opacityInput.dispatchEvent(new Event('input', { bubbles: true }));
            this.ui.opacityInput.dispatchEvent(new Event('change', { bubbles: true }));
        }));

        // Corner radius for Rect
        if (info.primaryNodeType === 'Rect') {
            this.el.appendChild(this.createNumberInput('Radius', this.ui.cornerRadius.value, 'px', (val) => {
                this.ui.cornerRadius.value = val;
                this.ui.cornerRadius.dispatchEvent(new Event('input', { bubbles: true }));
                this.ui.cornerRadius.dispatchEvent(new Event('change', { bubbles: true }));
            }));
        }

        // ── Text-specific controls ──────────────────────────────
        if (info.primaryNodeType === 'Text' && info.selectedIds.length === 1) {
            const nodeId = info.selectedIds[0];
            const geo = this.scene.getNodeGeometry(nodeId);
            const textGeo = geo?.Text;
            const currentAlign = textGeo?.text_align ?? 0;
            const currentLineHeight = textGeo?.line_height ?? 1.2;
            const currentFontFamily = textGeo?.font_family ?? '';
            const currentFontSize = textGeo?.font_size ?? 32;

            this.el.appendChild(this.createSeparator());

            // Font picker
            this.el.appendChild(this.createFontPicker(currentFontFamily, (fontFamily) => {
                this.scene.setTextProperties(nodeId, fontFamily, currentAlign, currentLineHeight);
                this.ui.syncWithSelection();
            }));

            // Font size
            this.el.appendChild(this.createNumberInput('Size', String(currentFontSize), 'px', (val) => {
                const newSize = parseFloat(val) || 32;
                this.scene.setTextContent(nodeId, textGeo?.content ?? '', newSize);
                this.ui.syncWithSelection();
            }));

            this.el.appendChild(this.createSeparator());

            // Text alignment buttons
            const alignModes: Array<[string, string, number]> = [
                ['Align left', iconTextAlignLeft(14), 0],
                ['Align center', iconTextAlignCenter(14), 1],
                ['Align right', iconTextAlignRight(14), 2],
            ];
            for (const [title, icon, align] of alignModes) {
                const btn = this.createIconButton(title, icon, () => {
                    const latestGeo = this.scene.getNodeGeometry(nodeId)?.Text;
                    this.scene.setTextProperties(
                        nodeId,
                        latestGeo?.font_family ?? '',
                        align,
                        latestGeo?.line_height ?? 1.2,
                    );
                    this.ui.syncWithSelection();
                });
                if (align === currentAlign) btn.classList.add('cb-btn-active');
                this.el.appendChild(btn);
            }

            // Line height
            this.el.appendChild(this.createNumberInput('Line H', currentLineHeight.toFixed(1), '×', (val) => {
                const newLH = parseFloat(val) || 1.2;
                const latestGeo = this.scene.getNodeGeometry(nodeId)?.Text;
                this.scene.setTextProperties(
                    nodeId,
                    latestGeo?.font_family ?? '',
                    latestGeo?.text_align ?? 0,
                    newLH,
                );
                this.ui.syncWithSelection();
            }));

            this.el.appendChild(this.createSeparator());

            // Create Outlines button
            this.el.appendChild(this.createButton('Create Outlines', iconCreateOutlines(14), () => {
                document.dispatchEvent(new CustomEvent('create-outlines', { detail: { nodeId } }));
            }));
        }
        // ── End text-specific controls ──────────────────────────

        this.el.appendChild(this.createSeparator());

        // Edit Path (not for text)
        if (info.primaryNodeType !== 'Text') {
            this.el.appendChild(this.createButton('Edit Path', iconPencil(14), () => {
                if (info.selectedIds.length === 1) {
                    this.ui.setActiveTool('direct');
                    this.input.enterPathEditMode(info.selectedIds[0]);
                }
            }));
        }

        // Flip & Flatten
        this.el.appendChild(this.createSeparator());
        this.el.appendChild(this.createIconButton('Flip Horizontal', iconFlipH(), () => {
            for (const nid of info.selectedIds) {
                this.scene.flipNodeH(nid);
            }
            this.scene.invalidateCache();
            this.ui.syncWithSelection();
        }));
        this.el.appendChild(this.createIconButton('Flip Vertical', iconFlipV(), () => {
            for (const nid of info.selectedIds) {
                this.scene.flipNodeV(nid);
            }
            this.scene.invalidateCache();
            this.ui.syncWithSelection();
        }));
        if (info.selectedIds.length === 1 && this.scene.engine!.has_non_identity_linear(info.selectedIds[0])) {
            this.el.appendChild(this.createButton('Flatten', iconFlatten(), () => {
                this.scene.flattenTransform(info.selectedIds[0]);
                this.scene.invalidateCache();
                this.ui.syncWithSelection();
            }));
        }

        // Outline Stroke (only if node has a stroke)
        const style = this.scene.getNodeStyle(info.selectedIds[0]);
        if (style && style.stroke !== null && style.stroke_width > 0) {
            this.el.appendChild(this.createButton('Outline Stroke', iconBoxSelect(14), () => {
                outlineStroke(this.ui.ck, this.scene, info.selectedIds[0]);
                this.ui.syncWithSelection();
                this.ui.updateLayerList();
            }));
        }

        // Duplicate
        this.el.appendChild(this.createButton('Duplicate', iconCopy(14), () => {
            this.input.duplicateSelection();
        }));

        // Delete
        this.el.appendChild(this.createButton('Delete', iconTrash(14), () => {
            this.input.deleteSelection();
        }, true));
    }

    private renderMultiSelect(info: ContextInfo) {
        // Count badge
        this.el.appendChild(this.createBadge(`${info.selectedIds.length} selected`));

        this.el.appendChild(this.createSeparator());

        // Shared fill swatch
        this.el.appendChild(this.createColorSwatch('fill', this.ui.fillInput.value, (color) => {
            this.ui.fillInput.value = color;
            this.ui.fillInput.dispatchEvent(new Event('input', { bubbles: true }));
            this.ui.fillInput.dispatchEvent(new Event('change', { bubbles: true }));
        }));

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

        this.el.appendChild(this.createSeparator());

        // Boolean operations
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

        // Flip
        this.el.appendChild(this.createSeparator());
        this.el.appendChild(this.createIconButton('Flip Horizontal', iconFlipH(), () => {
            for (const nid of info.selectedIds) {
                this.scene.flipNodeH(nid);
            }
            this.scene.invalidateCache();
            this.ui.syncWithSelection();
        }));
        this.el.appendChild(this.createIconButton('Flip Vertical', iconFlipV(), () => {
            for (const nid of info.selectedIds) {
                this.scene.flipNodeV(nid);
            }
            this.scene.invalidateCache();
            this.ui.syncWithSelection();
        }));

        this.el.appendChild(this.createSeparator());

        // Join Paths (show when exactly 2 path nodes are selected)
        if (info.selectedIds.length === 2) {
            this.el.appendChild(this.createIconButton('Join Paths ⌘J', iconLink(14), () => {
                this.input.joinSelectedPaths();
            }));

            this.el.appendChild(this.createSeparator());
        }

        // Group
        this.el.appendChild(this.createButton('Group ⌘G', iconGroup(14), () => {
            this.input.groupSelection();
        }));

        // Delete
        this.el.appendChild(this.createButton('Delete', iconTrash(14), () => {
            this.input.deleteSelection();
        }, true));
    }

    private renderGroupSelected(info: ContextInfo) {
        // Ungroup
        this.el.appendChild(this.createButton('Ungroup ⌘⇧G', iconUngroup(14), () => {
            this.input.ungroupSelection();
        }));

        // Enter Group
        this.el.appendChild(this.createButton('Enter Group', iconCornerDownRight(14), () => {
            if (info.selectedIds.length === 1) {
                const children = Array.from(this.scene.getNodeChildren(info.selectedIds[0]));
                if (children.length > 0) {
                    this.scene.selectNode(children[0], false);
                    this.ui.syncWithSelection();
                    this.ui.updateLayerList();
                }
            }
        }));

        // Flip & Flatten
        this.el.appendChild(this.createSeparator());
        this.el.appendChild(this.createIconButton('Flip Horizontal', iconFlipH(), () => {
            for (const nid of info.selectedIds) {
                this.scene.flipNodeH(nid);
            }
            this.scene.invalidateCache();
            this.ui.syncWithSelection();
        }));
        this.el.appendChild(this.createIconButton('Flip Vertical', iconFlipV(), () => {
            for (const nid of info.selectedIds) {
                this.scene.flipNodeV(nid);
            }
            this.scene.invalidateCache();
            this.ui.syncWithSelection();
        }));
        if (info.selectedIds.length === 1 && this.scene.engine!.has_non_identity_linear(info.selectedIds[0])) {
            this.el.appendChild(this.createButton('Flatten', iconFlatten(), () => {
                this.scene.flattenTransform(info.selectedIds[0]);
                this.scene.invalidateCache();
                this.ui.syncWithSelection();
            }));
        }

        this.el.appendChild(this.createSeparator());

        // Fill swatch (applying to descendants)
        this.el.appendChild(this.createColorSwatch('fill', this.ui.fillInput.value, (color) => {
            this.ui.fillInput.value = color;
            this.ui.fillInput.dispatchEvent(new Event('input', { bubbles: true }));
            this.ui.fillInput.dispatchEvent(new Event('change', { bubbles: true }));
        }));
    }

    private renderPenDrawing(info: ContextInfo) {
        // Hint text
        const hint = this.createHint(
            'Click to add points · drag for curves · Enter to finish · Esc to cancel · click first point to close'
        );
        this.el.appendChild(hint);

        this.el.appendChild(this.createSeparator());

        // Point count
        this.el.appendChild(this.createLabel(`${info.pointCount} pts`, 'cb-point-count'));

        this.el.appendChild(this.createSeparator());

        // Finish
        this.el.appendChild(this.createButton('Finish', '✓', () => {
            this.input.finalizePenPath();
        }));

        // Cancel
        this.el.appendChild(this.createButton('Cancel', '✕', () => {
            this.input.currentPathPoints = [];
            this.refresh();
        }, true));
    }

    private renderPathEditing(info: ContextInfo) {
        // Point count
        this.el.appendChild(this.createLabel(`${info.pointCount} points`, 'cb-point-count'));

        this.el.appendChild(this.createSeparator());

        // Add Point
        this.el.appendChild(this.createIconButton('Add Point (+)', iconPlusCircle(14), () => {
            this.input.addPointMode = true;
            this.refresh();
        }));

        // Delete Point
        this.el.appendChild(this.createIconButton('Delete Point (−)', iconMinusCircle(14), () => {
            this.input.deleteSelectedPoint();
        }));

        this.el.appendChild(this.createSeparator());

        // Done (exit edit mode)
        this.el.appendChild(this.createButton('Done', '✓', () => {
            this.input.editingNodeId = null;
            this.input.editingPoints = null;
            this.input.editingTransform = null;
            this.input.addPointMode = false;
            this.ui.setActiveTool('selection');
        }));
    }

    private renderShapeTool() {
        const tool = this.ui.activeTool;
        const hintText = TOOL_HINTS[tool] || `Drag to draw a ${tool}`;
        this.el.appendChild(this.createHint(hintText));
    }

    private renderTextTool() {
        this.el.appendChild(this.createHint(TOOL_HINTS['text'] || 'Click on the canvas to place text'));
    }

    // ─── DOM Helpers ────────────────────────────────────────────────

    private createColorSwatch(
        label: string,
        currentValue: string,
        onChange: (color: string) => void,
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cb-swatch-wrapper';
        wrapper.title = label;

        const swatch = document.createElement('input');
        swatch.type = 'color';
        swatch.className = 'cb-swatch';
        swatch.value = currentValue;
        swatch.addEventListener('input', () => onChange(swatch.value));
        swatch.addEventListener('change', () => onChange(swatch.value));

        wrapper.appendChild(swatch);
        return wrapper;
    }

    private createSeparator(): HTMLElement {
        const sep = document.createElement('div');
        sep.className = 'cb-separator';
        return sep;
    }

    private createLabel(text: string, className?: string): HTMLElement {
        const label = document.createElement('span');
        label.className = `cb-label${className ? ` ${className}` : ''}`;
        label.textContent = text;
        return label;
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


    private createFontPicker(
        currentFont: string,
        onChange: (font: string) => void,
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cb-font-picker';
        wrapper.title = 'Font Family';

        const select = document.createElement('select');
        select.className = 'cb-font-select';

        const fonts = [
            '', // System default
            'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito',
            'Playfair Display', 'Merriweather', 'Lora', 'PT Serif',
            'JetBrains Mono', 'Fira Code', 'Source Code Pro',
            'Bebas Neue', 'Oswald', 'Raleway',
        ];
        for (const f of fonts) {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f || '(Default)';
            if (f === currentFont) opt.selected = true;
            select.appendChild(opt);
        }

        select.addEventListener('change', () => onChange(select.value));
        wrapper.appendChild(select);
        return wrapper;
    }

    /** Compact icon-only button (align/boolean rows). */
    private createIconButton(title: string, icon: string, onClick: () => void): HTMLElement {
        const btn = document.createElement('button');
        btn.className = 'cb-btn cb-btn-icon-only';
        btn.title = title;
        btn.innerHTML = icon;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    private createButton(
        title: string,
        icon: string,
        onClick: () => void,
        danger = false,
    ): HTMLElement {
        const btn = document.createElement('button');
        btn.className = `cb-btn${danger ? ' cb-btn-danger' : ''}`;
        btn.title = title;
        btn.innerHTML = `<span class="cb-btn-icon">${icon}</span><span class="cb-btn-text">${title}</span>`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    private createNumberInput(
        label: string,
        currentValue: string,
        suffix: string,
        onChange: (val: string) => void,
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cb-number-wrapper';
        wrapper.title = label;

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'cb-number-input';
        input.value = currentValue;
        input.min = '0';
        input.max = label === 'Opacity' ? '100' : '999';

        const suffixEl = document.createElement('span');
        suffixEl.className = 'cb-number-suffix';
        suffixEl.textContent = suffix;

        input.addEventListener('change', () => onChange(input.value));
        input.addEventListener('input', () => onChange(input.value));

        wrapper.appendChild(input);
        wrapper.appendChild(suffixEl);
        return wrapper;
    }
}
