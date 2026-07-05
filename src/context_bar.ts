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
import { iconUndo, iconRedo, iconPencil, iconTrash } from './icons';

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

        this.render(info);
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
        // Breadcrumb
        if (info.breadcrumb.length > 1) {
            this.el.appendChild(this.createBreadcrumb(info.breadcrumb));
            this.el.appendChild(this.createSeparator());
        }

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

        this.el.appendChild(this.createSeparator());

        // Edit Path
        this.el.appendChild(this.createButton('Edit Path', iconPencil(14), () => {
            if (info.selectedIds.length === 1) {
                this.ui.setActiveTool('direct');
                this.input.enterPathEditMode(info.selectedIds[0]);
            }
        }));

        // Duplicate
        this.el.appendChild(this.createButton('Duplicate', '⧉', () => {
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
            ['Align left', '⇤', 'left'],
            ['Align center', '⇹', 'hcenter'],
            ['Align right', '⇥', 'right'],
            ['Align top', '⤒', 'top'],
            ['Align middle', '⇳', 'vcenter'],
            ['Align bottom', '⤓', 'bottom'],
        ];
        for (const [title, icon, mode] of alignActions) {
            this.el.appendChild(this.createIconButton(title, icon, () => {
                alignSelection(this.scene, [...info.selectedIds], mode);
                this.ui.syncWithSelection();
            }));
        }
        if (info.selectedIds.length >= 3) {
            this.el.appendChild(this.createIconButton('Distribute horizontally', '⫴', () => {
                distributeSelection(this.scene, [...info.selectedIds], 'h');
                this.ui.syncWithSelection();
            }));
            this.el.appendChild(this.createIconButton('Distribute vertically', '⫶', () => {
                distributeSelection(this.scene, [...info.selectedIds], 'v');
                this.ui.syncWithSelection();
            }));
        }

        this.el.appendChild(this.createSeparator());

        // Boolean operations
        const boolActions: Array<[string, string, BoolOp]> = [
            ['Union', '⊕', 'union'],
            ['Subtract', '⊖', 'subtract'],
            ['Intersect', '⊗', 'intersect'],
            ['Exclude', '⊘', 'exclude'],
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

        this.el.appendChild(this.createSeparator());

        // Group
        this.el.appendChild(this.createButton('Group ⌘G', '⊞', () => {
            this.input.groupSelection();
        }));

        // Delete
        this.el.appendChild(this.createButton('Delete', iconTrash(14), () => {
            this.input.deleteSelection();
        }, true));
    }

    private renderGroupSelected(info: ContextInfo) {
        // Ungroup
        this.el.appendChild(this.createButton('Ungroup ⌘⇧G', '⊟', () => {
            this.input.ungroupSelection();
        }));

        // Enter Group
        this.el.appendChild(this.createButton('Enter Group', '↳', () => {
            if (info.selectedIds.length === 1) {
                const sceneData = this.scene.getSceneData();
                const groupNode = sceneData.nodes[info.selectedIds[0]];
                if (groupNode?.children && groupNode.children.length > 0) {
                    this.scene.selectNode(groupNode.children[0], false);
                    this.ui.syncWithSelection();
                    this.ui.updateLayerList();
                }
            }
        }));

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
        // Breadcrumb
        if (info.breadcrumb.length > 0) {
            this.el.appendChild(this.createBreadcrumb(info.breadcrumb));
            this.el.appendChild(this.createSeparator());
        }

        // Point count
        this.el.appendChild(this.createLabel(`${info.pointCount} points`, 'cb-point-count'));

        this.el.appendChild(this.createSeparator());

        // Done (exit edit mode)
        this.el.appendChild(this.createButton('Done', '✓', () => {
            this.input.editingNodeId = null;
            this.input.editingPoints = null;
            this.input.editingTransform = null;
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

    private createBreadcrumb(crumbs: string[]): HTMLElement {
        const bc = document.createElement('span');
        bc.className = 'cb-breadcrumb';
        bc.textContent = crumbs.join(' › ');
        return bc;
    }

    /** Compact icon-only button (align/boolean rows). */
    private createIconButton(title: string, icon: string, onClick: () => void): HTMLElement {
        const btn = document.createElement('button');
        btn.className = 'cb-btn cb-btn-icon-only';
        btn.title = title;
        btn.textContent = icon;
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
