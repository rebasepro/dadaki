import { SmartPaint } from './smart_paint';
import { UIEngine } from './ui';
import { Renderer } from './renderer';
import type { WasmScene } from './wasm_scene';

export class InputManager {
    canvas: HTMLCanvasElement;
    scene: WasmScene;
    ui: UIEngine;
    renderer: Renderer;
    isMouseDown: boolean;
    startPos: { x: number; y: number };
    currentPos: { x: number; y: number };
    smartPaint: SmartPaint;
    dragMode: 'move' | 'marquee' | 'none' = 'none';
    /** Whether any actual movement happened during a drag. */
    didMove: boolean = false;
    /** Live preview rect in world coords, read by Renderer each frame. */
    previewRect: { x: number; y: number; w: number; h: number; tool: string } | null = null;
    /** Accumulated pen-tool anchor points for the current path being drawn. */
    currentPathPoints: Array<{x: number; y: number; cp1x: number; cp1y: number; cp2x: number; cp2y: number}> = [];
    isDraggingHandle: boolean = false;
    /** Marquee selection rect in world coords, read by Renderer each frame. */
    marqueeRect: { x: number; y: number; w: number; h: number } | null = null;
    clipboardIds: number[] = [];

    // --- Modifier key state (updated every mousemove) ---
    shiftKey: boolean = false;
    altKey: boolean = false;
    /** Whether Alt-clone has already duplicated during this drag. */
    cloneDragStarted: boolean = false;

    // --- Direct selection state ---
    /** Node being edited in direct selection mode. */
    editingNodeId: number | null = null;
    /** Local copy of path points for editing. Matches Rust PathPoint format: {x, y, cp1:[x,y], cp2:[x,y]} */
    editingPoints: Array<{x: number; y: number; cp1: number[]; cp2: number[]}> | null = null;
    /** Index of point being dragged. */
    draggingPointIndex: number = -1;
    /** Which part is being dragged: 'anchor', 'cp1', 'cp2', or null. */
    draggingHandleType: 'anchor' | 'cp1' | 'cp2' | null = null;
    /** Transform of the node being edited (for world<->local conversion). */
    editingTransform: Float32Array | null = null;

    // --- Resize handle state ---
    resizeHandleType: string | null = null; // 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', or null
    resizeStartBounds: { x: number; y: number; w: number; h: number } | null = null;
    resizeNodeId: number | null = null;
    /** Snapshot of the scene state before resize started, so we can restore and reapply cleanly. */
    resizeSnapshot: Uint8Array | null = null;

    constructor(canvas: HTMLCanvasElement, scene: WasmScene, ui: UIEngine, renderer: Renderer) {
        this.canvas = canvas;
        this.scene = scene;
        this.ui = ui;
        this.renderer = renderer;

        this.isMouseDown = false;
        this.startPos = { x: 0, y: 0 };
        this.currentPos = { x: 0, y: 0 };
        this.smartPaint = new SmartPaint(scene.ck, scene);

        this.init();
    }

    init() {
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
        window.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('mouseup', (e) => this.onMouseUp(e));
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
        window.addEventListener('wheel', (e) => this.onWheel(e), { passive: false, capture: true });
    }

    onDoubleClick(e: MouseEvent) {
        const pos = this.getPos(e);
        const hitId = this.scene.hitTest(pos.x, pos.y);
        if (hitId !== undefined) {
            // Double-click on a shape: enter direct edit mode
            this.ui.setActiveTool('direct');
            this.scene.selectNode(hitId, false);
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
            this.enterPathEditMode(hitId);
        }
    }

    /** Enter path edit mode on a node. Converts Rect/Ellipse to Path first if needed. */
    enterPathEditMode(nodeId: number) {
        // Convert non-path geometry to path
        const sceneData = this.scene.getSceneData();
        const node = sceneData.nodes[nodeId];
        if (!node) return;

        if (!node.geometry.Path) {
            // Convert rect/ellipse/etc. to editable path
            this.scene.convertToPath(nodeId);
        }

        // Re-read scene data after potential conversion
        const updatedData = this.scene.getSceneData();
        const updatedNode = updatedData.nodes[nodeId];
        if (updatedNode && updatedNode.geometry.Path) {
            this.editingNodeId = nodeId;
            this.editingPoints = JSON.parse(JSON.stringify(updatedNode.geometry.Path.points));
            this.editingTransform = this.scene.getTransform(nodeId);
            this.ui.updateLayerList();
        }
    }

