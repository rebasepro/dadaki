
import { UIEngine } from './ui';
import { Renderer } from './renderer';
import { FileIO } from './file_io';
import { SnapEngine, type SnapGuide } from './snapping';
import type { WasmScene } from './wasm_scene';
import type { PenPathPoint, Subpath } from './types';

export class InputManager {
    canvas: HTMLCanvasElement;
    scene: WasmScene;
    ui: UIEngine;
    renderer: Renderer;
    isMouseDown: boolean;
    startPos: { x: number; y: number };
    currentPos: { x: number; y: number };

    dragMode: 'move' | 'marquee' | 'none' = 'none';
    /** Whether any actual movement happened during a drag. */
    didMove: boolean = false;
    /** Live preview rect in world coords, read by Renderer each frame. */
    previewRect: { x: number; y: number; w: number; h: number; tool: string } | null = null;
    /** Accumulated pen-tool anchor points for the current path being drawn. */
    currentPathPoints: PenPathPoint[] = [];
    isDraggingHandle: boolean = false;
    /** Marquee selection rect in world coords, read by Renderer each frame. */
    marqueeRect: { x: number; y: number; w: number; h: number } | null = null;
    clipboardIds: number[] = [];

    // --- Modifier key state (updated every mousemove) ---
    shiftKey: boolean = false;
    altKey: boolean = false;

    // --- Move drag state (snapshot-restore, like resize) ---
    /** Snapshot of scene state taken at drag start so we can restore & reapply each frame. */
    moveSnapshot: Uint8Array | null = null;
    /** Original selection IDs captured at drag start. */
    moveOriginalIds: number[] = [];
    /** Union bounds of the selection at move-drag start, used for snapping. */
    moveStartBounds: { x: number; y: number; w: number; h: number } | null = null;

    // --- Snapping ---
    /** Snap engine; targets are collected at drag start. Hold Cmd/Ctrl to bypass. */
    snap = new SnapEngine();
    /** Guides from the latest snapped frame, drawn by the Renderer. */
    activeSnapGuides: SnapGuide[] = [];

    // --- Viewport navigation ---
    /** True while the space bar is held (hand tool). */
    isSpacePan: boolean = false;
    /** Active pan drag: screen position and pan at drag start. */
    panDrag: { screenX: number; screenY: number; panX: number; panY: number } | null = null;
    /** Node under the cursor (selection tool, not dragging) — outlined by the Renderer. */
    hoverNodeId: number | null = null;

    // --- Direct selection state ---
    /** Node being edited in direct selection mode. */
    editingNodeId: number | null = null;
    /** Local copy of subpaths for editing. */
    editingPoints: Subpath[] | null = null;
    /** Index of point being dragged. */
    draggingPointIndex: number = -1;
    /** Index of subpath being dragged. */
    draggingSubpathIndex: number = -1;
    /** Which part is being dragged: 'anchor', 'cp1', 'cp2', or null. */
    draggingHandleType: 'anchor' | 'cp1' | 'cp2' | null = null;
    /** Transform of the node being edited (for world<->local conversion). */
    editingTransform: Float32Array | null = null;

    // --- Resize handle state ---
    resizeHandleType: string | null = null; // 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', or null
    resizeStartBounds: { x: number; y: number; w: number; h: number } | null = null;
    /** Deduped selection ids captured at resize start (ancestors only, no double-scaling). */
    resizeTargetIds: number[] = [];
    /** Snapshot of the scene state before resize started, so we can restore and reapply cleanly. */
    resizeSnapshot: Uint8Array | null = null;
    /** Current calculated bounds during a resize drag, read by Renderer for smooth sticky handles. */
    liveResizeBounds: { x: number; y: number; w: number; h: number } | null = null;

    constructor(canvas: HTMLCanvasElement, scene: WasmScene, ui: UIEngine, renderer: Renderer) {
        this.canvas = canvas;
        this.scene = scene;
        this.ui = ui;
        this.renderer = renderer;

        this.isMouseDown = false;
        this.startPos = { x: 0, y: 0 };
        this.currentPos = { x: 0, y: 0 };


        this.init();
    }

