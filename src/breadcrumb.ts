/**
 * Breadcrumb navigation bar — replaces the static header title with a
 * clickable breadcrumb showing the current editing context hierarchy.
 *
 * Displays: Canvas › [Group] › [Shape] › [Editing Points]
 * Each segment (except the last) is clickable to navigate back.
 */

import type { UIEngine } from './ui';
import type { InputManager } from './input';
import type { WasmScene } from './wasm_scene';
import type { Renderer } from './renderer';
import { getEditorContext } from './context';
import type { ContextInfo } from './context';
import { iconHome, iconChevronRight, iconFolder, iconSquare, iconCircle, iconPenTool, iconType, iconHexagon, iconCircleDot } from './icons';

/** Map node types to their icon functions. */
const NODE_ICON_MAP: Record<string, (size: number) => string> = {
    'Group': iconFolder,
    'Rect': iconSquare,
    'Ellipse': iconCircle,
    'Path': iconPenTool,
    'Text': iconType,
};

export class BreadcrumbBar {
    private el: HTMLElement;
    private ui: UIEngine;
    private input: InputManager;
    private scene: WasmScene;

    /** Cache key for the last render — avoids redundant DOM rebuilds. */
    private _lastSignature: string = '';

    constructor(
        headerEl: HTMLElement,
        ui: UIEngine,
        input: InputManager,
        scene: WasmScene,
        _renderer: Renderer,
    ) {
        this.ui = ui;
        this.input = input;
        this.scene = scene;

        // Use the existing breadcrumb container from the HTML, or create one
        const existing = headerEl.querySelector('#breadcrumb-bar');
        if (existing) {
            this.el = existing as HTMLElement;
        } else {
            this.el = document.createElement('div');
            this.el.id = 'breadcrumb-bar';
            this.el.className = 'breadcrumb-bar';
            headerEl.insertBefore(this.el, headerEl.firstChild);
        }

        this.refresh();
    }

    /** Recompute context and update the breadcrumb. */
    refresh() {
        const info = getEditorContext(this.ui, this.input, this.scene);

        // Build a signature from the state that drives the breadcrumb's DOM.
        // If nothing relevant changed, skip the expensive innerHTML rebuild.
        const sig = this.buildSignature(info);
        if (sig === this._lastSignature) return;
        this._lastSignature = sig;

        this.render(info);
    }

    /** Build a cache key that captures everything affecting the breadcrumb's rendered output. */
    private buildSignature(info: ContextInfo): string {
        const crumbSig = info.breadcrumb.map(c => `${c.id}:${c.name}:${c.nodeType}`).join('/');
        return `${info.context}|${crumbSig}|${info.selectedIds.length}|${info.pointCount}|${info.editingNodeId}`;
    }

    /** Rebuild the breadcrumb DOM based on context info. */
    private render(info: ContextInfo) {
        this.el.innerHTML = '';

        // 1. Home / Canvas item — always present
        this.addItem({
            icon: iconHome(13),
            label: 'Canvas',
            isActive: info.context === 'empty' || info.context === 'shape-tool' || info.context === 'text-tool' || info.context === 'pen-drawing',
            onClick: () => this.navigateToCanvas(),
        });

        // 2. Breadcrumb items from selection hierarchy
        const crumbs = info.breadcrumb;

        for (let i = 0; i < crumbs.length; i++) {
            const crumb = crumbs[i];
            const isLast = i === crumbs.length - 1;
            const isActive = isLast && info.context !== 'path-editing';

            // Add separator
            this.addSeparator();

            const iconFn = NODE_ICON_MAP[crumb.nodeType] || iconHexagon;

            this.addItem({
                icon: iconFn(12),
                label: crumb.name,
                isActive,
                onClick: isActive ? undefined : () => this.navigateToNode(crumb.id, info),
            });
        }

        // 3. If path-editing, add the "Editing Points" segment
        if (info.context === 'path-editing') {
            this.addSeparator();
            this.addItem({
                icon: iconCircleDot(12),
                label: `${info.pointCount} Points`,
                isActive: true,
            });
        }

        // 4. Multi-select badge
        if (info.context === 'multi-select') {
            this.addSeparator();
            this.addItem({
                label: `${info.selectedIds.length} selected`,
                isActive: true,
                isBadge: true,
            });
        }
    }

    // ─── Navigation Actions ─────────────────────────────────────────

    /** Navigate to root canvas — clear selection, exit all modes. */
    private navigateToCanvas() {
        // Exit path editing if active
        if (this.input.editingNodeId !== null) {
            this.input.editingNodeId = null;
            this.input.editingPoints = null;
            this.input.editingTransform = null;
        }
        // Cancel pen drawing
        if (this.input.currentPathPoints.length > 0) {
            this.input.currentPathPoints = [];
        }
        // Clear selection
        this.scene.engine!.clear_selection();
        this.ui.setActiveTool('selection');
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
    }

    /** Navigate to a specific node — select it, exit deeper contexts. */
    private navigateToNode(nodeId: number, _info: ContextInfo) {
        // Exit path editing if we're going higher
        if (this.input.editingNodeId !== null) {
            this.input.editingNodeId = null;
            this.input.editingPoints = null;
            this.input.editingTransform = null;
            this.ui.setActiveTool('selection');
        }
        // Select the target node
        this.scene.selectNode(nodeId, false);
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
    }

    // ─── DOM Helpers ────────────────────────────────────────────────

    private addItem(opts: {
        icon?: string;
        label: string;
        isActive?: boolean;
        isBadge?: boolean;
        onClick?: () => void;
    }) {
        const item = document.createElement('button');
        item.className = 'breadcrumb-item';

        if (opts.isActive) item.classList.add('active');
        if (opts.isBadge) item.classList.add('badge');
        if (!opts.onClick) item.classList.add('current');

        let html = '';
        if (opts.icon) {
            html += `<span class="breadcrumb-icon">${opts.icon}</span>`;
        }
        html += `<span class="breadcrumb-label">${opts.label}</span>`;
        item.innerHTML = html;

        if (opts.onClick) {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                opts.onClick!();
            });
        }

        this.el.appendChild(item);
    }

    private addSeparator() {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.innerHTML = iconChevronRight(10);
        this.el.appendChild(sep);
    }
}
