/**
 * Context model for the floating contextual action bar.
 * Determines the current editor state and provides metadata for the bar UI.
 */

import type { UIEngine } from './ui';
import type { InputManager } from './input';
import type { WasmScene } from './wasm_scene';

/** Possible editor contexts that drive the action bar content. */
export type EditorContext =
    | 'empty'           // nothing selected, selection tool
    | 'single-shape'    // one shape selected (Rect/Ellipse/Path/Text)
    | 'multi-select'    // 2+ nodes selected
    | 'group-selected'  // exactly one Group node selected
    | 'path-editing'    // input.editingNodeId != null
    | 'pen-drawing'     // input.currentPathPoints.length > 0
    | 'shape-tool'      // rect/ellipse/polygon/star/pen active, nothing in progress
    | 'text-tool';      // text tool active

/** Selected node summary for the bar. */
export interface SelectedNodeInfo {
    id: number;
    name: string;
    node_type: string;
}

/** A single breadcrumb segment with metadata for clickable navigation. */
export interface BreadcrumbItem {
    id: number;
    name: string;
    nodeType: string;
}

/** Full context info passed to the bar for rendering. */
export interface ContextInfo {
    context: EditorContext;
    selectedIds: number[];
    selectedNodes: SelectedNodeInfo[];
    /** Breadcrumb trail for nested selection — each item has an id for navigation. */
    breadcrumb: BreadcrumbItem[];
    editingNodeId: number | null;
    /** Path point count — for editing (editingPoints) or pen-drawing (currentPathPoints) */
    pointCount: number;
    /** The first selected node's type (for context-specific controls like corner radius) */
    primaryNodeType: string | null;
}

const SHAPE_TOOLS = new Set(['rect', 'ellipse', 'polygon', 'star', 'pen']);

/**
 * Compute the current editor context from the live state of ui, input, and scene.
 * Priority-ordered detection ensures unambiguous context.
 */
export function getEditorContext(ui: UIEngine, input: InputManager, scene: WasmScene): ContextInfo {
    const selection = scene.engine!.get_selection();
    const selectedIds = Array.from(selection);

    // Build selected node info
    const selectedNodes: SelectedNodeInfo[] = selectedIds
        .map(id => {
            const node = scene.getNode(id);
            if (!node) return null;
            return { id, name: node.name, node_type: node.node_type };
        })
        .filter((n): n is SelectedNodeInfo => n !== null);

    // Compute breadcrumb for primary selection
    const breadcrumb = selectedIds.length > 0
        ? buildBreadcrumb(selectedIds[0], scene)
        : [];

    const editingNodeId = input.editingNodeId;
    const activeTool = ui.activeTool;

    // Point count: editing mode uses editingPoints, pen mode uses currentPathPoints
    let pointCount = 0;
    if (editingNodeId !== null && input.editingPoints) {
        pointCount = input.editingPoints.length;
    } else if (input.currentPathPoints.length > 0) {
        pointCount = input.currentPathPoints.length;
    }

    const primaryNodeType = selectedNodes.length > 0 ? selectedNodes[0].node_type : null;

    // Priority-ordered context detection
    let context: EditorContext;

    if (editingNodeId !== null) {
        context = 'path-editing';
    } else if (input.currentPathPoints.length > 0) {
        context = 'pen-drawing';
    } else if (activeTool === 'text') {
        context = 'text-tool';
    } else if (SHAPE_TOOLS.has(activeTool) && selectedIds.length === 0) {
        context = 'shape-tool';
    } else if (selectedIds.length === 1 && primaryNodeType === 'Group') {
        context = 'group-selected';
    } else if (selectedIds.length === 1) {
        context = 'single-shape';
    } else if (selectedIds.length > 1) {
        context = 'multi-select';
    } else {
        context = 'empty';
    }

    return {
        context,
        selectedIds,
        selectedNodes,
        breadcrumb,
        editingNodeId,
        pointCount,
        primaryNodeType,
    };
}

/**
 * Build a breadcrumb trail from a node up to the root.
 * Returns e.g. [{id: 2, name: "Group 2", nodeType: "Group"}, {id: 5, name: "Rect 5", nodeType: "Rect"}]
 * — ancestors first, leaf last.
 */
function buildBreadcrumb(nodeId: number, scene: WasmScene): BreadcrumbItem[] {
    const crumbs: BreadcrumbItem[] = [];
    let currentId = nodeId;
    const visited = new Set<number>(); // safety guard against cycles

    while (!visited.has(currentId)) {
        visited.add(currentId);
        const node = scene.getNode(currentId);
        if (!node) break;
        crumbs.unshift({
            id: currentId,
            name: node.name || `${node.node_type} ${currentId}`,
            nodeType: node.node_type,
        });

        const parentId = scene.getNodeParent(currentId);
        if (parentId < 0) break; // root reached
        currentId = parentId;
    }

    return crumbs;
}