    init() {
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
        this.canvas.addEventListener('contextmenu', (e) => this.onContextMenu(e));
        window.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('mouseup', (e) => this.onMouseUp(e));
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
        window.addEventListener('keyup', (e) => this.onKeyUp(e));
        window.addEventListener('wheel', (e) => this.onWheel(e), { passive: false, capture: true });

        // Import .svg / .vec files by dropping them onto the canvas area
        const dropTarget = document.getElementById('canvas-container') ?? this.canvas;
        dropTarget.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });
        dropTarget.addEventListener('drop', (e) => { this.onFileDrop(e).catch(console.error); });

        // Safari pinch-to-zoom prevention (page zoom would fight canvas zoom)
        window.addEventListener('gesturestart', (e) => e.preventDefault(), { capture: true });
        window.addEventListener('gesturechange', (e) => e.preventDefault(), { capture: true });
        window.addEventListener('gestureend', (e) => e.preventDefault(), { capture: true });
    }

    /** Import dropped files: .svg content is centered at the drop point and
     *  selected; .vec replaces the document (undoable — a history snapshot is
     *  taken first). */
    async onFileDrop(e: DragEvent) {
        e.preventDefault();
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length === 0 || !this.scene.engine) return;
        const dropWorld = this.getPos(e);

        for (const file of files) {
            const name = file.name.toLowerCase();
            if (name.endsWith('.svg')) {
                const text = await file.text();
                // One transaction → the whole drop is a single undo step
                this.scene.transaction(() => {
                    const rootsBefore = new Set(this.scene.getRootNodes());
                    this.ui.parseSVG(text);

                    // Center the imported nodes at the drop point and select them
                    const newRoots = Array.from(this.scene.getRootNodes()).filter(id => !rootsBefore.has(id));
                    if (newRoots.length === 0) return;
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    for (const id of newRoots) {
                        const b = this.scene.getNodeBounds(id);
                        minX = Math.min(minX, b[0]); minY = Math.min(minY, b[1]);
                        maxX = Math.max(maxX, b[2]); maxY = Math.max(maxY, b[3]);
                    }
                    if (minX < maxX && minY < maxY) {
                        const dx = dropWorld.x - (minX + maxX) / 2;
                        const dy = dropWorld.y - (minY + maxY) / 2;
                        for (const id of newRoots) this.scene.engine!.move_node(id, dx, dy);
                    }
                    this.scene.engine!.clear_selection();
                    for (const id of newRoots) this.scene.selectNode(id, true);
                });
            } else if (name.endsWith('.vec')) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                this.scene.saveMoveHistory(); // snapshot current doc so the drop is undoable
                this.scene.engine.deserialize_proto(bytes);
            }
        }

        this.scene.invalidateCache();
        this.scene.autosave?.trigger();
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    onContextMenu(e: MouseEvent) {
        e.preventDefault();
        const pos = this.getPos(e);
        const hitId = this.scene.hitTestGrouped(pos.x, pos.y);
        if (hitId !== undefined) {
            // Select the element if not already selected
            const currentSel = this.scene.engine!.get_selection();
            if (!currentSel.includes(hitId)) {
                this.scene.selectNode(hitId, false);
                this.ui.syncWithSelection();
                this.ui.updateLayerList();
            }
            this.ui.showContextMenu(e.clientX, e.clientY, (action: string) => {
                this.handleContextMenuAction(action);
            });
        } else {
            this.ui.hideContextMenu();
        }
    }

    handleContextMenuAction(action: string) {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;

        switch (action) {
            case 'bring-to-front':
                this.scene.transaction(() => { for (const id of selection) this.scene.bringToFront(id); });
                break;
            case 'bring-forward':
                this.scene.transaction(() => { for (const id of selection) this.scene.bringForward(id); });
                break;
            case 'send-backward':
                this.scene.transaction(() => { for (const id of selection) this.scene.sendBackward(id); });
                break;
            case 'send-to-back':
                this.scene.transaction(() => { for (const id of selection) this.scene.sendToBack(id); });
                break;
            case 'duplicate':
                this.duplicateSelection();
                break;
            case 'delete':
                this.deleteSelection();
                break;
            case 'group':
                this.groupSelection();
                break;
            case 'ungroup':
                this.ungroupSelection();
                break;
            case 'convert-to-path':
                for (const id of selection) {
                    this.scene.convertToPath(id);
                }
                break;
        }
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.hideContextMenu();
    }

    onDoubleClick(e: MouseEvent) {
        const pos = this.getPos(e);
        const hitId = this.scene.hitTest(pos.x, pos.y); // raw hit for drill-down
        if (hitId === undefined) return;

        // Check if the currently selected node is a group
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 1) {
            const selectedNode = this.scene.getNode(selection[0]);
            if (selectedNode && selectedNode.node_type === 'Group') {
                // Double-click on a group → "enter" it: select the child under cursor
                this.scene.selectNode(hitId, false);
                this.ui.syncWithSelection();
                this.ui.updateLayerList();
                return;
            }
        }

        // Double-click on a leaf shape: enter path edit only if it's already a Path
        // or if the user is in the 'direct' tool. Don't destructively convert Rect/Ellipse.
        const node = this.scene.getNode(hitId);
        if (!node) return;

        // Double-click on text: edit its content inline
        if (node.geometry.Text) {
            this.scene.selectNode(hitId, false);
            this.ui.syncWithSelection();
            this.editTextNode(hitId);
            return;
        }

        if (node.geometry.Path || this.ui.activeTool === 'direct') {
            this.ui.setActiveTool('direct');
            this.scene.selectNode(hitId, false);
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
            this.enterPathEditMode(hitId);
        } else {
            // For Rect/Ellipse with selection tool: just select, don't convert
            this.scene.selectNode(hitId, false);
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
        }
    }

    /** Enter path edit mode on a node. Converts Rect/Ellipse to Path first if needed. */
    enterPathEditMode(nodeId: number) {
        // Convert non-path geometry to path
        const geometry = this.scene.getNodeGeometry(nodeId);
        if (!geometry) return;

        if (!geometry.Path) {
            // Convert rect/ellipse/etc. to editable path
            this.scene.convertToPath(nodeId);
        }

        // Re-read geometry after potential conversion
        const updatedGeometry = this.scene.getNodeGeometry(nodeId);
        if (updatedGeometry && updatedGeometry.Path) {
            this.editingNodeId = nodeId;
            this.editingPoints = JSON.parse(JSON.stringify(updatedGeometry.Path.subpaths));
            this.editingTransform = this.scene.getTransform(nodeId);
            this.ui.updateLayerList();
            this.ui.contextBar?.refresh();
        }
    }

    onKeyDown(e: KeyboardEvent) {
        // Don't handle shortcuts when typing in form elements or contenteditable
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if ((e.target as HTMLElement)?.isContentEditable) return;

        // Space: hold for hand tool (pan-drag)
        if (e.key === ' ') {
            e.preventDefault(); // stop page scroll
            if (!this.isSpacePan && !this.isMouseDown) {
                this.isSpacePan = true;
                this.canvas.style.cursor = 'grab';
            }
            return;
        }

        // Cmd+A: select all top-level nodes (skips locked/hidden)
        if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
            e.preventDefault();
            this.scene.engine!.clear_selection();
            for (const id of this.scene.getRootNodes()) {
                if (this.scene.getNodeLocked(id) || !this.scene.getNodeVisible(id)) continue;
                this.scene.selectNode(id, true);
            }
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
            return;
        }

        // Tool shortcuts
        if (!e.metaKey && !e.ctrlKey) {
            if (e.key === 'v' || e.key === 'V') this.ui.setActiveTool('selection');
            if (e.key === 'a' || e.key === 'A') this.ui.setActiveTool('direct');
            if (e.key === 'p' || e.key === 'P') this.ui.setActiveTool('pen');
            if (e.key === 'r' || e.key === 'R') this.ui.setActiveTool('rect');
            if (e.key === 'o' || e.key === 'O') this.ui.setActiveTool('ellipse');

            if (e.key === 'b' || e.key === 'B') this.ui.setActiveTool('paint-bucket');
            if (e.key === 't' || e.key === 'T') this.ui.setActiveTool('text');

            // View shortcuts (Figma-style)
            if (e.key === '!' || (e.shiftKey && e.key === '1')) {
                // Shift+1: fit artboard in view
                this.renderer.fitToArtboard();
                this.ui.setZoom(this.renderer.zoom);
            }
            if (e.key === ')' || (e.shiftKey && e.key === '0')) {
                // Shift+0: zoom to 100%
                this.renderer.setZoomCentered(1.0);
                this.ui.setZoom(this.renderer.zoom);
            }
            if (e.key === '@' || (e.shiftKey && e.key === '2')) {
                // Shift+2: zoom to selection
                const b = this.getSelectionBounds();
                if (b) {
                    this.renderer.zoomToBounds(b);
                    this.ui.setZoom(this.renderer.zoom);
                }
            }
            if (e.key === '+' || e.key === '=') {
                this.renderer.setZoomCentered(this.renderer.zoom * 1.25);
                this.ui.setZoom(this.renderer.zoom);
            }
            if (e.key === '-' || e.key === '_') {
                this.renderer.setZoomCentered(this.renderer.zoom / 1.25);
                this.ui.setZoom(this.renderer.zoom);
            }
        }

        // Delete
        if (e.key === 'Backspace' || e.key === 'Delete') {
            this.deleteSelection();
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

        // Save: Cmd+S / Ctrl+S
        if ((e.metaKey || e.ctrlKey) && e.key === 's' && !e.shiftKey) {
            e.preventDefault();
            if (this.scene.engine) {
                FileIO.saveVec(this.scene.engine).catch(console.error);
            }
        }

        // Save As: Cmd+Shift+S / Ctrl+Shift+S
        if ((e.metaKey || e.ctrlKey) && e.key === 's' && e.shiftKey) {
            e.preventDefault();
            if (this.scene.engine) {
                FileIO.saveVecAs(this.scene.engine).catch(console.error);
            }
        }

        // Open: Cmd+O / Ctrl+O
        if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
            e.preventDefault();
            if (this.scene.engine) {
                FileIO.openFile(this.scene.engine, (svgText) => this.ui.parseSVG(svgText)).then((loaded) => {
                    if (loaded) {
                        this.scene.invalidateCache();
                        this.ui.updateLayerList();
                        this.ui.syncWithSelection();
                    }
                }).catch(console.error);
            }
        }

        // Export SVG: Cmd+Shift+E / Ctrl+Shift+E
        if ((e.metaKey || e.ctrlKey) && e.key === 'e' && e.shiftKey) {
            e.preventDefault();
            this.ui.exportSVG();
        }

        // Escape: cancel in-flight drag → exit path edit → exit group → deselect
        if (e.key === 'Escape') {
            if (this.isMouseDown && (this.moveSnapshot || this.resizeSnapshot || this.previewRect || this.marqueeRect)) {
                this.cancelActiveDrag();
                return;
            }
            if (this.editingNodeId !== null) {
                // Exit direct editing mode
                this.editingNodeId = null;
                this.editingPoints = null;
                this.editingTransform = null;
                this.ui.setActiveTool('selection');
            } else if (this.currentPathPoints.length > 0) {
                this.finalizePenPath();
            } else {
                // Check if we're inside a group — if so, select the parent group instead of clearing
                const selection = this.scene.engine!.get_selection();
                if (selection.length > 0) {
                    const parentId = this.scene.getNodeParent(selection[0]);
                    const parentNode = parentId >= 0 ? this.scene.getNode(parentId) : null;

                    if (parentNode && parentNode.node_type === 'Group') {
                        // Exit group context: select the parent group
                        this.scene.selectNode(parentId, false);
                    } else {
                        // At root level: clear selection
                        this.scene.engine!.clear_selection();
                    }
                } else {
                    this.scene.engine!.clear_selection();
                }
                this.ui.updateLayerList();
                this.ui.syncWithSelection();
                this.ui.contextBar?.refresh();
            }
        }

        // Enter: finalize pen path
        if (e.key === 'Enter' && this.currentPathPoints.length > 0) {
            this.finalizePenPath();
        }

        // Z-ordering: ]/[ = step forward/backward, Cmd+]/Cmd+[ = front/back
        if (e.key === ']') {
            const selection = this.scene.engine!.get_selection();
            if (e.metaKey || e.ctrlKey) {
                for (const id of selection) this.scene.bringToFront(id);
            } else {
                for (const id of selection) this.scene.bringForward(id);
            }
            this.ui.updateLayerList();
        }
        if (e.key === '[') {
            const selection = this.scene.engine!.get_selection();
            if (e.metaKey || e.ctrlKey) {
                for (const id of selection) this.scene.sendToBack(id);
            } else {
                for (const id of selection) this.scene.sendBackward(id);
            }
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
                this.scene.transaction(() => {
                    this.scene.engine!.clear_selection();
                    for (const id of this.clipboardIds) {
                        const newId = this.scene.duplicateNode(id);
                        this.scene.selectNode(newId, true);
                    }
                });
                this.ui.updateLayerList();
                this.ui.syncWithSelection();
            }
        }

        // Cmd+G: Group
        if ((e.metaKey || e.ctrlKey) && e.key === 'g' && !e.shiftKey) {
            e.preventDefault();
            this.groupSelection();
        }

        // Cmd+Shift+G: Ungroup
        if ((e.metaKey || e.ctrlKey) && e.key === 'g' && e.shiftKey) {
            e.preventDefault();
            this.ungroupSelection();
        }
    }

    /** Open an inline editor over an existing text node (double-click). */
    editTextNode(id: number) {
        const geo = this.scene.getNodeGeometry(id);
        if (!geo?.Text) return;
        const container = document.getElementById('canvas-container');
        if (!container) return;

        const t = this.scene.getTransform(id); // row-major: t[2]/t[5] = translation
        const fontSize = geo.Text.font_size;
        const originalContent = geo.Text.content;
        const screenX = t[2] * this.renderer.zoom + this.renderer.pan.x;
        const screenY = (t[5] - fontSize) * this.renderer.zoom + this.renderer.pan.y;

        const input = document.createElement('input');
        input.className = 'text-input-overlay';
        input.type = 'text';
        input.value = originalContent;
        input.style.left = `${screenX}px`;
        input.style.top = `${screenY}px`;
        input.style.fontSize = `${fontSize * this.renderer.zoom}px`;

        let done = false;
        const commit = () => {
            if (done) return;
            done = true;
            const content = input.value.trim();
            input.remove();
            if (content && content !== originalContent) {
                this.scene.setTextContent(id, content, fontSize);
                this.ui.syncWithSelection();
            }
        };
        const cancel = () => {
            if (done) return;
            done = true;
            input.remove();
        };

        input.addEventListener('keydown', (ev: KeyboardEvent) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                commit();
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                cancel();
            }
            ev.stopPropagation();
        });
        input.addEventListener('blur', commit);

        container.appendChild(input);
        input.focus();
        input.select();
    }

    /** Abort the current drag (Esc): restore the pre-drag scene state and
     *  drop all previews. The subsequent mouseup is a no-op because
     *  isMouseDown is already cleared. */
    cancelActiveDrag() {
        if (this.moveSnapshot) {
            this.scene.engine!.deserialize_scene(this.moveSnapshot);
            this.moveSnapshot = null;
            this.moveOriginalIds = [];
            this.moveStartBounds = null;
        }
        if (this.resizeSnapshot) {
            this.scene.engine!.deserialize_scene(this.resizeSnapshot);
        }
        this.resizeHandleType = null;
        this.resizeStartBounds = null;
        this.resizeTargetIds = [];
        this.resizeSnapshot = null;
        this.liveResizeBounds = null;
        this.previewRect = null;
        this.marqueeRect = null;
        this.dragMode = 'none';
        this.isMouseDown = false;
        this.didMove = false;
        this.snap.end();
        this.activeSnapGuides = [];
        this.canvas.style.cursor = 'default';
        this.scene.invalidateCache();
        this.ui.syncWithSelection();
    }

    onKeyUp(e: KeyboardEvent) {
        if (e.key === ' ') {
            this.isSpacePan = false;
            if (!this.panDrag) {
                this.canvas.style.cursor = 'default';
            }
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
        // Only handle wheel events when the target is the canvas or its container
        const container = document.getElementById('canvas-container');
        if (!container || !container.contains(e.target as Node)) return;

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
        // Ignore right-click — handled by onContextMenu
        if (e.button === 2) return;
        this.ui.hideContextMenu();
        this.isMouseDown = true;
        this.didMove = false;
        this.startPos = this.getPos(e);
        this.currentPos = { ...this.startPos };
        this.hoverNodeId = null;

        // Space held (or middle mouse): pan the viewport instead of using the tool
        if (this.isSpacePan || e.button === 1) {
            e.preventDefault();
            this.panDrag = {
                screenX: e.clientX, screenY: e.clientY,
                panX: this.renderer.pan.x, panY: this.renderer.pan.y,
            };
            this.canvas.style.cursor = 'grabbing';
            return;
        }

        if (this.ui.activeTool === 'selection') {
            // Check resize handles first
            const handle = this.checkResizeHandle(this.startPos);
            if (handle) {
                this.resizeHandleType = handle.type;
                this.resizeStartBounds = this.getSelectionBounds();
                this.resizeTargetIds = Array.from(this.scene.dedupSelection(this.scene.engine!.get_selection()));
                // Snapshot scene state so we can restore-then-resize each frame
                this.resizeSnapshot = this.scene.engine!.serialize_scene();
                this.snap.begin(this.scene, this.resizeTargetIds);
                this.scene.saveMoveHistory();
                return;
            }

            const hitId = this.getTargetIdForHit(this.startPos);
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

        } else if (this.ui.activeTool === 'direct') {
            this.handleDirectDown(this.startPos, e.shiftKey);
        } else if (this.ui.activeTool === 'pen') {
            // Snap new anchors to geometry unless Cmd/Ctrl bypasses snapping
            if (!e.metaKey && !e.ctrlKey) {
                this.snap.begin(this.scene, []);
                const s = this.snap.snapPoint(this.startPos.x, this.startPos.y, 8 / this.renderer.zoom);
                this.startPos = { x: s.x, y: s.y };
                this.snap.end();
            }
            this.handlePenDown(this.startPos);
        } else if (this.ui.activeTool === 'text') {
            // Create inline text input at click position
            const container = document.getElementById('canvas-container');
            if (!container) return;

            const screenX = this.startPos.x * this.renderer.zoom + this.renderer.pan.x;
            const screenY = this.startPos.y * this.renderer.zoom + this.renderer.pan.y;

            const input = document.createElement('input');
            input.className = 'text-input-overlay';
            input.type = 'text';
            input.value = 'Hello World';
            input.style.left = `${screenX}px`;
            input.style.top = `${screenY}px`;
            input.style.fontSize = `${32 * this.renderer.zoom}px`;

            // `done` guards against the double-commit that happens when
            // Enter removes the input, which fires blur → commit again.
            let done = false;
            const commit = () => {
                if (done) return;
                done = true;
                const content = input.value.trim() || 'Text';
                input.remove();
                this.scene.saveMoveHistory();
                const id = this.scene.addText(this.startPos.x, this.startPos.y, content, 32);
                // Text uses the active fill and no stroke — the engine default
                // (white fill) is invisible against the white artboard.
                const style = JSON.parse(this.ui.getCurrentStyle());
                style.stroke = null;
                style.stroke_width = 0;
                this.scene.setNodeStyleNoHistory(id, JSON.stringify(style));
                this.scene.engine!.clear_selection();
                this.scene.selectNode(id, false);
                this.ui.updateLayerList();
                this.ui.syncWithSelection();
            };

            const cancel = () => {
                if (done) return;
                done = true;
                input.remove();
            };

            input.addEventListener('keydown', (ev: KeyboardEvent) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    commit();
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    cancel();
                }
                ev.stopPropagation();
            });

            input.addEventListener('blur', commit);

            container.appendChild(input);
            input.focus();
            input.select();
        } else if (this.ui.activeTool === 'rect' || this.ui.activeTool === 'ellipse'
                   || this.ui.activeTool === 'polygon' || this.ui.activeTool === 'star') {
            // Snap the anchor corner unless Cmd/Ctrl bypasses snapping
            this.snap.begin(this.scene, []);
            if (!e.metaKey && !e.ctrlKey) {
                const s = this.snap.snapPoint(this.startPos.x, this.startPos.y, 8 / this.renderer.zoom);
                this.startPos = { x: s.x, y: s.y };
            }
            this.previewRect = { x: this.startPos.x, y: this.startPos.y, w: 0, h: 0, tool: this.ui.activeTool };
        } else if (this.ui.activeTool === 'paint-bucket') {
            this.handlePaintBucketClick(this.startPos);
        }
    }

    handlePaintBucketClick(pos: { x: number; y: number }) {
        if (!this.scene.engine) return;
        const faceId = this.scene.engine.query_face_at(pos.x, pos.y);
        if (faceId >= 0) {
            // Get the active fill color from UI
            const color = this.ui.getActiveFillColor();
            this.scene.setFaceFill(faceId, color.r, color.g, color.b, color.a);
        }
    }

    handleDirectDown(pos: { x: number; y: number }, isShift: boolean) {
        // First: if we're already editing a node, check if clicking on one of its points/handles
        if (this.editingNodeId !== null && this.editingPoints) {
            const hitInfo = this.findNearestHandle(pos);
            if (hitInfo) {
                this.draggingSubpathIndex = hitInfo.subpathIndex;
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
                    this.draggingSubpathIndex = hitInfo.subpathIndex;
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

    findNearestHandle(pos: { x: number; y: number }): { subpathIndex: number; index: number; type: 'anchor' | 'cp1' | 'cp2' } | null {
        if (!this.editingPoints || !this.editingTransform) return null;
        const threshold = 8 / this.renderer.zoom;
        const t = this.editingTransform;

        for (let si = 0; si < this.editingPoints.length; si++) {
            const sp = this.editingPoints[si];
            for (let i = 0; i < sp.points.length; i++) {
                const p = sp.points[i];
                // Transform local point to world
                const wx = t[0] * p.x + t[1] * p.y + t[2];
                const wy = t[3] * p.x + t[4] * p.y + t[5];
                if (Math.hypot(pos.x - wx, pos.y - wy) < threshold) {
                    return { subpathIndex: si, index: i, type: 'anchor' };
                }
                // Check cp1
                const c1x = t[0] * p.cp1[0] + t[1] * p.cp1[1] + t[2];
                const c1y = t[3] * p.cp1[0] + t[4] * p.cp1[1] + t[5];
                if (Math.hypot(pos.x - c1x, pos.y - c1y) < threshold) {
                    return { subpathIndex: si, index: i, type: 'cp1' };
                }
                // Check cp2
                const c2x = t[0] * p.cp2[0] + t[1] * p.cp2[1] + t[2];
                const c2y = t[3] * p.cp2[0] + t[4] * p.cp2[1] + t[5];
                if (Math.hypot(pos.x - c2x, pos.y - c2y) < threshold) {
                    return { subpathIndex: si, index: i, type: 'cp2' };
                }
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
        this.scene.transaction(() => {
            this.scene.engine!.clear_selection();
            for (const id of selection) {
                const newId = this.scene.duplicateNode(id);
                this.scene.selectNode(newId, true);
            }
        });
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    deleteSelection() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;
        this.scene.engine!.clear_selection();
        this.scene.removeNodes(selection);
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    groupSelection() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length < 1) return;
        const groupId = this.scene.groupNodes(selection);
        this.scene.engine!.clear_selection();
        this.scene.selectNode(groupId, false);
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    ungroupSelection() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;
        this.scene.transaction(() => {
            for (const id of selection) {
                this.scene.ungroupNode(id);
            }
        });
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    /** Whether the current pen path was closed by clicking near the first point. */
    penPathClosed: boolean = false;

    handlePenDown(pos: { x: number; y: number }) {
        // If we have existing points, check if clicking near the first point to close the path
        if (this.currentPathPoints.length > 1) {
            const first = this.currentPathPoints[0];
            const dist = Math.hypot(pos.x - first.x, pos.y - first.y);
            if (dist < 10) {
                this.penPathClosed = true;
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
        this.ui.contextBar?.refresh();
    }

    finalizePenPath() {
        if (this.currentPathPoints.length >= 2) {
            const rustPoints = this.currentPathPoints.map(p => ({
                x: p.x, y: p.y,
                cp1: [p.cp1x, p.cp1y],
                cp2: [p.cp2x, p.cp2y],
            }));
            const subpaths = [{ points: rustPoints, closed: this.penPathClosed }];
            const newId = this.scene.addPath(JSON.stringify(subpaths));

            // Apply the current UI style and select the new path
            this.scene.setNodeStyleNoHistory(newId, this.ui.getCurrentStyle());
            this.scene.engine!.clear_selection();
            this.scene.selectNode(newId, false);
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
        }
        this.currentPathPoints = [];
        this.penPathClosed = false;
        this.ui.contextBar?.refresh();
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

        // Viewport pan drag (space or middle mouse held)
        if (this.panDrag && this.isMouseDown) {
            this.renderer.pan.x = this.panDrag.panX + (e.clientX - this.panDrag.screenX);
            this.renderer.pan.y = this.panDrag.panY + (e.clientY - this.panDrag.screenY);
            return;
        }
        if (this.isSpacePan) return; // hand tool active — no hover/tool behavior

        // Hover cursor for resize handles (when not dragging)
        if (!this.isMouseDown && this.ui.activeTool === 'selection') {
            const handle = this.checkResizeHandle(this.currentPos);
            if (handle) {
                this.hoverNodeId = null;
                const cursorMap: Record<string, string> = {
                    'nw': 'nwse-resize', 'se': 'nwse-resize',
                    'ne': 'nesw-resize', 'sw': 'nesw-resize',
                    'n': 'ns-resize', 's': 'ns-resize',
                    'e': 'ew-resize', 'w': 'ew-resize',
                };
                this.canvas.style.cursor = cursorMap[handle.type] || 'default';
            } else {
                const hitId = this.getTargetIdForHit(this.currentPos);
                this.hoverNodeId = hitId ?? null;
                if (hitId !== undefined) {
                    this.canvas.style.cursor = e.altKey ? 'copy' : 'move';
                } else {
                    this.canvas.style.cursor = 'default';
                }
            }
        }

        // Paint bucket hover preview
        if (!this.isMouseDown && this.ui.activeTool === 'paint-bucket') {
            const faceId = this.scene.engine!.query_face_at(this.currentPos.x, this.currentPos.y);
            this.renderer.hoverFaceId = faceId;
            this.canvas.style.cursor = faceId >= 0 ? 'crosshair' : 'default';
        }

        if (!this.isMouseDown) return;
        const dx = this.currentPos.x - lastPos.x;
        const dy = this.currentPos.y - lastPos.y;

        if (this.ui.activeTool === 'selection') {
            // Resize handle drag (checked before dragMode since resize returns early from mouseDown)
            if (this.resizeHandleType && this.resizeStartBounds && this.resizeTargetIds.length > 0 && this.resizeSnapshot) {
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

                // Snap the dragged edge(s) to nearby geometry. Skipped with
                // Shift/Alt (aspect and center-resize win) and bypassed with
                // Cmd/Ctrl (Figma/Illustrator-style temporary disable).
                this.activeSnapGuides = [];
                if (!e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
                    const threshold = 8 / this.renderer.zoom;
                    if (this.resizeHandleType.includes('e')) {
                        const s = this.snap.snapAxis('x', bounds.x + newW, threshold);
                        if (s) { newW = s.value - bounds.x; this.activeSnapGuides.push(s.guide); }
                    }
                    if (this.resizeHandleType.includes('w')) {
                        const s = this.snap.snapAxis('x', bounds.x + moveX, threshold);
                        if (s) {
                            const d = s.value - (bounds.x + moveX);
                            moveX += d; newW -= d;
                            this.activeSnapGuides.push(s.guide);
                        }
                    }
                    if (this.resizeHandleType.includes('s')) {
                        const s = this.snap.snapAxis('y', bounds.y + newH, threshold);
                        if (s) { newH = s.value - bounds.y; this.activeSnapGuides.push(s.guide); }
                    }
                    if (this.resizeHandleType.includes('n')) {
                        const s = this.snap.snapAxis('y', bounds.y + moveY, threshold);
                        if (s) {
                            const d = s.value - (bounds.y + moveY);
                            moveY += d; newH -= d;
                            this.activeSnapGuides.push(s.guide);
                        }
                    }
                }

                newW = Math.max(newW, 1);
                newH = Math.max(newH, 1);

                // Update live bounds for the renderer to show smooth handles
                this.liveResizeBounds = { x: bounds.x + moveX, y: bounds.y + moveY, w: newW, h: newH };

                // Restore original state, then apply the resize cleanly.
                // Each target node is mapped from the start bounds into the live
                // bounds: resize to its scaled size, then move so its bounds land
                // at the scaled position. The post-resize move corrects for
                // geometry that resizes about a point other than its top-left
                // corner (e.g. ellipses resize about their center).
                this.scene.engine!.deserialize_scene(this.resizeSnapshot);
                const scaleX = newW / Math.max(bounds.w, 1e-6);
                const scaleY = newH / Math.max(bounds.h, 1e-6);
                const live = this.liveResizeBounds;

                for (const id of this.resizeTargetIds) {
                    const b = this.scene.getNodeBounds(id);
                    const targetX = live.x + (b[0] - bounds.x) * scaleX;
                    const targetY = live.y + (b[1] - bounds.y) * scaleY;
                    this.scene.engine!.resize_node(id, (b[2] - b[0]) * scaleX, (b[3] - b[1]) * scaleY);
                    const nb = this.scene.getNodeBounds(id);
                    const dx = targetX - nb[0];
                    const dy = targetY - nb[1];
                    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
                        this.scene.engine!.move_node(id, dx, dy);
                    }
                }

                this.scene.invalidateCache();
                // Pass interactive to skip expensive context bar / breadcrumb / layer list rebuilds during drag
                this.ui.syncWithSelection({ interactive: true });
                return;
            }
        }

        if (this.ui.activeTool === 'selection' && this.dragMode === 'move') {

            if (!this.didMove && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) {
                this.scene.saveMoveHistory();
                this.didMove = true;
                // Snapshot the pre-drag scene (same approach as resize).
                // We restore this every frame so modifier changes (Alt, Shift) apply cleanly.
                this.moveSnapshot = this.scene.engine!.serialize_scene();
                this.moveOriginalIds = [...this.scene.engine!.get_selection()];
                this.moveStartBounds = this.getSelectionBounds();
                this.snap.begin(this.scene, this.moveOriginalIds);
            }

            if (this.didMove && this.moveSnapshot) {
                // Restore pristine pre-drag state
                this.scene.engine!.deserialize_scene(this.moveSnapshot);

                // Compute total displacement from drag start
                let totalDx = this.currentPos.x - this.startPos.x;
                let totalDy = this.currentPos.y - this.startPos.y;

                // Shift: constrain to axis
                if (e.shiftKey) {
                    const constrained = this.constrainToAxis(this.startPos, this.currentPos);
                    totalDx = constrained.x - this.startPos.x;
                    totalDy = constrained.y - this.startPos.y;
                }

                // Snap the moving selection box (edges + centers) to nearby
                // geometry. Cmd/Ctrl bypasses snapping; with Shift only the
                // free axis snaps so the constraint is never broken.
                this.activeSnapGuides = [];
                if (!e.metaKey && !e.ctrlKey && this.moveStartBounds) {
                    const sb = this.moveStartBounds;
                    const snapped = this.snap.snapBounds(
                        { x: sb.x + totalDx, y: sb.y + totalDy, w: sb.w, h: sb.h },
                        8 / this.renderer.zoom,
                    );
                    const xLocked = e.shiftKey && totalDx === 0;
                    const yLocked = e.shiftKey && totalDy === 0;
                    if (!xLocked) totalDx += snapped.dx;
                    if (!yLocked) totalDy += snapped.dy;
                    this.activeSnapGuides = snapped.guides.filter(g =>
                        (g.axis === 'x' && !xLocked) || (g.axis === 'y' && !yLocked));
                }

                let moveTargets: number[];
                if (e.altKey) {
                    // Alt: clone-drag — duplicate originals, move the clones
                    this.scene.engine!.clear_selection();
                    moveTargets = [];
                    for (const id of this.moveOriginalIds) {
                        const newId = this.scene.engine!.duplicate_node(id);
                        this.scene.engine!.select_node(newId, true);
                        moveTargets.push(newId);
                    }
                    this.canvas.style.cursor = 'copy';
                } else {
                    // Normal move — shift the originals
                    this.scene.engine!.clear_selection();
                    for (const id of this.moveOriginalIds) {
                        this.scene.engine!.select_node(id, true);
                    }
                    moveTargets = this.moveOriginalIds;
                    this.canvas.style.cursor = 'move';
                }

                for (const id of moveTargets) {
                    this.scene.engine!.move_node(id, totalDx, totalDy);
                }
                this.scene.invalidateCache();
                // Update property panel position values without rebuilding chrome DOM
                this.ui.syncWithSelection({ interactive: true });
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
            // Snap the moving corner (skipped with Shift/Alt so the square /
            // from-center constraints stay exact; Cmd/Ctrl bypasses).
            let cur = this.currentPos;
            this.activeSnapGuides = [];
            if (!e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
                const s = this.snap.snapPoint(cur.x, cur.y, 8 / this.renderer.zoom);
                cur = { x: s.x, y: s.y };
                this.activeSnapGuides = s.guides;
            }

            let w = Math.abs(cur.x - this.startPos.x);
            let h = Math.abs(cur.y - this.startPos.y);

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
                // Anchor at startPos, extend toward the drag direction.
                // When Shift is held the constrained size may exceed the
                // cursor offset on one axis, so we can't use Math.min with
                // currentPos — that would place the origin at the cursor
                // instead of at startPos on the shorter axis.
                x = cur.x >= this.startPos.x ? this.startPos.x : this.startPos.x - w;
                y = cur.y >= this.startPos.y ? this.startPos.y : this.startPos.y - h;
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
            const sp = this.editingPoints[this.draggingSubpathIndex];
            if (!sp) return;
            const p = sp.points[this.draggingPointIndex];
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
        this.snap.end();
        this.activeSnapGuides = [];

        // End viewport pan drag
        if (this.panDrag) {
            this.panDrag = null;
            this.canvas.style.cursor = this.isSpacePan ? 'grab' : 'default';
            return;
        }

        // Clean up move-drag snapshot
        if (this.moveSnapshot) {
            this.moveSnapshot = null;
            this.moveOriginalIds = [];
            this.moveStartBounds = null;
            this.scene.invalidateCache();
            this.scene.autosave?.trigger();
            this.ui.updateLayerList();
            this.ui.syncWithSelection();
        }
        this.canvas.style.cursor = 'default';

        if (this.resizeHandleType) {
            this.resizeHandleType = null;
            this.resizeStartBounds = null;
            this.resizeTargetIds = [];
            this.resizeSnapshot = null;
            this.liveResizeBounds = null;
            this.scene.invalidateCache();
            this.scene.autosave?.trigger();
            // Final sync to update layer list
            this.ui.syncWithSelection();
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
            // Filter out locked nodes — they shouldn't be selectable via marquee
            // Promote leaf nodes to their topmost group ancestor (Figma-style)
            const groupPromoted = new Set<number>();
            for (const id of nodesInRect) {
                if (this.scene.getNodeLocked(id) || !this.scene.getNodeVisible(id)) continue;
                // Walk up to find topmost group ancestor
                let promoted = id;
                let current = id;
                while (true) {
                    const parentId = this.scene.getNodeParent(current);
                    if (parentId < 0) break; // no parent (root)
                    const parentNode = this.scene.getNode(parentId);
                    if (parentNode && parentNode.node_type === 'Group') {
                        promoted = parentId;
                    }
                    current = parentId;
                }
                groupPromoted.add(promoted);
            }
            for (const id of groupPromoted) {
                this.scene.selectNode(id, true);
            }
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
        }

        // Commit shape creation (use previewRect which already has Shift/Alt constraints applied)
        if (this.previewRect && (this.previewRect.w > 5 || this.previewRect.h > 5)) {
            const { x, y, w, h, tool } = this.previewRect;

            let newId: number | undefined;
            if (tool === 'rect') {
                newId = this.scene.addRect(x, y, w, h);
            } else if (tool === 'ellipse') {
                newId = this.scene.addEllipse(x + w / 2, y + h / 2, w / 2, h / 2);
            } else if (tool === 'polygon') {
                newId = this.scene.addPolygon(x + w / 2, y + h / 2, Math.max(w, h) / 2, 6);
            } else if (tool === 'star') {
                const r = Math.max(w, h) / 2;
                newId = this.scene.addStar(x + w / 2, y + h / 2, r, r * 0.4, 5);
            }

            // Apply the current UI style and select the new shape
            if (newId !== undefined) {
                this.scene.setNodeStyleNoHistory(newId, this.ui.getCurrentStyle());
                this.scene.engine!.clear_selection();
                this.scene.selectNode(newId, false);
                this.ui.syncWithSelection();
            }
            this.ui.updateLayerList();
        }

        this.dragMode = 'none';
        this.previewRect = null;
        this.marqueeRect = null;
    }

    /** Union of the selected nodes' world bounds, or null if nothing is selected. */
    getSelectionBounds(): { x: number; y: number; w: number; h: number } | null {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return null;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const id of selection) {
            const b = this.scene.getNodeBounds(id);
            minX = Math.min(minX, b[0]);
            minY = Math.min(minY, b[1]);
            maxX = Math.max(maxX, b[2]);
            maxY = Math.max(maxY, b[3]);
        }
        if (minX === Infinity) return null;
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    checkResizeHandle(pos: { x: number; y: number }): { type: string } | null {
        const bounds = this.getSelectionBounds();
        if (!bounds) return null;

        const minX = bounds.x, minY = bounds.y;
        const maxX = bounds.x + bounds.w, maxY = bounds.y + bounds.h;
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
                return { type: h.type };
            }
        }
        return null;
    }

    /** 
     * Find the node that should be selected given a hit position and the current selection.
     * This implements "context-aware" selection: if you are inside a group, you select 
     * siblings/children of that group. If not, you select the topmost group.
     */
    private getTargetIdForHit(pos: { x: number; y: number }): number | undefined {
        const rawHitId = this.scene.hitTest(pos.x, pos.y);
        if (rawHitId === undefined) return undefined;

        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) {
            // Nothing selected: return topmost group ancestor
            return this.scene.hitTestGrouped(pos.x, pos.y);
        }

        // We have a selection. Let's see if the raw hit is "inside" the current context.
        // A common context is the parent of the first selected item.
        const contextParentId = this.scene.getNodeParent(selection[0]);
        
        if (contextParentId === -1) {
            // Selected item is at root. Default to topmost group.
            return this.scene.hitTestGrouped(pos.x, pos.y);
        }

        // Walk up from rawHitId to see if it's a descendant of contextParentId.
        // We want to pick the child of contextParentId that contains the hit.
        let current = rawHitId;
        while (current !== -1) {
            const p = this.scene.getNodeParent(current);
            if (p === contextParentId) {
                return current;
            }
            current = p;
        }

        // Hit is outside current context. Fall back to topmost group.
        return this.scene.hitTestGrouped(pos.x, pos.y);
    }
}