    onKeyDown(e: KeyboardEvent) {
        // Don't handle shortcuts when typing in inputs
        if ((e.target as HTMLElement)?.tagName === 'INPUT') return;

        // Tool shortcuts
        if (!e.metaKey && !e.ctrlKey) {
            if (e.key === 'v' || e.key === 'V') this.ui.setActiveTool('selection');
            if (e.key === 'a' || e.key === 'A') this.ui.setActiveTool('direct');
            if (e.key === 'p' || e.key === 'P') this.ui.setActiveTool('pen');
            if (e.key === 'm' || e.key === 'M') this.ui.setActiveTool('rect');
            if (e.key === 'l' || e.key === 'L') this.ui.setActiveTool('ellipse');
            if (e.key === 'k' || e.key === 'K') this.ui.setActiveTool('smart-paint');
            if (e.key === 't' || e.key === 'T') this.ui.setActiveTool('text');
        }

        // Delete
        if (e.key === 'Backspace' || e.key === 'Delete') {
            const selection = this.scene.engine!.get_selection();
            if (selection.length > 0) {
                this.scene.engine!.clear_selection();
                for (const id of selection) {
                    this.scene.engine!.remove_node(id);
                }
                this.ui.updateLayerList();
                this.ui.syncWithSelection();
            }
        }

        // Undo: Cmd+Z / Ctrl+Z
        if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            this.scene.undo();
            this.ui.updateLayerList();
            this.ui.syncWithSelection();
        }

        // Redo: Cmd+Shift+Z / Ctrl+Shift+Z
        if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
            e.preventDefault();
            this.scene.redo();
            this.ui.updateLayerList();
            this.ui.syncWithSelection();
        }

        // Escape: exit direct edit → finalize pen → deselect
        if (e.key === 'Escape') {
            if (this.editingNodeId !== null) {
                // Exit direct editing mode
                this.editingNodeId = null;
                this.editingPoints = null;
                this.editingTransform = null;
                this.ui.setActiveTool('selection');
            } else if (this.currentPathPoints.length > 0) {
                this.finalizePenPath();
            } else {
                this.scene.engine!.clear_selection();
                this.ui.updateLayerList();
                this.ui.syncWithSelection();
            }
        }

        // Enter: finalize pen path
        if (e.key === 'Enter' && this.currentPathPoints.length > 0) {
            this.finalizePenPath();
        }

        // Z-ordering: ] = bring to front, [ = send to back
        if (e.key === ']' && !e.metaKey && !e.ctrlKey) {
            const selection = this.scene.engine!.get_selection();
            for (const id of selection) {
                this.scene.engine!.bring_to_front(id);
            }
            this.scene.invalidateCache();
            this.ui.updateLayerList();
        }
        if (e.key === '[' && !e.metaKey && !e.ctrlKey) {
            const selection = this.scene.engine!.get_selection();
            for (const id of selection) {
                this.scene.engine!.send_to_back(id);
            }
            this.scene.invalidateCache();
            this.ui.updateLayerList();
        }

        // Cmd+D / Ctrl+D: duplicate selected nodes
        if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
            e.preventDefault();
            this.duplicateSelection();
        }

        // Arrow key nudging
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            const selection = this.scene.engine!.get_selection();
            if (selection.length > 0) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                let dx = 0, dy = 0;
                if (e.key === 'ArrowLeft') dx = -step;
                if (e.key === 'ArrowRight') dx = step;
                if (e.key === 'ArrowUp') dy = -step;
                if (e.key === 'ArrowDown') dy = step;
                this.scene.saveMoveHistory();
                for (const id of selection) {
                    this.scene.moveNode(id, dx, dy);
                }
                this.scene.invalidateCache();
                this.ui.syncWithSelection();
            }
        }

        // Cmd+C: Copy
        if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
            this.clipboardIds = [...this.scene.engine!.get_selection()];
        }

        // Cmd+V: Paste (duplicate from clipboard)
        if ((e.metaKey || e.ctrlKey) && e.key === 'v' && !e.shiftKey) {
            if (this.clipboardIds.length > 0) {
                e.preventDefault();
                this.scene.engine!.clear_selection();
                for (const id of this.clipboardIds) {
                    const newId = this.scene.duplicateNode(id);
                    this.scene.selectNode(newId, true);
                }
                this.ui.updateLayerList();
                this.ui.syncWithSelection();
            }
        }

        // Cmd+G: Group
        if ((e.metaKey || e.ctrlKey) && e.key === 'g' && !e.shiftKey) {
            e.preventDefault();
            const selection = this.scene.engine!.get_selection();
            if (selection.length > 1) {
                const groupId = this.scene.groupNodes(JSON.stringify(selection));
                this.scene.engine!.clear_selection();
                this.scene.selectNode(groupId, false);
                this.ui.updateLayerList();
                this.ui.syncWithSelection();
            }
        }

        // Cmd+Shift+G: Ungroup
        if ((e.metaKey || e.ctrlKey) && e.key === 'g' && e.shiftKey) {
            e.preventDefault();
            const selection = this.scene.engine!.get_selection();
            for (const id of selection) {
                this.scene.ungroupNode(id);
            }
            this.ui.updateLayerList();
            this.ui.syncWithSelection();
        }
    }

    getPos(e: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = (e.clientX - rect.left);
        const screenY = (e.clientY - rect.top);

        return {
            x: (screenX - this.renderer.pan.x) / this.renderer.zoom,
            y: (screenY - this.renderer.pan.y) / this.renderer.zoom
        };
    }

    onWheel(e: WheelEvent) {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (e.ctrlKey || e.metaKey) {
            const factor = Math.pow(0.99, e.deltaY);
            const oldZoom = this.renderer.zoom;
            const newZoom = Math.max(0.01, Math.min(100, oldZoom * factor));
            const worldX = (mouseX - this.renderer.pan.x) / oldZoom;
            const worldY = (mouseY - this.renderer.pan.y) / oldZoom;
            this.renderer.zoom = newZoom;
            this.renderer.pan.x = mouseX - worldX * newZoom;
            this.renderer.pan.y = mouseY - worldY * newZoom;
            this.ui.setZoom(newZoom);
        } else {
            this.renderer.pan.x -= e.deltaX;
            this.renderer.pan.y -= e.deltaY;
        }
    }

    onMouseDown(e: MouseEvent) {
        this.isMouseDown = true;
        this.didMove = false;
        this.startPos = this.getPos(e);
        this.currentPos = { ...this.startPos };

        if (this.ui.activeTool === 'selection') {
            // Check resize handles first
            if (this.ui.activeTool === 'selection') {
                const handle = this.checkResizeHandle(this.startPos);
                if (handle) {
                    this.resizeHandleType = handle.type;
                    this.resizeNodeId = handle.nodeId;
                    const bounds = this.scene.getNodeBounds(handle.nodeId);
                    this.resizeStartBounds = { x: bounds[0], y: bounds[1], w: bounds[2] - bounds[0], h: bounds[3] - bounds[1] };
                    // Snapshot scene state so we can restore-then-resize each frame
                    this.resizeSnapshot = this.scene.engine!.serialize_scene();
                    this.scene.saveMoveHistory();
                    return;
                }
            }

            const hitId = this.scene.hitTest(this.startPos.x, this.startPos.y);
            if (hitId !== undefined) {
                // Clicked on an object — select it and prepare to drag-move
                if (!e.shiftKey) {
                    // If the object isn't already selected, replace selection
                    const currentSel = this.scene.engine!.get_selection();
                    if (!currentSel.includes(hitId)) {
                        this.scene.selectNode(hitId, false);
                    }
                } else {
                    this.scene.selectNode(hitId, true);
                }
                this.dragMode = 'move';
                this.cloneDragStarted = false;
            } else {
                // Clicked on empty space — start marquee selection
                if (!e.shiftKey) {
                    this.scene.engine!.clear_selection();
                }
                this.dragMode = 'marquee';
                this.marqueeRect = { x: this.startPos.x, y: this.startPos.y, w: 0, h: 0 };
            }
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
         } else if (this.ui.activeTool === 'smart-paint') {
            this.handleSmartPaint(e);
        } else if (this.ui.activeTool === 'direct') {
            this.handleDirectDown(this.startPos, e.shiftKey);
        } else if (this.ui.activeTool === 'pen') {
            this.handlePenDown(this.startPos);
        } else if (this.ui.activeTool === 'text') {
            // Create text node with prompt
            const content = prompt('Enter text:', 'Hello World') || 'Text';
            if (content) {
                this.scene.saveMoveHistory();
                const id = this.scene.addText(this.startPos.x, this.startPos.y, content, 32);
                this.scene.engine!.clear_selection();
                this.scene.selectNode(id, false);
                this.ui.updateLayerList();
                this.ui.syncWithSelection();
            }
        } else if (this.ui.activeTool === 'rect' || this.ui.activeTool === 'ellipse'
                   || this.ui.activeTool === 'polygon' || this.ui.activeTool === 'star') {
            this.previewRect = { x: this.startPos.x, y: this.startPos.y, w: 0, h: 0, tool: this.ui.activeTool };
        }
    }

    handleDirectDown(pos: { x: number; y: number }, isShift: boolean) {
        // First: if we're already editing a node, check if clicking on one of its points/handles
        if (this.editingNodeId !== null && this.editingPoints) {
            const hitInfo = this.findNearestHandle(pos);
            if (hitInfo) {
                this.draggingPointIndex = hitInfo.index;
                this.draggingHandleType = hitInfo.type;
                this.scene.saveMoveHistory();
                return;
            }
        }

        // Hit test to find a node
        const hitId = this.scene.hitTest(pos.x, pos.y);
        if (hitId !== undefined) {
            this.scene.selectNode(hitId, isShift);
            this.ui.syncWithSelection();
            this.ui.updateLayerList();

            // Enter edit mode — converts to path if needed
            this.enterPathEditMode(hitId);

            // Check if click is on a point we just loaded
            if (this.editingPoints) {
                const hitInfo = this.findNearestHandle(pos);
                if (hitInfo) {
                    this.draggingPointIndex = hitInfo.index;
                    this.draggingHandleType = hitInfo.type;
                    this.scene.saveMoveHistory();
                }
            }
        } else {
            // Clicked empty space — deselect
            if (!isShift) {
                this.scene.engine!.clear_selection();
                this.ui.syncWithSelection();
                this.ui.updateLayerList();
            }
            this.editingNodeId = null;
            this.editingPoints = null;
        }
    }

    findNearestHandle(pos: { x: number; y: number }): { index: number; type: 'anchor' | 'cp1' | 'cp2' } | null {
        if (!this.editingPoints || !this.editingTransform) return null;
        const threshold = 8 / this.renderer.zoom;
        const t = this.editingTransform;

        for (let i = 0; i < this.editingPoints.length; i++) {
            const p = this.editingPoints[i];
            // Transform local point to world
            const wx = t[0] * p.x + t[1] * p.y + t[2];
            const wy = t[3] * p.x + t[4] * p.y + t[5];
            if (Math.hypot(pos.x - wx, pos.y - wy) < threshold) {
                return { index: i, type: 'anchor' };
            }
            // Check cp1
            const c1x = t[0] * p.cp1[0] + t[1] * p.cp1[1] + t[2];
            const c1y = t[3] * p.cp1[0] + t[4] * p.cp1[1] + t[5];
            if (Math.hypot(pos.x - c1x, pos.y - c1y) < threshold) {
                return { index: i, type: 'cp1' };
            }
            // Check cp2
            const c2x = t[0] * p.cp2[0] + t[1] * p.cp2[1] + t[2];
            const c2y = t[3] * p.cp2[0] + t[4] * p.cp2[1] + t[5];
            if (Math.hypot(pos.x - c2x, pos.y - c2y) < threshold) {
                return { index: i, type: 'cp2' };
            }
        }
        return null;
    }

    /** Convert world coords to node-local coords using the inverted transform. */
    worldToLocal(wx: number, wy: number): { x: number; y: number } {
        const t = this.editingTransform!;
        const a = t[0], b = t[1], c = t[2];
        const d = t[3], e = t[4], f = t[5];
        const det = a * e - b * d;
        if (Math.abs(det) < 1e-10) return { x: wx, y: wy };
        return {
            x: (e * (wx - c) - b * (wy - f)) / det,
            y: (a * (wy - f) - d * (wx - c)) / det,
        };
    }

    duplicateSelection() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;
        this.scene.engine!.clear_selection();
        for (const id of selection) {
            const newId = this.scene.duplicateNode(id);
            this.scene.selectNode(newId, true);
        }
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    handlePenDown(pos: { x: number; y: number }) {
        // If we have existing points, check if clicking near the first point to close the path
        if (this.currentPathPoints.length > 1) {
            const first = this.currentPathPoints[0];
            const dist = Math.hypot(pos.x - first.x, pos.y - first.y);
            if (dist < 10) {
                // Add a closing segment back to the first point.
                // Use first point's cp1 as the incoming control handle so the
                // curve arrives smoothly (cp1 is the "incoming" handle in our convention).
                this.currentPathPoints.push({
                    x: first.x, y: first.y,
                    cp1x: first.cp1x, cp1y: first.cp1y,
                    cp2x: first.cp2x, cp2y: first.cp2y,
                });
                this.finalizePenPath();
                return;
            }
        }

        // Add a new anchor point (control points default to the anchor position)
        this.currentPathPoints.push({
            x: pos.x, y: pos.y,
            cp1x: pos.x, cp1y: pos.y,
            cp2x: pos.x, cp2y: pos.y,
        });
        this.isDraggingHandle = true;
    }

    finalizePenPath() {
        if (this.currentPathPoints.length >= 2) {
            // Transform to match Rust PathPoint struct: { x, y, cp1: [x,y], cp2: [x,y] }
            const rustPoints = this.currentPathPoints.map(p => ({
                x: p.x, y: p.y,
                cp1: [p.cp1x, p.cp1y],
                cp2: [p.cp2x, p.cp2y],
            }));
            this.scene.addPath(JSON.stringify(rustPoints));
            this.ui.updateLayerList();
        }
        this.currentPathPoints = [];
    }

    handleSmartPaint(e: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const dpr = window.devicePixelRatio;

        const path = this.smartPaint.findRegion(
            screenX, screenY, 
            this.canvas.width, this.canvas.height,
            dpr, this.renderer.pan, this.renderer.zoom
        );
        
        if (path) {
            const bounds = path.getBounds();
            if (bounds) {
                this.scene.addRect(bounds[0], bounds[1], bounds[2] - bounds[0], bounds[3] - bounds[1]);
                this.ui.updateLayerList();
            }
            path.delete();
        }
    }

    // --- Modifier helpers ---
    private constrainToAxis(start: {x: number; y: number}, current: {x: number; y: number}): {x: number; y: number} {
        const adx = Math.abs(current.x - start.x);
        const ady = Math.abs(current.y - start.y);
        return adx > ady ? { x: current.x, y: start.y } : { x: start.x, y: current.y };
    }

    private snapAngle45(dx: number, dy: number): { dx: number; dy: number } {
        const len = Math.hypot(dx, dy);
        if (len < 0.01) return { dx, dy };
        const angle = Math.atan2(dy, dx);
        const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        return { dx: len * Math.cos(snapped), dy: len * Math.sin(snapped) };
    }

    onMouseMove(e: MouseEvent) {
        const lastPos = this.currentPos;
        this.currentPos = this.getPos(e);
        this.shiftKey = e.shiftKey;
        this.altKey = e.altKey;

        // Hover cursor for resize handles (when not dragging)
        if (!this.isMouseDown && this.ui.activeTool === 'selection') {
            const handle = this.checkResizeHandle(this.currentPos);
            if (handle) {
                const cursorMap: Record<string, string> = {
                    'nw': 'nwse-resize', 'se': 'nwse-resize',
                    'ne': 'nesw-resize', 'sw': 'nesw-resize',
                    'n': 'ns-resize', 's': 'ns-resize',
                    'e': 'ew-resize', 'w': 'ew-resize',
                };
                this.canvas.style.cursor = cursorMap[handle.type] || 'default';
            } else {
                const hitId = this.scene.hitTest(this.currentPos.x, this.currentPos.y);
                this.canvas.style.cursor = hitId !== undefined ? 'move' : 'default';
            }
        }

        if (!this.isMouseDown) return;
        const dx = this.currentPos.x - lastPos.x;
        const dy = this.currentPos.y - lastPos.y;

        if (this.ui.activeTool === 'selection') {
            // Resize handle drag (checked before dragMode since resize returns early from mouseDown)
            if (this.resizeHandleType && this.resizeStartBounds && this.resizeNodeId !== null && this.resizeSnapshot) {
                const bounds = this.resizeStartBounds;
                let rdx = this.currentPos.x - this.startPos.x;
                let rdy = this.currentPos.y - this.startPos.y;
                let newW = bounds.w, newH = bounds.h;
                let moveX = 0, moveY = 0;

                if (this.resizeHandleType.includes('e')) newW = bounds.w + rdx;
                if (this.resizeHandleType.includes('w')) { newW = bounds.w - rdx; moveX = rdx; }
                if (this.resizeHandleType.includes('s')) newH = bounds.h + rdy;
                if (this.resizeHandleType.includes('n')) { newH = bounds.h - rdy; moveY = rdy; }

                // Shift: maintain aspect ratio
                if (e.shiftKey) {
                    const aspect = bounds.w / bounds.h;
                    const isCorner = this.resizeHandleType.length === 2;
                    if (isCorner) {
                        // Use the larger delta to drive both
                        if (Math.abs(rdx) / bounds.w > Math.abs(rdy) / bounds.h) {
                            newH = newW / aspect;
                        } else {
                            newW = newH * aspect;
                        }
                        // Recalculate origin shifts for w/n
                        if (this.resizeHandleType.includes('w')) moveX = bounds.w - newW;
                        if (this.resizeHandleType.includes('n')) moveY = bounds.h - newH;
                    }
                }

                // Alt: resize from center
                if (e.altKey) {
                    const deltaW = newW - bounds.w;
                    const deltaH = newH - bounds.h;
                    newW = bounds.w + deltaW * 2;
                    newH = bounds.h + deltaH * 2;
                    moveX = -deltaW;
                    moveY = -deltaH;
                }

                newW = Math.max(newW, 5);
                newH = Math.max(newH, 5);

                // Restore original state, then apply resize cleanly
                this.scene.engine!.deserialize_scene(this.resizeSnapshot);
                this.scene.engine!.resize_node(this.resizeNodeId, newW, newH);

                // Handle origin shift (for w/n handles or Alt center-resize)
                if (Math.abs(moveX) > 0.01 || Math.abs(moveY) > 0.01) {
                    this.scene.engine!.move_node(this.resizeNodeId, moveX, moveY);
                }

                this.scene.invalidateCache();
                this.ui.syncWithSelection();
                return;
            }
        }

        if (this.ui.activeTool === 'selection' && this.dragMode === 'move') {

            if (!this.didMove && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) {
                this.scene.saveMoveHistory();
                this.didMove = true;

                // Alt: clone drag — duplicate selection once at start of move
                if (e.altKey && !this.cloneDragStarted) {
                    this.cloneDragStarted = true;
                    this.duplicateSelection();
                }
            }
            if (this.didMove) {
                let mdx = dx, mdy = dy;
                // Shift: constrain to axis
                if (e.shiftKey) {
                    const constrained = this.constrainToAxis(this.startPos, this.currentPos);
                    // Compute delta from last constrained position
                    const lastConstrained = this.constrainToAxis(this.startPos, lastPos);
                    mdx = constrained.x - lastConstrained.x;
                    mdy = constrained.y - lastConstrained.y;
                }
                const selection = this.scene.engine!.get_selection();
                for (const id of selection) {
                    this.scene.moveNode(id, mdx, mdy);
                }
            }
        }

        // Update marquee selection rect
        if (this.marqueeRect) {
            const x = Math.min(this.startPos.x, this.currentPos.x);
            const y = Math.min(this.startPos.y, this.currentPos.y);
            const w = Math.abs(this.currentPos.x - this.startPos.x);
            const h = Math.abs(this.currentPos.y - this.startPos.y);
            this.marqueeRect.x = x;
            this.marqueeRect.y = y;
            this.marqueeRect.w = w;
            this.marqueeRect.h = h;
        }

        // Update live preview for shape creation
        if (this.previewRect) {
            let w = Math.abs(this.currentPos.x - this.startPos.x);
            let h = Math.abs(this.currentPos.y - this.startPos.y);

            // Shift: constrain to square/circle
            if (e.shiftKey) {
                const side = Math.max(w, h);
                w = side;
                h = side;
            }

            let x: number, y: number;
            if (e.altKey) {
                // Alt: draw from center — startPos is the center
                x = this.startPos.x - w;
                y = this.startPos.y - h;
                w *= 2;
                h *= 2;
            } else {
                x = Math.min(this.startPos.x, this.currentPos.x);
                y = Math.min(this.startPos.y, this.currentPos.y);
            }

            this.previewRect.x = x;
            this.previewRect.y = y;
            this.previewRect.w = w;
            this.previewRect.h = h;
        }

        // Pen tool: adjust control handles while dragging after placing an anchor
        if (this.ui.activeTool === 'pen' && this.isDraggingHandle && this.currentPathPoints.length > 0) {
            const lastPoint = this.currentPathPoints[this.currentPathPoints.length - 1];
            let hdx = this.currentPos.x - lastPoint.x;
            let hdy = this.currentPos.y - lastPoint.y;

            // Shift: snap handle to 45° angles
            if (e.shiftKey) {
                const snapped = this.snapAngle45(hdx, hdy);
                hdx = snapped.dx;
                hdy = snapped.dy;
            }

            lastPoint.cp2x = lastPoint.x + hdx;
            lastPoint.cp2y = lastPoint.y + hdy;
            // Alt: break tangent — only move outgoing handle, don't mirror
            if (!e.altKey) {
                lastPoint.cp1x = lastPoint.x - hdx;
                lastPoint.cp1y = lastPoint.y - hdy;
            }
        }

        // Direct selection: drag point or handle
        if (this.ui.activeTool === 'direct' && this.draggingHandleType && this.editingPoints) {
            const p = this.editingPoints[this.draggingPointIndex];
            if (!p) return;
            let local = this.worldToLocal(this.currentPos.x, this.currentPos.y);

            if (this.draggingHandleType === 'anchor') {
                // Shift: constrain anchor movement to axis
                if (e.shiftKey) {
                    const startLocal = this.worldToLocal(this.startPos.x, this.startPos.y);
                    const constrained = this.constrainToAxis(startLocal, local);
                    local = constrained;
                }
                const ldx = local.x - p.x;
                const ldy = local.y - p.y;
                p.x = local.x;
                p.y = local.y;
                // Move handles with the anchor
                p.cp1[0] += ldx;
                p.cp1[1] += ldy;
                p.cp2[0] += ldx;
                p.cp2[1] += ldy;
            } else if (this.draggingHandleType === 'cp1') {
                p.cp1[0] = local.x;
                p.cp1[1] = local.y;
                // Alt: break tangent — move only this handle
                if (!e.altKey) {
                    p.cp2[0] = 2 * p.x - local.x;
                    p.cp2[1] = 2 * p.y - local.y;
                }
            } else if (this.draggingHandleType === 'cp2') {
                p.cp2[0] = local.x;
                p.cp2[1] = local.y;
                // Alt: break tangent — move only this handle
                if (!e.altKey) {
                    p.cp1[0] = 2 * p.x - local.x;
                    p.cp1[1] = 2 * p.y - local.y;
                }
            }
            // Live update the engine so it renders immediately
            this.scene.engine!.update_path_points(
                this.editingNodeId!,
                JSON.stringify(this.editingPoints)
            );
            this.scene.invalidateCache();
        }
    }

    onMouseUp(e: MouseEvent) {
        if (!this.isMouseDown) return;
        this.isMouseDown = false;
        this.dragMode = 'none';
        this.isDraggingHandle = false;

        if (this.resizeHandleType) {
            this.resizeHandleType = null;
            this.resizeStartBounds = null;
            this.resizeNodeId = null;
            this.resizeSnapshot = null;
            this.scene.invalidateCache();
            this.scene.autosave?.trigger();
            return;
        }
        
        const endPos = this.getPos(e);
        const dist = Math.hypot(endPos.x - this.startPos.x, endPos.y - this.startPos.y);

        // Commit direct selection edit
        if (this.ui.activeTool === 'direct' && this.draggingHandleType && this.editingPoints) {
            this.scene.updatePathPoints(this.editingNodeId!, JSON.stringify(this.editingPoints));
            this.draggingPointIndex = -1;
            this.draggingHandleType = null;
        }

        // Commit marquee selection
        if (this.marqueeRect && dist > 3) {
            const { x, y, w, h } = this.marqueeRect;
            const nodesInRect = this.scene.getVisibleNodes(x, y, x + w, y + h);
            const isShift = e.shiftKey;
            if (!isShift) {
                this.scene.engine!.clear_selection();
            }
            for (const id of nodesInRect) {
                this.scene.selectNode(id, true);
            }
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
        }

        // Commit shape creation (use previewRect which already has Shift/Alt constraints applied)
        if (this.previewRect && (this.previewRect.w > 5 || this.previewRect.h > 5)) {
            const { x, y, w, h, tool } = this.previewRect;

            if (tool === 'rect') {
                this.scene.addRect(x, y, w, h);
            } else if (tool === 'ellipse') {
                this.scene.addEllipse(x + w / 2, y + h / 2, w / 2, h / 2);
            } else if (tool === 'polygon') {
                this.scene.addPolygon(x + w / 2, y + h / 2, Math.max(w, h) / 2, 6);
            } else if (tool === 'star') {
                const r = Math.max(w, h) / 2;
                this.scene.addStar(x + w / 2, y + h / 2, r, r * 0.4, 5);
            }
            this.ui.updateLayerList();
        }

        this.dragMode = 'none';
        this.previewRect = null;
        this.marqueeRect = null;
    }

    checkResizeHandle(pos: { x: number; y: number }): { type: string; nodeId: number } | null {
        const selection = this.scene.engine!.get_selection();
        if (selection.length !== 1) return null;
        const id = selection[0];
        const bounds = this.scene.getNodeBounds(id);
        const [minX, minY, maxX, maxY] = bounds;
        const threshold = 6 / this.renderer.zoom;

        const handles: Array<{ type: string; x: number; y: number }> = [
            { type: 'nw', x: minX, y: minY },
            { type: 'n',  x: (minX + maxX) / 2, y: minY },
            { type: 'ne', x: maxX, y: minY },
            { type: 'e',  x: maxX, y: (minY + maxY) / 2 },
            { type: 'se', x: maxX, y: maxY },
            { type: 's',  x: (minX + maxX) / 2, y: maxY },
            { type: 'sw', x: minX, y: maxY },
            { type: 'w',  x: minX, y: (minY + maxY) / 2 },
        ];

        for (const h of handles) {
            if (Math.abs(pos.x - h.x) < threshold && Math.abs(pos.y - h.y) < threshold) {
                return { type: h.type, nodeId: id };
            }
        }
        return null;
    }
}
