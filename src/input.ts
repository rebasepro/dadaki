import type { DocumentManager } from './document_manager';
import type { FileService } from './file_service';
import { DEFAULT_TEXT_FONT, ensureFontCSS, loadGoogleFontData } from './fonts';
import { outlineStroke } from './outline_stroke';
import {
    addAnchorPoint,
    findNearestSegment,
    joinSubpaths,
    mergeSelectedAnchors,
    type SegmentHitResult,
    splitPathAtPoint,
    splitPathAtSegment,
} from './path_ops';
import type { ArtboardHandle, Renderer } from './renderer';
import { SnapEngine, type SnapGuide } from './snapping';
import { textNodeToSubpaths } from './text_outlines';
import type { Artboard, PathPoint, PenPathPoint, Subpath } from './types';
import type { UIEngine } from './ui';
import type { WasmScene } from './wasm_scene';

/** 2D affine matrix in DOMMatrix convention: x' = a·x + c·y + e, y' = b·x + d·y + f. */
interface Mat {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

/** Cache of measured CSS first-line baseline offsets (em), keyed by font style. */
const _cssBaselineCache = new Map<string, number>();
/**
 * Measure where CSS puts a font's first-line baseline, as a fraction of the font
 * size below the line box's top. Used to align the inline text overlay's glyphs
 * with the rendered ones. Cached per font signature (a hidden-DOM measure).
 */
function measureCssBaselineEm(
    fontFamily: string,
    fontWeight: string,
    fontStyle: string,
    lineHeight: number,
): number {
    const key = `${fontFamily}|${fontWeight}|${fontStyle}|${lineHeight}`;
    const cached = _cssBaselineCache.get(key);
    if (cached !== undefined) return cached;
    const size = 100; // measure at a large size for precision
    const probe = document.createElement('div');
    probe.style.cssText =
        `position:absolute;visibility:hidden;left:-9999px;top:-9999px;white-space:pre;` +
        `font-family:${fontFamily};font-weight:${fontWeight};font-style:${fontStyle};` +
        `font-size:${size}px;line-height:${lineHeight};`;
    probe.textContent = 'Hg';
    const marker = document.createElement('span');
    marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
    probe.appendChild(marker);
    document.body.appendChild(probe);
    const em = (marker.getBoundingClientRect().top - probe.getBoundingClientRect().top) / size;
    document.body.removeChild(probe);
    _cssBaselineCache.set(key, em);
    return em;
}

/** Oriented selection frame: the rect (0,0)–(w,h) in frame space, mapped to
 *  world by `m`. For a single node this is its local bounds under its world
 *  transform (so it rotates/skews with the shape); for multi-selection it is
 *  the axis-aligned union (m = pure translation). */
export interface SelectionFrame {
    w: number;
    h: number;
    m: Mat;
}

/** Resolved scissors cut target: either an existing anchor or a point on a
 *  segment, on a specific path node. Produced by {@link InputManager.findScissorTarget}. */
interface ScissorTarget {
    nodeId: number;
    subpaths: Subpath[];
    /** Set when the closest target is an existing anchor point. */
    anchor?: { subpathIndex: number; pointIndex: number };
    /** Set when the closest target is a point along a segment. */
    segment?: SegmentHitResult;
    /** World-space location of the cut (for the hover preview dot). */
    worldX: number;
    worldY: number;
    /** World-space distance from the cursor to the cut location. */
    distance: number;
}

/** Tools that snap their origin point, so they also get a pre-drag snap
 *  preview (guides shown while hovering, before the drag starts). */
const HOVER_SNAP_TOOLS = new Set(['line', 'rect', 'ellipse', 'polygon', 'star', 'artboard', 'pen']);

export class InputManager {
    canvas: HTMLCanvasElement;
    scene: WasmScene;
    ui: UIEngine;
    renderer: Renderer;
    /** Assigned by main.ts after construction; routes ⌘S/⌘⇧S. */
    fileService: FileService | null = null;
    /** Assigned by main.ts; owns open/new/close/cycle across tabs. */
    documentManager: DocumentManager | null = null;
    /** Assigned by main.ts; opens the export dialog (⇧⌘E). */
    openExportDialog: (() => void) | null = null;
    isMouseDown: boolean;
    startPos: { x: number; y: number };
    currentPos: { x: number; y: number };

    /** The currently-open inline text overlay (edit or create), or null. */
    private activeTextOverlay: { commit: () => void } | null = null;
    /** Recomputes the active overlay's screen position/size; called on view change. */
    private repositionOverlay: (() => void) | null = null;

    dragMode: 'move' | 'marquee' | 'none' = 'none';
    /** Active artboard move/resize drag (UI-level; engine nodes untouched). */
    private artboardDrag: {
        id: number;
        mode: 'move' | 'resize';
        handle: ArtboardHandle | null;
        start: { x: number; y: number; w: number; h: number };
        startWorld: { x: number; y: number };
        /** Top-level nodes contained in the artwork at drag start — they travel
         *  with the frame on a move (empty for resize). */
        contained: number[];
        /** Cumulative delta already applied to `contained` this drag. */
        movedDx: number;
        movedDy: number;
    } | null = null;
    /** Whether any actual movement happened during a drag. */
    didMove: boolean = false;
    /** Live preview rect in world coords, read by Renderer each frame. */
    previewRect: { x: number; y: number; w: number; h: number; tool: string } | null = null;
    /** Live line-tool preview (start → end) in world coords, read by Renderer. */
    previewLine: { x1: number; y1: number; x2: number; y2: number } | null = null;
    /** Freehand pencil-tool samples in world coords, read by Renderer each frame. */
    pencilPoints: { x: number; y: number }[] | null = null;
    /** Accumulated pen-tool anchor points for the current path being drawn. */
    currentPathPoints: PenPathPoint[] = [];
    isDraggingHandle: boolean = false;
    /** Marquee selection rect in world coords, read by Renderer each frame. */
    marqueeRect: { x: number; y: number; w: number; h: number } | null = null;
    clipboardIds: number[] = [];
    /** Figma-style artwork clipboard: a frame descriptor plus its contained
     *  top-level node ids, captured on copy. When set, it takes precedence over
     *  `clipboardIds` on paste (and is cleared when plain nodes are copied). */
    private artboardClipboard: { ab: Artboard; nodeIds: number[] } | null = null;

    // --- Modifier key state (updated every mousemove) ---
    shiftKey: boolean = false;
    altKey: boolean = false;
    metaKey: boolean = false;
    ctrlKey: boolean = false;

    /** Last mousemove event, so a modifier keypress mid-drag can reapply the
     *  transform at the current cursor without waiting for the next mouse move. */
    private lastMouseEvent: MouseEvent | null = null;

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
    /**
     * True while Alt-dragging an anchor to pull out (or reset) its bezier
     * handles — the "convert anchor point" gesture. Forces symmetric handle
     * mirroring even though Alt is held (which normally breaks the tangent),
     * and turns a zero-distance click into a handle-collapse (smooth→corner).
     */
    convertingAnchor: boolean = false;
    /** Transform of the node being edited (for world<->local conversion). */
    editingTransform: Float32Array | null = null;
    /** Set of selected points in the format "subpathIndex:pointIndex" */
    selectedPoints: Set<string> = new Set();
    /** The selected anchor index in path editing (for delete point). */
    selectedAnchorSubpath: number = -1;
    selectedAnchorIndex: number = -1;
    /** The segment currently under the cursor in edit mode. */
    hoverSegment: { subpathIndex: number; segmentIndex: number } | null = null;

    // --- Path operation state ---
    /** True when Add Point mode is active (next click on segment adds a point). */
    addPointMode: boolean = false;
    /** World-space point on nearest segment for scissors/add-point hover preview. */
    scissorsHoverPoint: { x: number; y: number } | null = null;

    // --- Resize handle state ---
    resizeHandleType: string | null = null; // 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', or null
    resizeStartBounds: { x: number; y: number; w: number; h: number } | null = null;
    /** Deduped selection ids captured at resize start (ancestors only, no double-scaling). */
    resizeTargetIds: number[] = [];
    /** Snapshot of the scene state before resize started, so we can restore and reapply cleanly. */
    resizeSnapshot: Uint8Array | null = null;
    /** Current calculated bounds during a resize drag, read by Renderer for smooth sticky handles. */
    liveResizeBounds: { x: number; y: number; w: number; h: number } | null = null;
    /** Non-null while resizing a rotated/skewed frame — switches to the oriented pipeline. */
    resizeFrame: SelectionFrame | null = null;
    /** Local bounds of the single oriented-resize target, captured at drag start. */
    private resizeLocalBounds: { x: number; y: number; w: number; h: number } | null = null;
    /** Live oriented frame during an oriented resize drag, read by the Renderer. */
    liveFrame: SelectionFrame | null = null;

    // --- Corner radius handle state ---
    cornerRadiusDragging: {
        nodeId: number;
        startRadius: number;
        startPos: { x: number; y: number };
    } | null = null;

    // --- Gradient handle state ---
    /** True while dragging an on-canvas gradient handle (ui.gradientEdit owns the details). */
    gradientDragActive: boolean = false;

    // --- Rotate handle state ---
    /** Which corner the rotation drag grabbed ('nw'|'ne'|'se'|'sw'), or null when not rotating. */
    rotateHandleType: string | null = null;
    /** Deduped selection ids captured at rotate start (ancestors only, no double-rotation). */
    rotateTargetIds: number[] = [];
    /** Snapshot of the scene before rotation started, restored & reapplied each frame. */
    rotateSnapshot: Uint8Array | null = null;
    /** World-space pivot the selection rotates about (selection-bounds center). */
    rotatePivot: { x: number; y: number } | null = null;
    /** Angle (radians) from pivot to the cursor at drag start, the zero reference. */
    rotateStartAngle: number = 0;
    /** Start rotation of a single selected node (deg), used for 15° absolute snapping. */
    rotateSingleStartDeg: number | null = null;
    /** Cached angle-oriented cursor data URIs (rotate + resize arrows), keyed by kind:angle. */
    private cursorCache: Record<string, string> = {};

    // --- Arrow key nudge grouping state ---
    /** Timer that fires after 500ms of no nudging, to finalise the grouped nudge undo step. */
    private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    /** True while a nudge sequence is in progress (history was already saved at the start). */
    private nudgeInProgress: boolean = false;

    constructor(canvas: HTMLCanvasElement, scene: WasmScene, ui: UIEngine, renderer: Renderer) {
        this.canvas = canvas;
        this.scene = scene;
        this.ui = ui;
        this.renderer = renderer;

        this.isMouseDown = false;
        this.startPos = { x: 0, y: 0 };
        this.currentPos = { x: 0, y: 0 };

        // Keep an open inline text overlay glued over the glyphs when the view
        // transform changes (zoom/pan while editing).
        this.renderer.onViewChange(() => this.repositionOverlay?.());

        this.init();
    }

    init() {
        // Helper: wrap handler to request a render frame after every interaction
        const withRender =
            <E extends Event>(handler: (e: E) => void) =>
            (e: E) => {
                handler.call(this, e);
                this.renderer.requestRender();
            };

        this.canvas.addEventListener(
            'mousedown',
            withRender((e: MouseEvent) => this.onMouseDown(e)),
        );
        this.canvas.addEventListener(
            'dblclick',
            withRender((e: MouseEvent) => this.onDoubleClick(e)),
        );
        this.canvas.addEventListener('contextmenu', (e) => this.onContextMenu(e));
        // Clear any hover snap-preview guides when the pointer leaves the canvas.
        this.canvas.addEventListener(
            'mouseleave',
            withRender(() => {
                if (!this.isMouseDown && this.activeSnapGuides.length) this.activeSnapGuides = [];
            }),
        );
        window.addEventListener(
            'mousemove',
            withRender((e: MouseEvent) => this.onMouseMove(e)),
        );
        window.addEventListener(
            'mouseup',
            withRender((e: MouseEvent) => this.onMouseUp(e)),
        );
        window.addEventListener(
            'keydown',
            withRender((e: KeyboardEvent) => this.onKeyDown(e)),
        );
        window.addEventListener(
            'keyup',
            withRender((e: KeyboardEvent) => this.onKeyUp(e)),
        );
        window.addEventListener(
            'wheel',
            withRender((e: WheelEvent) => this.onWheel(e)),
            { passive: false, capture: true },
        );

        // Import .svg / .dataki / .vec files by dropping them onto the canvas area
        const dropTarget = document.getElementById('canvas-container') ?? this.canvas;
        dropTarget.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });
        dropTarget.addEventListener('drop', (e) => {
            this.onFileDrop(e).catch(console.error);
        });

        // Safari pinch-to-zoom prevention (page zoom would fight canvas zoom)
        window.addEventListener('gesturestart', (e) => e.preventDefault(), { capture: true });
        window.addEventListener('gesturechange', (e) => e.preventDefault(), { capture: true });
        window.addEventListener('gestureend', (e) => e.preventDefault(), { capture: true });
    }

    /** Import dropped files: .svg content is centered at the drop point and
     *  selected; .dataki and .vec replace the document (undoable — a history snapshot is
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
                // parseSVG rasterizes patterns (async) then runs the import as ONE
                // undo step; the afterImport callback runs inside that transaction.
                await this.ui.parseSVG(text, (newRoots) => {
                    // Center the imported nodes at the drop point and select them
                    if (newRoots.length === 0) return;
                    let minX = Infinity,
                        minY = Infinity,
                        maxX = -Infinity,
                        maxY = -Infinity;
                    for (const id of newRoots) {
                        const b = this.scene.getNodeBounds(id);
                        minX = Math.min(minX, b[0]);
                        minY = Math.min(minY, b[1]);
                        maxX = Math.max(maxX, b[2]);
                        maxY = Math.max(maxY, b[3]);
                    }
                    if (minX < maxX && minY < maxY) {
                        const dx = dropWorld.x - (minX + maxX) / 2;
                        const dy = dropWorld.y - (minY + maxY) / 2;
                        for (const id of newRoots) this.scene.engine!.move_node(id, dx, dy);
                    }
                    this.scene.engine!.clear_selection();
                    for (const id of newRoots) this.scene.selectNode(id, true);
                });
            } else if (name.endsWith('.dataki') || name.endsWith('.vec')) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                this.scene.saveMoveHistory(); // snapshot current doc so the drop is undoable
                this.scene.engine.deserialize_proto(bytes);
                this.scene.renderer?.clearImageCache(); // ids may map to new bytes
            } else if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/.test(name)) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                // Natural pixel size (fallback to a square if decode fails).
                const bmp = await createImageBitmap(file).catch(() => null);
                let w = bmp?.width ?? 200;
                let h = bmp?.height ?? 200;
                bmp?.close?.();
                // Cap to 50% of the document so huge photos don't fill the canvas.
                const docW = this.scene.engine.get_document_width();
                const docH = this.scene.engine.get_document_height();
                const scale = Math.min(1, (docW * 0.5) / w, (docH * 0.5) / h);
                w *= scale;
                h *= scale;
                const id = this.scene.placeImage(
                    bytes,
                    file.type || 'image/png',
                    dropWorld.x,
                    dropWorld.y,
                    w,
                    h,
                );
                this.scene.engine.clear_selection();
                this.scene.selectNode(id, false);
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
                this.scene.transaction(() => {
                    for (const id of selection) this.scene.bringToFront(id);
                });
                break;
            case 'bring-forward':
                this.scene.transaction(() => {
                    for (const id of selection) this.scene.bringForward(id);
                });
                break;
            case 'send-backward':
                this.scene.transaction(() => {
                    for (const id of selection) this.scene.sendBackward(id);
                });
                break;
            case 'send-to-back':
                this.scene.transaction(() => {
                    for (const id of selection) this.scene.sendToBack(id);
                });
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
            case 'make-live-paint':
                this.makeLivePaintGroup();
                break;
            case 'expand-live-paint':
                this.expandLivePaintGroup(selection[0]);
                break;
            case 'flatten':
                void this.flattenSelection();
                break;
            case 'toggle-mask':
                this.toggleMaskSelection();
                break;
        }
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.hideContextMenu();
    }

    onDoubleClick(e: MouseEvent) {
        const pos = this.getPos(e);
        const hitId = this.scene.hitTest(pos.x, pos.y); // raw hit (deepest leaf)
        if (hitId === undefined) {
            // Double-click on empty canvas: leave node-editing mode
            if (this.editingNodeId !== null) {
                this.exitEditMode();
                this.ui.setActiveTool('selection');
            }
            return;
        }

        // Double-click into a Live Paint group → enter paint mode on it, rather
        // than drilling into the group's children.
        const lpGroup = this.findLivePaintAncestor(hitId);
        if (lpGroup !== null) {
            this.enterLivePaintGroup(lpGroup);
            return;
        }

        // Check if the currently selected node is a group
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 1) {
            const selectedNode = this.scene.getNode(selection[0]);
            if (selectedNode && selectedNode.node_type === 'Group') {
                // Double-click on a group → drill down ONE level:
                // Find the direct child of this group that is (or contains) the hit leaf
                const targetChild = this.findDirectChildContaining(selection[0], hitId);
                if (targetChild !== undefined) {
                    this.scene.selectNode(targetChild, false);
                    this.ui.syncWithSelection();
                    this.ui.updateLayerList();
                    return;
                }
            }
        }

        const node = this.scene.getNode(hitId);
        if (!node) return;

        // Double-click on text: edit its content inline
        if (node.geometry.Text) {
            this.scene.selectNode(hitId, false);
            this.ui.syncWithSelection();
            this.editTextNode(hitId);
            return;
        }

        // Double-click on any other leaf shape enters node-editing (direct
        // selection) mode. enterPathEditMode converts Rect/Ellipse to an
        // editable Path; corner radii carry over per-vertex, so this is
        // non-destructive.
        this.ui.setActiveTool('direct');
        this.scene.selectNode(hitId, false);
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
        this.enterPathEditMode(hitId);
    }

    /**
     * Walk from `leafId` up the parent chain toward `groupId`, returning the
     * direct child of `groupId` that is an ancestor of (or is) `leafId`.
     * This enables progressive drill-down through nested groups.
     */
    private findDirectChildContaining(groupId: number, leafId: number): number | undefined {
        let current = leafId;
        while (current !== -1) {
            const parentId = this.scene.getNodeParent(current);
            if (parentId === groupId) {
                return current; // `current` is a direct child of the selected group
            }
            if (parentId === -1) break; // reached root without finding groupId
            current = parentId;
        }
        return undefined;
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
        if (updatedGeometry?.Path) {
            this.editingNodeId = nodeId;
            this.editingPoints = JSON.parse(JSON.stringify(updatedGeometry.Path.subpaths));
            this.editingTransform = this.scene.getTransform(nodeId);
            this.ui.updateLayerList();
            this.ui.contextBar?.refresh();
        }
    }

    /** Exit path/text editing mode and clear dimming on all exit paths. Idempotent:
     *  safe to call when not editing. The single sanctioned way to leave edit mode —
     *  clears all per-edit state and refreshes the panel so the scene un-dims. */
    exitEditMode() {
        if (this.editingNodeId === null) return;
        this.editingNodeId = null;
        this.editingPoints = null;
        this.editingTransform = null;
        this.selectedPoints.clear();
        this.selectedAnchorSubpath = -1;
        this.selectedAnchorIndex = -1;
        this.addPointMode = false;
        // syncWithSelection refreshes the property panel + context/breadcrumb bars
        // and requests a render, which recomputes dimming (now un-dimmed).
        this.ui.syncWithSelection();
    }

    /** Dim target for the renderer. Self-heals if the edited node no longer exists
     *  (e.g. removed by undo or delete outside the normal exit paths). */
    getEditingDimTarget(): number | null {
        if (this.editingNodeId === null) return null;
        if (this.scene.getNodeType(this.editingNodeId) === undefined) {
            this.exitEditMode();
            return null;
        }
        return this.editingNodeId;
    }

    onKeyDown(e: KeyboardEvent) {
        // Don't handle shortcuts when typing in form elements or contenteditable
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if ((e.target as HTMLElement)?.isContentEditable) return;

        // ⌘/Ctrl toggles snapping: clear the hover snap-preview the instant it's
        // held, without needing a mouse move.
        if (e.key === 'Meta' || e.key === 'Control') {
            this.metaKey = e.metaKey;
            this.ctrlKey = e.ctrlKey;
            this.updateHoverSnapPreview(e.metaKey || e.ctrlKey);
            this.updatePenHover();
        }

        // Alt/Shift pressed mid-drag must reapply the transform immediately.
        this.reapplyDragForModifiers(e);

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

        // Tool shortcuts — plain letters only; ⇧letter is reserved for actions (flip etc.)
        if (!e.metaKey && !e.ctrlKey) {
            if (!e.shiftKey) {
                if (e.key === 'v' || e.key === 'V') this.ui.setActiveTool('selection');
                if (e.key === 'a' || e.key === 'A') this.ui.setActiveTool('artboard');
                if (e.key === 'p' || e.key === 'P') this.ui.setActiveTool('pen');
                if (e.key === 'n' || e.key === 'N') this.ui.setActiveTool('pencil');
                if (e.key === 'l' || e.key === 'L') this.ui.setActiveTool('line');
                if (e.key === 'r' || e.key === 'R') this.ui.setActiveTool('rect');
                if (e.key === 'o' || e.key === 'O') this.ui.setActiveTool('ellipse');

                if (e.key === 'b' || e.key === 'B') this.ui.setActiveTool('paint-bucket');
                if (e.key === 'c' || e.key === 'C') this.ui.setActiveTool('scissors');
                if (e.key === 't' || e.key === 'T') this.ui.setActiveTool('text');
            }

            // Shift+H / Shift+V: flip selection in place
            if (e.shiftKey && (e.key === 'H' || e.key === 'h')) this.flipSelection('h');
            if (e.shiftKey && (e.key === 'V' || e.key === 'v')) this.flipSelection('v');

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

        // Delete — in path editing mode, delete the selected anchor point(s);
        // with a gradient stop focused, delete the stop instead of the node.
        if (e.key === 'Backspace' || e.key === 'Delete') {
            if (this.editingNodeId !== null && this.selectedPoints.size > 0) {
                this.deleteSelectedPoints();
            } else if (this.ui.gradientEdit.isActive() && this.ui.gradientEdit.stopFocused) {
                if (this.ui.gradientEdit.deleteStop(this.ui.gradientEdit.stopIndex)) {
                    this.ui.syncWithSelection();
                }
            } else if (this.renderer.selectedArtboardId !== null) {
                // An artwork is selected → delete it.
                this.deleteSelectedArtboard();
            } else {
                this.deleteSelection();
            }
        }

        // Cmd+J / Ctrl+J: in node editing with 2+ points selected, merge them;
        // otherwise join the two selected path nodes.
        if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
            e.preventDefault();
            if (this.editingNodeId !== null && this.selectedPoints.size >= 2) {
                this.mergeSelectedPoints();
            } else {
                this.joinSelectedPaths();
            }
        }

        // Add point toggle: + key in path edit mode
        if (e.key === '+' || e.key === '=') {
            if (this.editingNodeId !== null && !e.metaKey && !e.ctrlKey) {
                this.addPointMode = !this.addPointMode;
                this.ui.contextBar?.refresh();
                return;
            }
        }

        // Undo: Cmd+Z / Ctrl+Z
        if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            if (this.editingNodeId !== null) this.exitEditMode();
            this.scene.undo();
            this.ui.updateLayerList();
            this.ui.syncWithSelection();
        }

        // Redo: Cmd+Shift+Z / Ctrl+Shift+Z
        if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
            e.preventDefault();
            if (this.editingNodeId !== null) this.exitEditMode();
            this.scene.redo();
            this.ui.updateLayerList();
            this.ui.syncWithSelection();
        }

        // Save: Cmd+S / Ctrl+S
        if ((e.metaKey || e.ctrlKey) && e.key === 's' && !e.shiftKey) {
            e.preventDefault();
            this.fileService?.saveActive().catch(console.error);
        }

        // Save As: Cmd+Shift+S / Ctrl+Shift+S
        if ((e.metaKey || e.ctrlKey) && e.key === 's' && e.shiftKey) {
            e.preventDefault();
            this.fileService?.saveActiveAs().catch(console.error);
        }

        // Create Outlines: Cmd+Shift+O / Ctrl+Shift+O (selected text nodes → paths)
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
            e.preventDefault();
            const textIds = Array.from(this.scene.engine!.get_selection()).filter(
                (id) => this.scene.getNode(id)?.node_type === 'Text',
            );
            for (const id of textIds) void this.createOutlines(id);
        }

        // Open (in a new tab): Cmd+O / Ctrl+O
        if ((e.metaKey || e.ctrlKey) && e.key === 'o' && !e.shiftKey) {
            e.preventDefault();
            if (this.documentManager) this.documentManager.openFromPicker().catch(console.error);
            else this.fileService?.openIntoActive().catch(console.error);
        }

        // New document: Cmd+Alt+N / Ctrl+Alt+N (Cmd+N is browser-reserved)
        if (
            (e.metaKey || e.ctrlKey) &&
            e.altKey &&
            (e.key === 'n' || e.key === 'ñ' || e.code === 'KeyN')
        ) {
            e.preventDefault();
            this.documentManager?.create();
        }

        // Close tab: Cmd+Alt+W / Ctrl+Alt+W (Cmd+W is browser-reserved)
        if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyW') {
            e.preventDefault();
            const active = this.documentManager?.active();
            if (active) this.documentManager!.close(active.id);
        }

        // Cycle tabs: Cmd+Alt+←/→
        if (
            (e.metaKey || e.ctrlKey) &&
            e.altKey &&
            (e.code === 'ArrowRight' || e.code === 'ArrowLeft')
        ) {
            e.preventDefault();
            this.documentManager?.cycle(e.code === 'ArrowRight' ? 1 : -1);
        }

        // Export: Cmd+Shift+E / Ctrl+Shift+E — opens the export dialog.
        if ((e.metaKey || e.ctrlKey) && e.key === 'e' && e.shiftKey) {
            e.preventDefault();
            if (this.openExportDialog) this.openExportDialog();
            else this.ui.exportSVG();
        }

        // Escape: cancel in-flight drag → unfocus gradient stop → exit path edit → exit group → deselect
        if (e.key === 'Escape') {
            if (this.isMouseDown && this.gradientDragActive) {
                this.gradientDragActive = false;
                this.isMouseDown = false; // swallow the drag; onMouseUp early-returns
                this.ui.gradientEdit.cancelDrag();
                this.ui.syncWithSelection();
                return;
            }
            if (
                this.isMouseDown &&
                (this.moveSnapshot ||
                    this.resizeSnapshot ||
                    this.previewRect ||
                    this.previewLine ||
                    this.pencilPoints ||
                    this.marqueeRect)
            ) {
                this.cancelActiveDrag();
                return;
            }
            if (this.ui.gradientEdit.stopFocused) {
                this.ui.gradientEdit.stopFocused = false;
                return;
            }
            if (this.editingNodeId !== null) {
                // Exit direct editing mode
                this.exitEditMode();
                this.ui.setActiveTool('selection');
            } else if (this.currentPathPoints.length > 0) {
                // Commit the in-progress pen path, matching Figma/Illustrator: Escape
                // finalizes what you've drawn rather than throwing it away. Points
                // you've placed are real geometry, so a stray Escape must not be a
                // data-loss footgun. finalizePenPath only creates a path when there
                // are ≥2 points; a lone anchor (a degenerate path) is just cleared.
                // The Context Bar's Cancel button remains the explicit discard action.
                this.finalizePenPath();
            } else if (this.ui.activeTool !== 'selection') {
                // Disarm armed creation/drawing tool back to Selection
                this.ui.setActiveTool('selection');
            } else {
                // Check if we're inside a group — if so, select the parent group instead of clearing
                const selection = this.scene.engine!.get_selection();
                if (selection.length > 0) {
                    const parentId = this.scene.getNodeParent(selection[0]);
                    const parentNode = parentId >= 0 ? this.scene.getNode(parentId) : null;

                    if (parentNode && parentNode.node_type === 'Group') {
                        // Snapshot the current state BEFORE exiting the group
                        // so that Ctrl+Z can revert back into the group context
                        // with the element in its pre-move position.
                        this.scene.pushHistorySnapshot();
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

        // Enter: finalize pen path → finish path editing → enter group / edit selected object
        if (e.key === 'Enter') {
            if (this.currentPathPoints.length > 0) {
                this.finalizePenPath();
            } else if (this.editingNodeId !== null) {
                e.preventDefault();
                this.exitEditMode();
                this.ui.setActiveTool('selection');
            } else {
                const selection = this.scene.engine!.get_selection();
                if (selection.length === 1) {
                    e.preventDefault();
                    this.enterSelectedNode(selection[0]);
                }
            }
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

        // Cmd+E / Ctrl+E: flatten selection
        if ((e.metaKey || e.ctrlKey) && e.key === 'e' && !e.shiftKey) {
            e.preventDefault();
            void this.flattenSelection();
        }

        // Arrow key nudging — consecutive presses within 500ms are grouped
        // into a single undo step so Ctrl+Z reverts the whole sequence at once.
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            const selection = this.scene.engine!.get_selection();
            if (selection.length > 0) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                let dx = 0,
                    dy = 0;
                if (e.key === 'ArrowLeft') dx = -step;
                if (e.key === 'ArrowRight') dx = step;
                if (e.key === 'ArrowUp') dy = -step;
                if (e.key === 'ArrowDown') dy = step;

                // Save history only at the START of a nudge sequence
                if (!this.nudgeInProgress) {
                    this.scene.saveMoveHistory();
                    this.nudgeInProgress = true;
                }

                // Reset the debounce timer on every keypress
                if (this.nudgeTimer !== null) {
                    clearTimeout(this.nudgeTimer);
                }
                this.nudgeTimer = setTimeout(() => {
                    this.nudgeInProgress = false;
                    this.nudgeTimer = null;
                }, 500);

                for (const id of selection) {
                    this.scene.moveNode(id, dx, dy);
                }
                this.scene.invalidateCache();
                this.ui.syncWithSelection();
            }
        }

        // Cmd+C: Copy — a selected artwork copies as a frame + its contents,
        // otherwise the selected nodes.
        if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
            const abId = this.renderer.selectedArtboardId;
            const ab =
                abId !== null ? this.scene.getArtboards().find((a) => a.id === abId) : undefined;
            if (ab) {
                this.artboardClipboard = {
                    ab: { ...ab, background: { ...ab.background } },
                    nodeIds: this.artboardContainedRoots(ab),
                };
                this.clipboardIds = [];
            } else {
                this.clipboardIds = [...this.scene.engine!.get_selection()];
                this.artboardClipboard = null;
            }
        }

        // Cmd+V: Paste (duplicate from clipboard)
        if ((e.metaKey || e.ctrlKey) && e.key === 'v' && !e.shiftKey) {
            if (this.artboardClipboard) {
                e.preventDefault();
                this.pasteArtboard();
            } else if (this.clipboardIds.length > 0) {
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

        // Cmd+Alt+X: Make Live Paint (Illustrator's Object › Live Paint › Make).
        // Uses e.code because Alt+X emits a special glyph on macOS.
        if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyX') {
            if (this.scene.engine!.get_selection().length > 0) {
                e.preventDefault();
                this.makeLivePaintGroup();
            }
        }
    }

    /** Commit (close) the active inline text overlay, if one is open. Safe to
     *  call unconditionally — a no-op when nothing is being edited. Used to
     *  tear the overlay down on tool switch, document load, etc. */
    commitActiveTextEdit() {
        this.activeTextOverlay?.commit();
    }

    /**
     * Spawn an inline `<textarea>` overlay for editing text on the canvas,
     * shared by double-click edit and text-tool creation. The box is kept glued
     * over the glyphs: `reposition()` recomputes screen position, font size and
     * letter-spacing from the *current* view transform, and is re-run on every
     * view change (see the onViewChange subscription in the constructor) and on
     * every keystroke (auto-size). Only one overlay is open at a time.
     */
    private spawnTextOverlay(opts: {
        /** World-space top-left of the text box (maps to the overlay's left/top). */
        world: { x: number; y: number };
        fontSize: number; // world units
        fontFamily: string; // CSS font-family stack
        fontWeight?: string; // CSS
        fontStyle?: string; // 'normal' | 'italic'
        letterSpacing?: number; // world units
        lineHeight: number;
        color: string;
        value: string;
        placeholder?: string;
        /** Content (trailing newlines stripped) on Enter/blur. */
        onCommit: (content: string) => void;
        onCancel?: () => void;
        /** Always runs when the overlay closes (commit or cancel). */
        onTeardown?: () => void;
    }) {
        const container = document.getElementById('canvas-container');
        if (!container) return;
        // Only one overlay at a time — commit any previous one first.
        this.commitActiveTextEdit();

        const fam = opts.fontFamily;
        const fontWeight = opts.fontWeight ?? '400';
        const fontStyleCss = opts.fontStyle ?? 'normal';
        const lsWorld = opts.letterSpacing ?? 0;

        const input = document.createElement('textarea');
        input.className = 'text-input-overlay';
        input.value = opts.value;
        if (opts.placeholder) input.placeholder = opts.placeholder;
        input.spellcheck = false;
        input.rows = 1; // so scrollHeight reflects content, not the 2-row default
        Object.assign(input.style, {
            fontFamily: fam,
            fontWeight,
            fontStyle: fontStyleCss,
            lineHeight: String(opts.lineHeight),
            color: opts.color,
            padding: '0',
            border: 'none',
            margin: '0',
            background: 'transparent',
            resize: 'none',
            overflow: 'hidden',
            whiteSpace: 'pre',
            minWidth: '0',
            minHeight: '0',
            outline: '1px solid var(--accent)',
        } as Partial<CSSStyleDeclaration>);

        // Baseline correction: the renderer draws the glyphs with their baseline
        // one em below the box top (drawTextBlob at the local origin), but CSS
        // places the first-line baseline higher (ascent + half-leading). Measure
        // the CSS offset for this exact font and nudge the text down so the
        // overlay glyphs sit on the same baseline as the rendered ones.
        const cssBaselineEm = measureCssBaselineEm(fam, fontWeight, fontStyleCss, opts.lineHeight);
        const baselineCorrectionEm = Math.max(0, 1 - cssBaselineEm);

        const measureCtx = document.createElement('canvas').getContext('2d')!;
        // Recompute screen position, font size, letter-spacing and box size from
        // the current view transform. Runs on open, on every view change, and on
        // every keystroke, so the box stays glued over the glyphs at any zoom/pan.
        const reposition = () => {
            const zoom = this.renderer.zoom;
            input.style.left = `${opts.world.x * zoom + this.renderer.pan.x}px`;
            input.style.top = `${opts.world.y * zoom + this.renderer.pan.y}px`;
            input.style.fontSize = `${opts.fontSize * zoom}px`;
            input.style.letterSpacing = `${lsWorld * zoom}px`;
            input.style.paddingTop = `${baselineCorrectionEm * opts.fontSize * zoom}px`;
            // Auto-size to the widest line × line count at the current zoom.
            measureCtx.font = `${fontStyleCss} ${fontWeight} ${opts.fontSize * zoom}px ${fam}`;
            const text = input.value || input.placeholder || '';
            let w = 0;
            for (const line of text.split('\n'))
                w = Math.max(w, measureCtx.measureText(line).width);
            input.style.width = `${Math.ceil(w) + 2}px`;
            input.style.height = 'auto';
            input.style.height = `${input.scrollHeight}px`;
        };
        input.addEventListener('input', reposition);

        let done = false;
        const teardown = () => {
            this.activeTextOverlay = null;
            this.repositionOverlay = null;
            input.remove();
            opts.onTeardown?.();
        };
        const commit = () => {
            if (done) return;
            done = true;
            const content = input.value.replace(/\n+$/, '');
            teardown();
            opts.onCommit(content);
        };
        const cancel = () => {
            if (done) return;
            done = true;
            teardown();
            opts.onCancel?.();
        };

        input.addEventListener('keydown', (ev: KeyboardEvent) => {
            // Enter commits; Shift+Enter (or Cmd/Ctrl+Enter) inserts a newline.
            if (ev.key === 'Enter' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
                ev.preventDefault();
                commit();
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                cancel();
            }
            ev.stopPropagation();
        });
        input.addEventListener('blur', commit);

        this.activeTextOverlay = { commit };
        this.repositionOverlay = reposition;

        container.appendChild(input);
        reposition();
        input.focus();
        input.select();
    }

    /** Open an inline editor over an existing text node (double-click). */
    editTextNode(id: number) {
        const geo = this.scene.getNodeGeometry(id);
        if (!geo?.Text) return;

        const t = this.scene.getTransform(id); // row-major: t[2]/t[5] = translation
        const fontSize = geo.Text.font_size;
        const originalContent = geo.Text.content;
        const fam = geo.Text.font_family ? `${geo.Text.font_family}, sans-serif` : 'sans-serif';
        // Match the node's fill colour so the overlay looks like the real text.
        const node = this.scene.getNode(id);
        const f = node?.style?.fills?.[0] as
            | { r: number; g: number; b: number; a?: number }
            | undefined;
        const color =
            f && 'r' in f
                ? `rgba(${Math.round(f.r * 255)},${Math.round(f.g * 255)},${Math.round(f.b * 255)},${f.a ?? 1})`
                : '#000';
        if (geo.Text.font_family) ensureFontCSS(geo.Text.font_family);

        // Hide the underlying node while its overlay stands in (no more doubling).
        this.renderer.editingTextId = id;
        this.renderer.requestRender();

        this.spawnTextOverlay({
            // The paragraph renders with its top at (tx, ty - fontSize); place the
            // overlay's box there so it sits exactly over the rendered glyphs.
            world: { x: t[2], y: t[5] - fontSize },
            fontSize,
            fontFamily: fam,
            fontWeight: String(geo.Text.font_weight || 400),
            fontStyle: geo.Text.italic ? 'italic' : 'normal',
            letterSpacing: geo.Text.letter_spacing || 0,
            lineHeight: geo.Text.line_height || 1.2,
            color,
            value: originalContent,
            onCommit: (content) => {
                if (!content) {
                    // Emptied → delete the node (Figma behaviour), single undo step.
                    this.scene.removeNode(id);
                    this.ui.updateLayerList();
                    this.ui.syncWithSelection();
                } else if (content !== originalContent) {
                    this.scene.setTextContent(id, content, fontSize);
                    this.ui.syncWithSelection();
                }
            },
            onTeardown: () => {
                this.renderer.editingTextId = null;
                this.renderer.requestRender();
            },
        });
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
        this.previewLine = null;
        this.pencilPoints = null;
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
        // Releasing ⌘/Ctrl re-enables snapping: bring the hover preview back
        // immediately, without waiting for a mouse move.
        if (e.key === 'Meta' || e.key === 'Control') {
            this.metaKey = e.metaKey;
            this.ctrlKey = e.ctrlKey;
            this.updateHoverSnapPreview(e.metaKey || e.ctrlKey);
            this.updatePenHover();
        }
        this.reapplyDragForModifiers(e);
    }

    /** Alt/Shift/Cmd/Ctrl change the outcome of an in-progress resize, rotate,
     *  or move (resize-from-center, aspect lock, clone, axis constraint, snap
     *  bypass). Those paths only re-evaluate on mouse movement, so a modifier
     *  pressed or released while the cursor is still would otherwise not take
     *  effect until the next move. Replay the last mousemove with the updated
     *  modifier state so the transform updates the instant the key changes. */
    private reapplyDragForModifiers(e: KeyboardEvent) {
        if (!this.isMouseDown || !this.lastMouseEvent) return;
        if (e.key !== 'Alt' && e.key !== 'Shift' && e.key !== 'Meta' && e.key !== 'Control') return;
        const dragActive = this.resizeSnapshot || this.rotateSnapshot || this.moveSnapshot;
        if (!dragActive) return;
        const src = this.lastMouseEvent;
        const synthetic = {
            clientX: src.clientX,
            clientY: src.clientY,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
        } as MouseEvent;
        this.onMouseMove(synthetic);
    }

    getPos(e: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        return {
            x: (screenX - this.renderer.pan.x) / this.renderer.zoom,
            y: (screenY - this.renderer.pan.y) / this.renderer.zoom,
        };
    }

    /** Recompute the pre-drag snap-preview guides for the current hover position.
     *  Called from mousemove AND from ⌘/Ctrl key changes, so the guides appear or
     *  clear the instant the modifier is pressed/released — not only on movement. */
    updateHoverSnapPreview(bypassed: boolean) {
        if (this.isMouseDown) return;
        const want =
            HOVER_SNAP_TOOLS.has(this.ui.activeTool) && this.editingNodeId === null && !bypassed;
        if (want) {
            this.snap.begin(this.scene, []);
            const s = this.snap.snapPoint(
                this.currentPos.x,
                this.currentPos.y,
                8 / this.renderer.zoom,
            );
            this.snap.end();
            this.activeSnapGuides = s.guides;
        } else if (this.activeSnapGuides.length) {
            this.activeSnapGuides = [];
        }
    }

    /** Recompute the pen rubber-band hover position and close-affordance from
     *  the last mouse position. Called on mouse move AND on ⌘/Ctrl press/release
     *  (via the key handlers) so the close ring and snapping toggle instantly
     *  with the modifier — no mouse move required. */
    updatePenHover() {
        if (this.isMouseDown || this.ui.activeTool !== 'pen') {
            if (this.penHoverPos !== null) {
                this.penHoverPos = null;
                this.penHoverClosing = false;
            }
            if (this.penHoverAdopt !== null) this.penHoverAdopt = null;
            return;
        }
        // Cmd/Ctrl bypasses snapping and, with it, closing on the first anchor.
        const bypass = this.metaKey || this.ctrlKey;
        let hp = this.currentPos;
        if (!bypass) {
            this.snap.begin(this.scene, []);
            const s = this.snap.snapPoint(hp.x, hp.y, 8 / this.renderer.zoom);
            this.snap.end();
            hp = { x: s.x, y: s.y };
        }
        this.penHoverPos = hp;
        this.penHoverClosing = false;
        this.penHoverAdopt = null;
        if (!bypass && this.currentPathPoints.length > 1) {
            const first = this.currentPathPoints[0];
            const d = Math.hypot(hp.x - first.x, hp.y - first.y);
            this.penHoverClosing = d < InputManager.PEN_CLOSE_RADIUS / this.renderer.zoom;
        } else if (!bypass && this.currentPathPoints.length === 0) {
            // Idle pen: highlight an existing open endpoint a click would continue.
            const hit = this.findAdoptableEndpoint(hp);
            if (hit) {
                const sp = this.scene.getNodeGeometry(hit.nodeId)?.Path?.subpaths[hit.subpathIndex];
                if (sp) {
                    const p = hit.end === 'start' ? sp.points[0] : sp.points[sp.points.length - 1];
                    const t = this.scene.getTransform(hit.nodeId);
                    const [wx, wy] = this.penLocalToWorld(t, p.x, p.y);
                    this.penHoverAdopt = { x: wx, y: wy };
                }
            }
        }
        this.canvas.style.cursor = 'crosshair';
    }

    onWheel(e: WheelEvent) {
        // Only handle wheel events when the target is the canvas or its container
        const container = document.getElementById('canvas-container');
        if (!container?.contains(e.target as Node)) return;

        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (e.ctrlKey || e.metaKey) {
            const factor = 0.99 ** e.deltaY;
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
        this.renderer.notifyViewChange();
    }

    // ─── Artboard interaction (UI-level; engine node selection untouched) ────

    /** Select an artboard: clear node selection, highlight it, refresh panel. */
    selectArtboard(id: number) {
        if (this.editingNodeId !== null) this.exitEditMode();
        this.scene.engine!.clear_selection();
        this.renderer.selectedArtboardId = id;
        this.ui.syncWithSelection();
        this.ui.refreshArtboardPanel();
        // In-place highlight (no rebuild) so double-click-to-rename survives.
        this.ui.updateLayerSelection();
        this.renderer.requestRender();
    }

    deselectArtboard() {
        this.renderer.selectedArtboardId = null;
        this.ui.refreshArtboardPanel();
        this.ui.updateLayerSelection();
        this.renderer.requestRender();
    }

    /** Delete the currently-selected artwork (frame) together with everything
     *  inside it — a single undo restores the frame and all its contents. */
    deleteSelectedArtboard() {
        const id = this.renderer.selectedArtboardId;
        if (id === null) return;
        const ab = this.scene.getArtboards().find((a) => a.id === id);
        const contained = ab ? this.artboardContainedRoots(ab) : [];
        // If a contained node is being path-edited, leave edit mode first.
        if (this.editingNodeId !== null && contained.includes(this.editingNodeId)) {
            this.exitEditMode();
        }
        this.scene.transaction(() => {
            for (const nid of contained) this.scene.engine!.remove_node(nid);
            this.scene.engine!.remove_artboard(id);
        });
        this.renderer.selectedArtboardId = null;
        this.ui.refreshArtboardPanel();
        this.ui.updateLayerList();
        this.renderer.requestRender();
    }

    // ─── Artwork ↔ contents membership (geometric, Figma-style) ──────────────
    // Artboards are a scene-level list, not nodes, so there is no parent/child
    // link to the shapes drawn inside them. Membership is resolved on demand:
    // a top-level node belongs to a frame when its bounding-box center lies
    // within the frame's rect. This set is captured at the moment of an action
    // (move / delete / copy) and then stays fixed for that action.

    /** World-space AABB of a node including all descendants, or null when it has
     *  no spatial geometry. Groups aren't in the engine R-tree, so their bounds
     *  are unioned from their leaf descendants. */
    private nodeWorldBounds(
        id: number,
    ): { minX: number; minY: number; maxX: number; maxY: number } | null {
        const children = this.scene.getNodeChildren(id);
        if (children.length === 0) {
            const b = this.scene.getNodeBounds(id); // [minX, minY, maxX, maxY]
            // The engine returns all-zeros for a node with no spatial entry.
            if (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0) return null;
            return { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] };
        }
        let acc: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
        for (const c of children) {
            const cb = this.nodeWorldBounds(c);
            if (!cb) continue;
            acc = acc
                ? {
                      minX: Math.min(acc.minX, cb.minX),
                      minY: Math.min(acc.minY, cb.minY),
                      maxX: Math.max(acc.maxX, cb.maxX),
                      maxY: Math.max(acc.maxY, cb.maxY),
                  }
                : cb;
        }
        return acc;
    }

    /** Top-level nodes whose center lies within the artwork's rect — the set
     *  that moves/deletes/copies with the frame. */
    private artboardContainedRoots(ab: Artboard): number[] {
        const out: number[] = [];
        for (const id of this.scene.getRootNodes()) {
            const b = this.nodeWorldBounds(id);
            if (!b) continue;
            const cx = (b.minX + b.maxX) / 2;
            const cy = (b.minY + b.maxY) / 2;
            if (cx >= ab.x && cx <= ab.x + ab.w && cy >= ab.y && cy <= ab.y + ab.h) {
                out.push(id);
            }
        }
        return out;
    }

    /** Create a copy of an artwork — the frame plus the given contained nodes —
     *  offset by (ox, oy). MUST run inside a scene.transaction(). Returns the new
     *  frame's id. */
    private cloneArtboard(ab: Artboard, nodeIds: number[], ox: number, oy: number): number {
        const eng = this.scene.engine!;
        const newId = eng.add_artboard(ab.x + ox, ab.y + oy, ab.w, ab.h);
        eng.set_artboard_name(newId, `${ab.name} copy`);
        const bg = ab.background;
        eng.set_artboard_background(newId, bg.r, bg.g, bg.b, bg.a);
        for (const nid of nodeIds) {
            const clone = eng.duplicate_node(nid); // has a built-in +20,+20 offset
            eng.move_node(clone, ox - 20, oy - 20); // re-align to exactly (ox, oy)
        }
        return newId;
    }

    /** Paste the copied artwork (frame + contents) as a new frame beside the
     *  original. */
    private pasteArtboard() {
        const clip = this.artboardClipboard;
        if (!clip) return;
        let newId = -1;
        this.scene.transaction(() => {
            this.scene.engine!.clear_selection();
            newId = this.cloneArtboard(clip.ab, clip.nodeIds, clip.ab.w + 40, 0);
        });
        this.selectArtboard(newId);
        this.ui.updateLayerList();
    }

    /** Duplicate the selected artwork in place (Cmd+D / context-menu Duplicate). */
    private duplicateSelectedArtboard() {
        const id = this.renderer.selectedArtboardId;
        if (id === null) return;
        const ab = this.scene.getArtboards().find((a) => a.id === id);
        if (!ab) return;
        const nodeIds = this.artboardContainedRoots(ab);
        let newId = -1;
        this.scene.transaction(() => {
            this.scene.engine!.clear_selection();
            newId = this.cloneArtboard(ab, nodeIds, ab.w + 40, 0);
        });
        this.selectArtboard(newId);
        this.ui.updateLayerList();
    }

    private beginArtboardDrag(id: number, mode: 'move' | 'resize', handle: ArtboardHandle | null) {
        const ab = this.scene.getArtboards().find((a) => a.id === id);
        if (!ab) return;
        // On a move, the shapes inside the frame travel with it; capture them now.
        const contained = mode === 'move' ? this.artboardContainedRoots(ab) : [];
        this.artboardDrag = {
            id,
            mode,
            handle,
            start: { x: ab.x, y: ab.y, w: ab.w, h: ab.h },
            startWorld: { ...this.startPos },
            contained,
            movedDx: 0,
            movedDy: 0,
        };
        // Snap to other shapes/artboards. Exclude this frame's own edges and its
        // contained shapes (they move with the frame, so snapping to their start
        // positions would fight the drag).
        this.snap.begin(this.scene, contained, id);
        this.scene.beginGesture(); // coalesce the whole drag into one undo step
    }

    private updateArtboardDrag() {
        const d = this.artboardDrag;
        if (!d) return;
        const dx = this.currentPos.x - d.startWorld.x;
        const dy = this.currentPos.y - d.startWorld.y;
        let { x, y, w, h } = d.start;
        const MIN = 1;
        const thr = 8 / this.renderer.zoom;
        const snapOff = this.metaKey || this.ctrlKey; // Cmd/Ctrl bypasses snapping
        this.activeSnapGuides = [];

        if (d.mode === 'move') {
            x += dx;
            y += dy;
            if (!snapOff) {
                const s = this.snap.snapBounds({ x, y, w, h }, thr);
                x += s.dx;
                y += s.dy;
                this.activeSnapGuides = s.guides;
            }
        } else {
            const hnd = d.handle!;
            if (hnd.includes('e')) w = Math.max(MIN, d.start.w + dx);
            if (hnd.includes('s')) h = Math.max(MIN, d.start.h + dy);
            if (hnd.includes('w')) {
                w = Math.max(MIN, d.start.w - dx);
                x = d.start.x + (d.start.w - w);
            }
            if (hnd.includes('n')) {
                h = Math.max(MIN, d.start.h - dy);
                y = d.start.y + (d.start.h - h);
            }
            // Snap the moving edge(s) to targets.
            if (!snapOff) {
                if (hnd.includes('e')) {
                    const s = this.snap.snapAxis('x', x + w, thr);
                    if (s) {
                        w = Math.max(MIN, s.value - x);
                        this.activeSnapGuides.push(s.guide);
                    }
                }
                if (hnd.includes('w')) {
                    const s = this.snap.snapAxis('x', x, thr);
                    if (s) {
                        const right = x + w;
                        x = Math.min(s.value, right - MIN);
                        w = right - x;
                        this.activeSnapGuides.push(s.guide);
                    }
                }
                if (hnd.includes('s')) {
                    const s = this.snap.snapAxis('y', y + h, thr);
                    if (s) {
                        h = Math.max(MIN, s.value - y);
                        this.activeSnapGuides.push(s.guide);
                    }
                }
                if (hnd.includes('n')) {
                    const s = this.snap.snapAxis('y', y, thr);
                    if (s) {
                        const bottom = y + h;
                        y = Math.min(s.value, bottom - MIN);
                        h = bottom - y;
                        this.activeSnapGuides.push(s.guide);
                    }
                }
            }
        }
        this.scene.setArtboardBounds(d.id, x, y, w, h);
        // Drag the contained shapes by the same cumulative delta (move only).
        if (d.mode === 'move' && d.contained.length > 0) {
            const totalDx = x - d.start.x;
            const totalDy = y - d.start.y;
            const stepDx = totalDx - d.movedDx;
            const stepDy = totalDy - d.movedDy;
            if (stepDx !== 0 || stepDy !== 0) {
                for (const nid of d.contained) this.scene.engine!.move_node(nid, stepDx, stepDy);
                this.scene.invalidateCache();
                d.movedDx = totalDx;
                d.movedDy = totalDy;
            }
        }
        this.ui.refreshArtboardPanel();
    }

    private endArtboardDrag() {
        if (!this.artboardDrag) return;
        this.artboardDrag = null;
        this.snap.end();
        this.activeSnapGuides = [];
        this.scene.endGesture();
        this.ui.refreshArtboardPanel();
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
        // Hide the pen rubber-band while a press is in progress.
        this.penHoverPos = null;
        this.penHoverClosing = false;
        this.penHoverAdopt = null;

        // Space held (or middle mouse): pan the viewport instead of using the tool
        if (this.isSpacePan || e.button === 1) {
            e.preventDefault();
            this.panDrag = {
                screenX: e.clientX,
                screenY: e.clientY,
                panX: this.renderer.pan.x,
                panY: this.renderer.pan.y,
            };
            this.canvas.style.cursor = 'grabbing';
            return;
        }

        if (this.ui.activeTool === 'selection') {
            // Artboard chrome (resize handles + name labels). UI-level only —
            // engine node selection is untouched. Only when not path-editing.
            if (this.editingNodeId === null) {
                const abResize =
                    this.renderer.selectedArtboardId !== null
                        ? this.renderer.artboardHandleHitTest(this.startPos.x, this.startPos.y)
                        : null;
                if (abResize) {
                    this.beginArtboardDrag(abResize.id, 'resize', abResize.handle);
                    return;
                }
                const abLabel = this.renderer.artboardLabelHitTest(
                    this.startPos.x,
                    this.startPos.y,
                );
                if (abLabel !== null) {
                    this.selectArtboard(abLabel);
                    this.beginArtboardDrag(abLabel, 'move', null);
                    return;
                }
                // Clicked outside any artboard chrome — clear artboard selection.
                if (this.renderer.selectedArtboardId !== null) this.deselectArtboard();
            }

            // Gradient handles take priority over resize/rotate while a
            // gradient fill is being edited (skip in node-editing mode)
            if (this.editingNodeId === null && this.ui.gradientEdit.isActive()) {
                const gHit = this.ui.gradientEdit.hitTest(this.startPos, this.renderer.zoom);
                if (gHit) {
                    if (gHit.type === 'insert') {
                        this.ui.gradientEdit.beginInsertDrag(gHit.t, this.startPos);
                    } else {
                        this.ui.gradientEdit.beginDrag(gHit, this.startPos);
                    }
                    this.gradientDragActive = true;
                    this.ui.syncWithSelection({ interactive: true });
                    return;
                }
            }

            // Check resize handles first (skip in node-editing mode)
            const frame = this.editingNodeId === null ? this.getSelectionFrame() : null;
            const handle = frame ? this.checkResizeHandle(this.startPos, frame) : null;
            if (handle && frame) {
                this.resizeHandleType = handle.type;
                this.resizeTargetIds = Array.from(
                    this.scene.dedupSelection(this.scene.engine!.get_selection()),
                );
                // Snapshot scene state so we can restore-then-resize each frame
                this.resizeSnapshot = this.scene.engine!.serialize_scene();
                // A single text node always uses the oriented pipeline: its
                // resize scales the font size from the JS-measured text bounds
                // (the engine has no font metrics, so the legacy world-space
                // path would use bad bounds).
                const singleText =
                    this.resizeTargetIds.length === 1 &&
                    this.scene.getNodeType(this.resizeTargetIds[0]) === 4;
                if (this.frameIsAxisAligned(frame) && !singleText) {
                    // Legacy world-space pipeline (with snapping)
                    this.resizeStartBounds = this.getSelectionBounds();
                    this.snap.begin(this.scene, this.resizeTargetIds);
                } else {
                    // Oriented pipeline: drag in the frame's own axes (single node)
                    this.resizeFrame = frame;
                    this.resizeLocalBounds = this.getNodeLocalBounds(this.resizeTargetIds[0]);
                }
                this.scene.saveMoveHistory();
                return;
            }

            // Check corner radius handles (skip in node-editing mode)
            const crHandle =
                this.editingNodeId === null ? this.checkCornerRadiusHandle(this.startPos) : null;
            if (crHandle) {
                const node = this.scene.getNode(crHandle.nodeId);
                if (node) {
                    this.cornerRadiusDragging = {
                        nodeId: crHandle.nodeId,
                        startRadius: node.style.corner_radius || 0,
                        startPos: { ...this.startPos },
                    };
                    this.scene.saveMoveHistory();
                    return;
                }
            }

            // Check rotate zone (just outside a corner handle; skip in node-editing mode)
            const rotateHandle = frame ? this.checkRotateHandle(this.startPos, frame) : null;
            if (rotateHandle && frame) {
                this.rotateHandleType = rotateHandle.type;
                this.rotatePivot = this.framePoint(frame, frame.w / 2, frame.h / 2);
                this.rotateStartAngle = Math.atan2(
                    this.startPos.y - this.rotatePivot.y,
                    this.startPos.x - this.rotatePivot.x,
                );
                this.rotateTargetIds = Array.from(
                    this.scene.dedupSelection(this.scene.engine!.get_selection()),
                );
                this.rotateSingleStartDeg =
                    this.rotateTargetIds.length === 1
                        ? this.scene.getNodeTransformComponents(this.rotateTargetIds[0])
                              .rotation_deg
                        : null;
                this.rotateSnapshot = this.scene.engine!.serialize_scene();
                this.scene.saveMoveHistory();
                this.canvas.style.cursor = this.rotateCursorForCorner(rotateHandle.type, frame);
                return;
            }

            const isDeepSelect = e.metaKey || e.ctrlKey;
            const hitId = this.getTargetIdForHit(this.startPos, isDeepSelect);
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
            this.handleDirectDown(this.startPos, e.shiftKey, e.altKey);
        } else if (this.ui.activeTool === 'pen') {
            // Snap new anchors to geometry unless Cmd/Ctrl bypasses snapping.
            // The same modifier also suppresses closing on the first anchor, so
            // you can place a point right on top of the start without closing.
            const bypassSnap = e.metaKey || e.ctrlKey;
            if (!bypassSnap) {
                this.snap.begin(this.scene, []);
                const s = this.snap.snapPoint(
                    this.startPos.x,
                    this.startPos.y,
                    8 / this.renderer.zoom,
                );
                this.startPos = { x: s.x, y: s.y };
                this.snap.end();
            }
            this.handlePenDown(this.startPos, bypassSnap);
        } else if (this.ui.activeTool === 'text') {
            // Create an inline text overlay at the click point, using the same
            // glued/auto-sizing overlay as double-click editing.
            // Suppress the default mousedown focus change: the canvas is
            // focusable (tabindex="-1"), so without this the browser refocuses
            // it right after this handler, blurring — and thus committing and
            // removing — the textarea we're about to focus below.
            e.preventDefault();
            const worldX = this.startPos.x;
            const worldY = this.startPos.y; // overlay box top = click point
            const fontSize = 32;
            // Load the default text font so the overlay preview (CSS) and the
            // committed node (CanvasKit) render the same typeface. Fire-and-forget:
            // the renderer repaints via onFontLoaded once the TTF arrives.
            ensureFontCSS(DEFAULT_TEXT_FONT);
            loadGoogleFontData(DEFAULT_TEXT_FONT);
            this.spawnTextOverlay({
                world: { x: worldX, y: worldY },
                fontSize,
                fontFamily: `${DEFAULT_TEXT_FONT}, sans-serif`,
                lineHeight: 1.2,
                color: '#000',
                value: '',
                placeholder: 'Type text…',
                onCommit: (content) => {
                    if (!content.trim()) return; // empty → don't create a node
                    this.scene.saveMoveHistory();
                    // The paragraph renders with its top at (origin.y - fontSize);
                    // offset the origin so the glyphs land where the box was.
                    const id = this.scene.addText(worldX, worldY + fontSize, content, fontSize);
                    // Assign the same family the overlay previewed so the on-canvas
                    // render matches (no extra undo entry — addText already saved one).
                    this.scene.setTextPropertiesNoHistory(id, DEFAULT_TEXT_FONT, 0, 1.2);
                    // Text defaults to a solid black fill and no stroke. The active
                    // fill (often a light shape color) or the engine default (white)
                    // would be invisible against a white artboard; black is the
                    // expected, readable default for text.
                    const style = JSON.parse(this.ui.getCurrentStyle());
                    style.fills = [{ r: 0, g: 0, b: 0, a: 1 }];
                    style.strokes = [];
                    this.scene.setNodeStyleNoHistory(id, JSON.stringify(style));
                    this.scene.engine!.clear_selection();
                    this.scene.selectNode(id, false);
                    this.ui.updateLayerList();
                    this.ui.syncWithSelection();
                    // One-shot: back to Selection like the shape tools, unless
                    // the text tool was locked (double-click) for multiple adds.
                    this.maybeRevertTool();
                },
            });
        } else if (
            this.ui.activeTool === 'rect' ||
            this.ui.activeTool === 'ellipse' ||
            this.ui.activeTool === 'polygon' ||
            this.ui.activeTool === 'star' ||
            this.ui.activeTool === 'artboard'
        ) {
            // Snap the anchor corner unless Cmd/Ctrl bypasses snapping
            this.snap.begin(this.scene, []);
            if (!e.metaKey && !e.ctrlKey) {
                const s = this.snap.snapPoint(
                    this.startPos.x,
                    this.startPos.y,
                    8 / this.renderer.zoom,
                );
                this.startPos = { x: s.x, y: s.y };
            }
            this.previewRect = {
                x: this.startPos.x,
                y: this.startPos.y,
                w: 0,
                h: 0,
                tool: this.ui.activeTool,
            };
        } else if (this.ui.activeTool === 'line') {
            // Snap the anchor endpoint unless Cmd/Ctrl bypasses snapping.
            this.snap.begin(this.scene, []);
            if (!e.metaKey && !e.ctrlKey) {
                const s = this.snap.snapPoint(
                    this.startPos.x,
                    this.startPos.y,
                    8 / this.renderer.zoom,
                );
                this.startPos = { x: s.x, y: s.y };
            }
            this.previewLine = {
                x1: this.startPos.x,
                y1: this.startPos.y,
                x2: this.startPos.x,
                y2: this.startPos.y,
            };
        } else if (this.ui.activeTool === 'pencil') {
            this.pencilPoints = [{ x: this.startPos.x, y: this.startPos.y }];
        } else if (this.ui.activeTool === 'paint-bucket') {
            this.handlePaintBucketClick(this.startPos, e.altKey);
        } else if (this.ui.activeTool === 'scissors') {
            this.handleScissorsDown(this.startPos);
        }
    }

    handlePaintBucketClick(pos: { x: number; y: number }, wantEdge = false) {
        if (!this.scene.engine) return;
        const edgeTol = 6 / this.renderer.zoom;
        const paintEdge = () => {
            const id = this.scene.queryEdgeAt(pos.x, pos.y, edgeTol);
            if (id < 0) return false;
            const c = this.ui.getLivePaintStroke();
            this.scene.setEdgePaint(id, c.r, c.g, c.b, c.a, this.activeStrokeWidth());
            return true;
        };
        // Filling a region is the primary action. Only paint an edge when the
        // user explicitly Alt-clicks — otherwise a click a few px from a boundary
        // would paint a near-invisible line instead of filling the region.
        if (wantEdge && paintEdge()) return;

        const faceId = this.scene.engine.query_face_at(pos.x, pos.y);
        if (faceId >= 0) {
            const c = this.ui.getLivePaintFill();
            this.scene.setFaceFill(faceId, c.r, c.g, c.b, c.a);
            return;
        }
        // Clicked outside every region (e.g. on the outline itself) → the nearest
        // edge is the sensible target so clicking a lone outline still paints.
        paintEdge();
    }

    /** Current default stroke width from the active style (fallback 2). */
    private activeStrokeWidth(): number {
        try {
            const s = JSON.parse(this.ui.getCurrentStyle());
            const w = s?.strokes?.[0]?.width;
            if (typeof w === 'number' && w > 0) return w;
        } catch {
            /* fall through */
        }
        return 2;
    }

    handleDirectDown(pos: { x: number; y: number }, isShift: boolean, isAlt = false) {
        // First: if we're already editing a node, check if clicking on one of its points/handles
        if (this.editingNodeId !== null && this.editingPoints) {
            // Add Point mode: clicking on a segment inserts a new anchor
            if (this.addPointMode) {
                if (this.handleAddPointClick(pos)) return;
            }

            const hitInfo = this.findNearestHandle(pos);
            if (hitInfo) {
                const pointKey = `${hitInfo.subpathIndex}:${hitInfo.index}`;

                // Alt on an anchor is the "convert anchor point" gesture: drag
                // pulls out symmetric handles (corner→smooth); a zero-distance
                // click collapses them (smooth→corner, handled on mouse-up).
                // Alt on a *handle* falls through to the normal path below where
                // it breaks the tangent during the drag.
                if (isAlt && hitInfo.type === 'anchor') {
                    this.selectedPoints.clear();
                    this.selectedPoints.add(pointKey);
                    this.selectedAnchorSubpath = hitInfo.subpathIndex;
                    this.selectedAnchorIndex = hitInfo.index;
                    this.draggingSubpathIndex = hitInfo.subpathIndex;
                    this.draggingPointIndex = hitInfo.index;
                    // Pull the outgoing handle; the incoming one mirrors it.
                    this.draggingHandleType = 'cp2';
                    this.convertingAnchor = true;
                    this.scene.saveMoveHistory();
                    this.ui.contextBar?.refresh();
                    return;
                }

                if (hitInfo.type === 'anchor') {
                    if (isShift) {
                        if (this.selectedPoints.has(pointKey)) {
                            this.selectedPoints.delete(pointKey);
                        } else {
                            this.selectedPoints.add(pointKey);
                            this.selectedAnchorSubpath = hitInfo.subpathIndex;
                            this.selectedAnchorIndex = hitInfo.index;
                        }
                    } else {
                        if (!this.selectedPoints.has(pointKey)) {
                            this.selectedPoints.clear();
                            this.selectedPoints.add(pointKey);
                        }
                        this.selectedAnchorSubpath = hitInfo.subpathIndex;
                        this.selectedAnchorIndex = hitInfo.index;
                    }
                } else {
                    // Control point clicked: usually deselects others unless it's the current point's handles
                    if (!isShift) this.selectedPoints.clear();
                    this.selectedPoints.add(pointKey);
                    this.selectedAnchorSubpath = hitInfo.subpathIndex;
                    this.selectedAnchorIndex = hitInfo.index;
                }

                this.draggingSubpathIndex = hitInfo.subpathIndex;
                this.draggingPointIndex = hitInfo.index;
                this.draggingHandleType = hitInfo.type;
                this.scene.saveMoveHistory();
                this.ui.contextBar?.refresh();
                return;
            } else {
                // Clicked empty space in edit mode — start marquee for points
                if (!isShift) {
                    this.selectedPoints.clear();
                    this.selectedAnchorSubpath = -1;
                    this.selectedAnchorIndex = -1;
                    this.ui.contextBar?.refresh();
                }

                // Hit test to see if we're clicking ANOTHER node
                const hitId = this.scene.hitTest(pos.x, pos.y);
                if (hitId !== undefined && hitId !== this.editingNodeId) {
                    this.scene.selectNode(hitId, isShift);
                    this.ui.syncWithSelection();
                    this.ui.updateLayerList();
                    this.enterPathEditMode(hitId);
                    return;
                }

                // Otherwise, start point marquee
                this.dragMode = 'marquee'; // Reuse marquee mode, will handle in onMouseMove
                this.marqueeRect = { x: pos.x, y: pos.y, w: 0, h: 0 };
                return;
            }
        }

        // Not in edit mode yet: hit test to find a node
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
                    const pointKey = `${hitInfo.subpathIndex}:${hitInfo.index}`;
                    this.selectedPoints.add(pointKey);
                    this.selectedAnchorSubpath = hitInfo.subpathIndex;
                    this.selectedAnchorIndex = hitInfo.index;
                    this.scene.saveMoveHistory();
                    this.ui.contextBar?.refresh();
                }
            }
        } else {
            // Clicked empty space outside any node — deselect everything and exit edit mode
            if (!isShift) {
                this.exitEditMode();
                this.scene.engine!.clear_selection();
                this.ui.syncWithSelection();
                this.ui.updateLayerList();
            }
        }
    }

    findNearestHandle(pos: {
        x: number;
        y: number;
    }): { subpathIndex: number; index: number; type: 'anchor' | 'cp1' | 'cp2' } | null {
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
        const a = t[0],
            b = t[1],
            c = t[2];
        const d = t[3],
            e = t[4],
            f = t[5];
        const det = a * e - b * d;
        if (Math.abs(det) < 1e-10) return { x: wx, y: wy };
        return {
            x: (e * (wx - c) - b * (wy - f)) / det,
            y: (a * (wy - f) - d * (wx - c)) / det,
        };
    }

    /**
     * Convert a world-space delta vector into a node's parent local space.
     * move_node applies dx/dy directly to the node's local transform, so we
     * need to compensate for the parent group's cumulative transform (scale,
     * rotation, skew). Without this, dragging a deeply nested element makes
     * it lag behind the cursor because the world-space delta is larger/smaller
     * than the local-space delta.
     *
     * For a delta *vector* (not a point) we only invert the linear part (2×2
     * upper-left of the 3×3 matrix), ignoring translation.
     */
    worldDeltaToLocal(nodeId: number, wdx: number, wdy: number): { dx: number; dy: number } {
        const parentId = this.scene.engine!.get_node_parent(nodeId);
        if (parentId < 0) {
            // Node is at root level — world space == local space
            return { dx: wdx, dy: wdy };
        }
        // getTransform returns the row-major global transform:
        //   [scaleX, skewX, transX,  skewY, scaleY, transY,  p0, p1, p2]
        const t = this.scene.getTransform(parentId);
        const a = t[0],
            b = t[1]; // row0: scaleX, skewX
        const d = t[3],
            e = t[4]; // row1: skewY,  scaleY
        const det = a * e - b * d;
        if (Math.abs(det) < 1e-10) return { dx: wdx, dy: wdy };
        return {
            dx: (e * wdx - b * wdy) / det,
            dy: (-d * wdx + a * wdy) / det,
        };
    }

    /** Flip every selected node in place (⇧H / ⇧V and the context bar flip buttons). */
    flipSelection(axis: 'h' | 'v') {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;
        for (const id of selection) {
            if (axis === 'h') this.scene.flipNodeH(id);
            else this.scene.flipNodeV(id);
        }
        this.scene.invalidateCache();
        this.ui.syncWithSelection();
    }

    /** Enter (⏎): drill into a group, or open the type-appropriate edit mode. */
    enterSelectedNode(id: number) {
        const node = this.scene.getNode(id);
        if (!node) return;
        switch (node.node_type) {
            case 'Group': {
                const children = Array.from(this.scene.getNodeChildren(id));
                if (children.length > 0) {
                    this.scene.selectNode(children[0], false);
                    this.ui.syncWithSelection();
                    this.ui.updateLayerList();
                }
                break;
            }
            case 'Text':
                this.editTextNode(id);
                break;
            case 'Rect':
            case 'Ellipse':
            case 'Path':
                this.ui.setActiveTool('direct');
                this.enterPathEditMode(id);
                break;
        }
    }

    duplicateSelection() {
        // A selected artwork duplicates as a frame + its contents.
        if (this.renderer.selectedArtboardId !== null) {
            this.duplicateSelectedArtboard();
            return;
        }
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
        // If the deleted node was the editing node, exit edit mode first
        if (this.editingNodeId !== null && selection.includes(this.editingNodeId)) {
            this.exitEditMode();
        }
        this.scene.engine!.clear_selection();
        this.scene.removeNodes(selection);
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    // ─── Path Operations ─────────────────────────────────────────────

    /**
     * Find the closest scissors cut target across every visible path node near
     * `pos`, or `null` if nothing is within the catch radius.
     *
     * Unlike a fill/stroke hit test, this snaps to the path *outline* directly:
     * candidate nodes are gathered from the spatial index by a threshold-sized
     * box around the cursor, then each is measured with the full catch radius.
     * An existing anchor wins over a segment point at (near-)equal distance so
     * clicking on a vertex splits there. Both the hover preview and the click
     * handler use this, so the previewed dot always matches where the cut lands.
     */
    findScissorTarget(pos: { x: number; y: number }): ScissorTarget | null {
        if (!this.scene.engine) return null;
        const threshold = 10 / this.renderer.zoom;

        const ids = this.scene.getVisibleNodes(
            pos.x - threshold,
            pos.y - threshold,
            pos.x + threshold,
            pos.y + threshold,
        );

        let best: ScissorTarget | null = null;

        for (const id of ids) {
            const geo = this.scene.getNodeGeometry(id);
            if (!geo?.Path) continue;
            const subpaths = geo.Path.subpaths;
            const transform = this.scene.getTransform(id);

            // Prefer snapping to an existing anchor within the catch radius.
            for (let si = 0; si < subpaths.length; si++) {
                const sp = subpaths[si];
                for (let pi = 0; pi < sp.points.length; pi++) {
                    const p = sp.points[pi];
                    const wx = transform[0] * p.x + transform[1] * p.y + transform[2];
                    const wy = transform[3] * p.x + transform[4] * p.y + transform[5];
                    const d = Math.hypot(pos.x - wx, pos.y - wy);
                    if (d < threshold && (!best || d < best.distance)) {
                        best = {
                            nodeId: id,
                            subpaths,
                            anchor: { subpathIndex: si, pointIndex: pi },
                            worldX: wx,
                            worldY: wy,
                            distance: d,
                        };
                    }
                }
            }

            // Otherwise fall back to the nearest point along a segment. Uses a
            // strict `<` so an equidistant anchor (checked above) keeps priority.
            const segHit = findNearestSegment(subpaths, transform, pos.x, pos.y, threshold);
            if (segHit && (!best || segHit.distance < best.distance)) {
                best = {
                    nodeId: id,
                    subpaths,
                    segment: segHit,
                    worldX: segHit.worldX,
                    worldY: segHit.worldY,
                    distance: segHit.distance,
                };
            }
        }

        return best;
    }

    /** Apply a resolved scissors cut, pushing an undo snapshot and refreshing UI. */
    private applyScissorCut(target: ScissorTarget) {
        this.scene.saveMoveHistory();
        const newSubpaths = target.anchor
            ? splitPathAtPoint(
                  target.subpaths,
                  target.anchor.subpathIndex,
                  target.anchor.pointIndex,
              )
            : splitPathAtSegment(
                  target.subpaths,
                  target.segment!.subpathIndex,
                  target.segment!.segmentIndex,
                  target.segment!.t,
              );
        this.scene.updatePathPoints(target.nodeId, JSON.stringify(newSubpaths));
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
    }

    /** Handle scissors tool click — cut path at segment or anchor. */
    handleScissorsDown(pos: { x: number; y: number }) {
        if (!this.scene.engine) return;

        // Primary path: cut the nearest outline of any visible path node.
        const target = this.findScissorTarget(pos);
        if (target) {
            this.applyScissorCut(target);
            return;
        }

        // Fallback: a primitive (rect/ellipse/…) under the cursor has no editable
        // subpaths yet — convert it to a path, then cut its nearest segment.
        const hitId = this.scene.hitTest(pos.x, pos.y);
        if (hitId === undefined) return;
        if (!this.scene.getNodeGeometry(hitId)?.Path) {
            this.scene.convertToPath(hitId);
        }
        const geo = this.scene.getNodeGeometry(hitId);
        if (!geo?.Path) return;

        const subpaths = geo.Path.subpaths;
        const transform = this.scene.getTransform(hitId);
        const threshold = 10 / this.renderer.zoom;
        const segHit = findNearestSegment(subpaths, transform, pos.x, pos.y, threshold);
        if (segHit) {
            this.applyScissorCut({
                nodeId: hitId,
                subpaths,
                segment: segHit,
                worldX: segHit.worldX,
                worldY: segHit.worldY,
                distance: segHit.distance,
            });
        }
    }

    /** Handle click in path-edit mode when Add Point mode is active. */
    handleAddPointClick(pos: { x: number; y: number }): boolean {
        if (!this.editingNodeId || !this.editingPoints || !this.editingTransform) return false;

        const threshold = 10 / this.renderer.zoom;
        const segHit = findNearestSegment(
            this.editingPoints,
            this.editingTransform,
            pos.x,
            pos.y,
            threshold,
        );
        if (!segHit) return false;

        const newSubpaths = addAnchorPoint(
            this.editingPoints,
            segHit.subpathIndex,
            segHit.segmentIndex,
            segHit.t,
        );

        // Update engine and local editing state
        this.scene.saveMoveHistory();
        this.scene.updatePathPoints(this.editingNodeId, JSON.stringify(newSubpaths));
        this.editingPoints = newSubpaths;
        this.addPointMode = false;
        this.ui.contextBar?.refresh();
        return true;
    }

    /** Delete the currently selected anchor points in path editing mode. */
    deleteSelectedPoints() {
        if (this.editingNodeId === null || !this.editingPoints) return;
        if (this.selectedPoints.size === 0) return;

        const currentSubpaths = JSON.parse(JSON.stringify(this.editingPoints));

        // Group points by subpath to delete efficiently
        const grouped = new Map<number, number[]>();
        for (const key of this.selectedPoints) {
            const [si, pi] = key.split(':').map(Number);
            if (!grouped.has(si)) grouped.set(si, []);
            grouped.get(si)!.push(pi);
        }

        // Sort subpaths in descending order to avoid index shifts if subpaths are removed
        const sortedSubpathIndices = Array.from(grouped.keys()).sort((a, b) => b - a);

        for (const si of sortedSubpathIndices) {
            const pointIndices = grouped.get(si)!.sort((a, b) => b - a);
            const sp = currentSubpaths[si];
            for (const pi of pointIndices) {
                sp.points.splice(pi, 1);
            }
            // If too few points remain, remove the entire subpath
            if (sp.points.length < 2) {
                currentSubpaths.splice(si, 1);
            }
        }

        if (currentSubpaths.length === 0) {
            // Deleted all points — remove the node
            this.scene.removeNodes([this.editingNodeId]);
            this.editingNodeId = null;
            this.editingPoints = null;
            this.selectedPoints.clear();
        } else {
            this.scene.saveMoveHistory();
            this.scene.updatePathPoints(this.editingNodeId, JSON.stringify(currentSubpaths));
            this.editingPoints = currentSubpaths;
            this.selectedPoints.clear();
            this.selectedAnchorSubpath = -1;
            this.selectedAnchorIndex = -1;
            this.draggingHandleType = null;
            this.ui.contextBar?.refresh();
        }

        this.ui.syncWithSelection();
        this.ui.updateLayerList();
    }

    /** Merge (weld) the selected anchor points in path editing mode. */
    mergeSelectedPoints() {
        if (this.editingNodeId === null || !this.editingPoints) return;
        if (this.selectedPoints.size < 2) return;

        const selected = Array.from(this.selectedPoints).map((key) => {
            const [subpathIdx, pointIdx] = key.split(':').map(Number);
            return { subpathIdx, pointIdx };
        });

        const merged = mergeSelectedAnchors(this.editingPoints, selected);
        if (!merged) return; // nothing mergeable (non-adjacent interior points)

        // updatePathPoints pushes the undo snapshot itself
        this.scene.updatePathPoints(this.editingNodeId, JSON.stringify(merged));
        this.editingPoints = merged;
        this.selectedPoints.clear();
        this.selectedAnchorSubpath = -1;
        this.selectedAnchorIndex = -1;
        this.draggingHandleType = null;
        this.ui.contextBar?.refresh();
        this.ui.syncWithSelection();
    }

    /** Scissors without aiming: split the edited path at the single selected
     *  anchor. Same operation as a scissors-tool click on that anchor. */
    cutAtSelectedPoint() {
        if (this.editingNodeId === null || !this.editingPoints) return;
        if (this.selectedPoints.size !== 1) return;

        const [si, pi] = Array.from(this.selectedPoints)[0].split(':').map(Number);

        this.scene.saveMoveHistory();
        const newSubpaths = splitPathAtPoint(this.editingPoints, si, pi);
        this.scene.updatePathPoints(this.editingNodeId, JSON.stringify(newSubpaths));
        this.editingPoints = newSubpaths;
        this.selectedPoints.clear();
        this.selectedAnchorSubpath = -1;
        this.selectedAnchorIndex = -1;
        this.draggingHandleType = null;
        this.ui.contextBar?.refresh();
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
    }

    /** Join two selected path nodes by connecting their nearest endpoints. */
    joinSelectedPaths() {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length !== 2) return;

        const [idA, idB] = selection;

        // Ensure both are paths
        for (const id of [idA, idB]) {
            const geo = this.scene.getNodeGeometry(id);
            if (!geo?.Path) {
                this.scene.convertToPath(id);
            }
        }

        const geoA = this.scene.getNodeGeometry(idA);
        const geoB = this.scene.getNodeGeometry(idB);
        if (!geoA?.Path || !geoB?.Path) return;

        // Find open subpaths
        const spA = geoA.Path.subpaths;
        const spB = geoB.Path.subpaths;

        const openA = spA.findIndex((sp) => !sp.closed);
        const openB = spB.findIndex((sp) => !sp.closed);
        if (openA < 0 || openB < 0) return; // no open subpaths to join

        // Merge B's geometry into A by combining subpaths, then join the open ones
        const tA = this.scene.getTransform(idA);
        const tB = this.scene.getTransform(idB);

        // Transform B's points into A's local space
        // Invert A's transform
        const a = tA[0],
            b = tA[1],
            c = tA[2];
        const d = tA[3],
            e = tA[4],
            f = tA[5];
        const det = a * e - b * d;
        if (Math.abs(det) < 1e-10) return;

        const bSubpaths: Subpath[] = JSON.parse(JSON.stringify(spB));
        for (const sp of bSubpaths) {
            for (const pt of sp.points) {
                // Transform point from B's local to world, then to A's local
                const wx = tB[0] * pt.x + tB[1] * pt.y + tB[2];
                const wy = tB[3] * pt.x + tB[4] * pt.y + tB[5];
                pt.x = (e * (wx - c) - b * (wy - f)) / det;
                pt.y = (a * (wy - f) - d * (wx - c)) / det;

                // Same for handles
                const c1w: [number, number] = [
                    tB[0] * pt.cp1[0] + tB[1] * pt.cp1[1] + tB[2],
                    tB[3] * pt.cp1[0] + tB[4] * pt.cp1[1] + tB[5],
                ];
                pt.cp1 = [
                    (e * (c1w[0] - c) - b * (c1w[1] - f)) / det,
                    (a * (c1w[1] - f) - d * (c1w[0] - c)) / det,
                ];

                const c2w: [number, number] = [
                    tB[0] * pt.cp2[0] + tB[1] * pt.cp2[1] + tB[2],
                    tB[3] * pt.cp2[0] + tB[4] * pt.cp2[1] + tB[5],
                ];
                pt.cp2 = [
                    (e * (c2w[0] - c) - b * (c2w[1] - f)) / det,
                    (a * (c2w[1] - f) - d * (c2w[0] - c)) / det,
                ];
            }
        }

        // Combine all subpaths into one array, then join the two open ones
        const combined = [...(JSON.parse(JSON.stringify(spA)) as Subpath[]), ...bSubpaths];
        const combinedOpenA = combined.findIndex((sp) => !sp.closed);
        const aSubpathCount = spA.length;
        const combinedOpenB = combined.findIndex((sp, i) => i >= aSubpathCount && !sp.closed);

        if (combinedOpenA < 0 || combinedOpenB < 0) return;

        const joined = joinSubpaths(combined, combinedOpenA, 'end', combinedOpenB, 'start');

        // Replace: update A's geometry, remove B
        this.scene.saveMoveHistory();
        this.scene.engine!.update_path_points(idA, JSON.stringify(joined));
        this.scene.engine!.remove_node(idB);
        this.scene.engine!.clear_selection();
        this.scene.engine!.select_node(idA, false);
        this.scene.invalidateCache();
        this.scene.autosave?.trigger();
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

    /** Called when the Live Paint (paint-bucket) tool is activated. If shapes are
     *  selected, turn them into a Live Paint group (or enter an existing one) so
     *  the user can paint immediately — clicking the tool IS "Make Live Paint". */
    enterPaintBucketMode() {
        const sel = Array.from(this.scene.engine!.get_selection());
        if (sel.length === 0) return; // no selection → paint any region freely
        // A single existing Live Paint group → just enter it.
        if (sel.length === 1 && this.scene.getNodeLivePaint(sel[0])) {
            this.enterLivePaintGroup(sel[0]);
            return;
        }
        // Only vector shapes/groups can form a Live Paint group; drop text/images.
        const paintable = sel.filter((id) => {
            const t = this.scene.getNode(id)?.node_type;
            return t === 'Path' || t === 'Rect' || t === 'Ellipse' || t === 'Group';
        });
        if (paintable.length === 0) return;
        if (paintable.length !== sel.length) {
            this.scene.engine!.clear_selection();
            for (const id of paintable) this.scene.engine!.select_node(id, true);
        }
        this.makeLivePaintGroup();
    }

    /** Turn the current selection into a Live Paint group — a special object
     *  (Illustrator's Object › Live Paint › Make). The selected shapes are
     *  grouped (an existing group is reused), flagged as Live Paint, renamed,
     *  and set as the active paint target. One undo step. */
    makeLivePaintGroup() {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length === 0) return;
        let groupId = 0;
        this.scene.transaction(() => {
            if (selection.length === 1 && this.scene.getNode(selection[0])?.node_type === 'Group') {
                groupId = selection[0];
            } else {
                groupId = this.scene.groupNodes(selection);
            }
            this.scene.setNodeLivePaint(groupId, true);
            this.scene.setNodeName(groupId, 'Live Paint');
            this.scene.setLivePaintGroup(groupId);
        });
        // Enter paint mode on the new group, deselected so the selection frame
        // doesn't cover the regions you're about to paint.
        this.scene.engine!.clear_selection();
        this.ui.setActiveTool('paint-bucket');
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    /** Nearest ancestor (or self) that is a Live Paint group, or null. */
    private findLivePaintAncestor(id: number): number | null {
        let cur: number = id;
        while (cur >= 0) {
            if (this.scene.getNodeLivePaint(cur)) return cur;
            cur = this.scene.engine!.get_node_parent(cur);
        }
        return null;
    }

    /** Enter an existing Live Paint group: scope painting to it and arm the
     *  bucket. Used by double-click and the Edit action. */
    enterLivePaintGroup(groupId: number) {
        if (!this.scene.getNodeLivePaint(groupId)) return;
        this.scene.setLivePaintGroup(groupId);
        this.scene.engine!.clear_selection();
        this.ui.setActiveTool('paint-bucket');
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    /** Stop editing the active Live Paint group (back to the Selection tool).
     *  The group stays the active Live Paint object — its faces keep rendering
     *  in-stream — so we do NOT clear the scope here (only Release/Expand do). */
    exitLivePaintGroup() {
        this.ui.setActiveTool('selection');
        this.scene.engine!.clear_selection();
        this.ui.syncWithSelection();
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    /** Expand a Live Paint group (Illustrator's Object › Live Paint › Expand):
     *  a destructive Divide. Every COLORED face becomes one flat, non-overlapping
     *  filled path (its painted color, else the source fill showing through), and
     *  every painted edge becomes a stroked path. The originals are REMOVED;
     *  uncolored faces are discarded. Output nests "Fills" + "Strokes" groups. */
    expandLivePaintGroup(groupId: number) {
        const e = this.scene.engine!;
        // Ensure faces are computed for THIS group's geometry.
        this.scene.setLivePaintGroup(groupId);
        type Pt = { x: number; y: number; cp1: number[]; cp2: number[] };
        // Every colored face with its EFFECTIVE fill (painted, or absorbed source).
        const faces = JSON.parse(e.get_live_paint_faces()) as Array<{
            outline: Pt[];
            fill: { r: number; g: number; b: number; a: number };
        }>;
        const edges = JSON.parse(e.get_painted_edges()) as Array<{
            polyline?: number[][];
            outline?: Pt[];
            color: { r: number; g: number; b: number; a: number };
            width: number;
        }>;
        if (faces.length === 0 && edges.length === 0) {
            this.releaseLivePaintGroup(groupId);
            return;
        }
        const outPts = (o?: Pt[]) =>
            (o || []).map((p) => ({ x: p.x, y: p.y, cp1: p.cp1, cp2: p.cp2, corner_radius: 0 }));
        const polyPts = (poly: number[][]) =>
            poly.map(([x, y]) => ({ x, y, cp1: [x, y], cp2: [x, y], corner_radius: 0 }));
        let expanded = 0;
        this.scene.transaction(() => {
            const fillIds: number[] = [];
            for (const f of faces) {
                const pts = outPts(f.outline);
                if (pts.length < 3) continue;
                const id = e.add_path(JSON.stringify([{ closed: true, points: pts }]));
                e.set_node_style(
                    id,
                    JSON.stringify({
                        fills: [f.fill],
                        strokes: [],
                        opacity: 1,
                        blend_mode: 0,
                        fill_rule: 0,
                        corner_radius: 0,
                        effects: [],
                    }),
                );
                e.set_node_name(id, 'Fill');
                fillIds.push(id);
            }
            const strokeIds: number[] = [];
            for (const eg of edges) {
                const pts =
                    eg.outline && eg.outline.length >= 2
                        ? outPts(eg.outline)
                        : eg.polyline
                          ? polyPts(eg.polyline)
                          : [];
                if (pts.length < 2) continue;
                const id = e.add_path(JSON.stringify([{ closed: false, points: pts }]));
                e.set_node_style(
                    id,
                    JSON.stringify({
                        fills: [],
                        strokes: [
                            {
                                paint: eg.color,
                                width: eg.width > 0 ? eg.width : 2,
                                cap: 1,
                                join: 1,
                                dash_array: [],
                                dash_offset: 0,
                                miter_limit: 4,
                                alignment: 'Center',
                            },
                        ],
                        opacity: 1,
                        blend_mode: 0,
                        fill_rule: 0,
                        corner_radius: 0,
                        effects: [],
                    }),
                );
                e.set_node_name(id, 'Edge');
                strokeIds.push(id);
            }
            // Destructive: drop the Live Paint marks and the ORIGINAL shapes.
            e.set_live_paint_group(0);
            e.clear_live_paint_marks();
            e.remove_node(groupId);
            // Nest Fills (bottom) + Strokes (top) inside an "Expanded" group.
            const parts: number[] = [];
            if (fillIds.length) {
                const g = e.group_nodes(JSON.stringify(fillIds));
                e.set_node_name(g, 'Fills');
                parts.push(g);
            }
            if (strokeIds.length) {
                const g = e.group_nodes(JSON.stringify(strokeIds));
                e.set_node_name(g, 'Strokes');
                parts.push(g);
            }
            if (parts.length === 0) return;
            expanded = parts.length > 1 ? e.group_nodes(JSON.stringify(parts)) : parts[0];
            e.set_node_name(expanded, 'Expanded');
        });
        this.scene.invalidateCache();
        e.clear_selection();
        if (expanded) this.scene.selectNode(expanded, false);
        this.ui.setActiveTool('selection');
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    /** Internal fallback: turn a Live Paint group back into a plain group
     *  (removes the flag + clears the paint target). Used by Expand when there
     *  is nothing painted to bake — there is no user-facing "Release" action. */
    private releaseLivePaintGroup(groupId?: number) {
        const id = groupId ?? this.scene.getLivePaintGroup();
        this.scene.transaction(() => {
            if (id >= 0) this.scene.setNodeLivePaint(id, false);
            this.scene.setLivePaintGroup(0);
        });
        this.ui.updateLayerList();
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
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

    /**
     * Toggle "use as mask" on the selection (Figma-style alpha mask).
     * Masks are group-scoped — the parent group bounds what gets masked — and
     * the user never builds that group by hand:
     *  - Any selected node already a mask → release it.
     *  - Multiple nodes → auto-group them; the bottom-most becomes the mask.
     *  - Single node already inside a group → mark it (scoped to that group).
     *  - Single node at root → auto-group it with the sibling directly above
     *    it (the thing it should mask) and mark it. Nothing else in the
     *    document is touched.
     */
    toggleMaskSelection() {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length === 0) return;
        const anyMask = selection.some((id) => this.scene.getNodeIsMask(id));

        if (anyMask) {
            this.scene.transaction(() => {
                for (const id of selection) this.scene.setNodeIsMask(id, false);
            });
        } else if (selection.length > 1) {
            this.scene.transaction(() => {
                const groupId = this.scene.groupNodes(selection);
                try {
                    this.scene.engine!.set_node_name(groupId, 'Mask group');
                } catch {
                    /* noop */
                }
                const kids = Array.from(this.scene.getNodeChildren(groupId));
                if (kids.length > 0) this.scene.setNodeIsMask(kids[0], true);
                this.scene.engine!.clear_selection();
                this.scene.selectNode(groupId, false);
            });
        } else {
            const id = selection[0];
            const parent = this.scene.getNodeParent(id);
            if (parent !== -1) {
                // Already bounded by a group — just flag it.
                this.scene.setNodeIsMask(id, true);
            } else {
                // Root node: wrap it (plus the sibling directly above, if any)
                // in a fresh mask group so the mask has a bounded scope.
                this.scene.transaction(() => {
                    const roots = Array.from(this.scene.getRootNodes());
                    const idx = roots.indexOf(id);
                    const above = idx >= 0 && idx + 1 < roots.length ? roots[idx + 1] : null;
                    const members = above !== null ? [id, above] : [id];
                    const groupId = this.scene.groupNodes(members);
                    try {
                        this.scene.engine!.set_node_name(groupId, 'Mask group');
                    } catch {
                        /* noop */
                    }
                    this.scene.setNodeIsMask(id, true);
                    this.scene.engine!.clear_selection();
                    this.scene.selectNode(id, false);
                });
            }
        }
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    /**
     * Flatten selection: collapse each node into the simplest possible filled
     * path(s).  This is the "Expand" operation from Illustrator:
     *
     *  1. Text → path outlines  (Create Outlines)
     *  2. Rect / Ellipse → path  (Convert to Path)
     *  3. Non-identity transform → baked into geometry  (Flatten Transform)
     *  4. Stroke handling:
     *     • fill + stroke → split into two sibling paths in a group
     *       (fill path keeps fill, outline path gets fill=stroke color)
     *     • stroke only   → outline stroke in-place (fill=stroke, stroke=none)
     *     • fill only     → nothing extra
     *
     * Everything is wrapped in a single undo step.
     */
    async flattenSelection() {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length === 0) return;

        // Exit path editing if active — flattening changes geometry
        if (this.editingNodeId !== null) {
            this.exitEditMode();
        }

        // Outlining text needs an async font parse (opentype.js). The transaction
        // below is synchronous, so pre-compute outlines for every text node first.
        const textOutlines = new Map<number, Subpath[] | null>();
        for (const id of selection) {
            if (this.scene.getNode(id)?.node_type !== 'Text') continue;
            const geo = this.scene.getNodeGeometry(id)?.Text;
            textOutlines.set(id, geo ? await textNodeToSubpaths(geo, this.renderer.ck) : null);
        }

        this.scene.transaction(() => {
            // Track which nodes end up selected after flatten
            const newSelection: number[] = [];

            for (const id of selection) {
                const node = this.scene.getNode(id);
                if (!node) {
                    newSelection.push(id);
                    continue;
                }

                // ── Step 1: Text → Path (create outlines) ──────────────
                if (node.node_type === 'Text') {
                    const subpaths = textOutlines.get(id) ?? null;
                    if (subpaths && subpaths.length > 0) {
                        this.scene.replaceGeometryWithPath(id, subpaths);
                    } else {
                        // Can't outline this text — skip
                        newSelection.push(id);
                        continue;
                    }
                }

                // ── Step 2: Rect / Ellipse → Path ──────────────────────
                if (node.node_type === 'Rect' || node.node_type === 'Ellipse') {
                    this.scene.convertToPath(id);
                }

                // ── Step 3: Bake transform into geometry ───────────────
                this.scene.flattenTransform(id);

                // ── Step 4: Handle strokes ─────────────────────────────
                const style = this.scene.getNodeStyle(id);
                const hasStroke =
                    style.strokes &&
                    style.strokes.length > 0 &&
                    style.strokes.some((s) => s.width > 0);
                const hasFill = style.fills && style.fills.length > 0;

                if (hasStroke && hasFill) {
                    // Fill + Stroke → split into two paths in a group
                    // 1. Duplicate the node for the stroke outline
                    const strokeNodeId = this.scene.duplicateNode(id);
                    // duplicate_node offsets +20,+20 — undo it so the outline sits exactly on top
                    this.scene.moveNode(strokeNodeId, -20, -20);

                    // 2. Original keeps fill, loses stroke
                    const fillStyle = { ...style, strokes: [] };
                    this.scene.setNodeStyleNoHistory(id, JSON.stringify(fillStyle));

                    // 3. Duplicate becomes the stroke outline (fill = stroke color, stroke = none)
                    outlineStroke(this.ui.ck, this.scene, strokeNodeId);

                    // 4. Group them (fill behind, stroke outline on top)
                    const groupId = this.scene.groupNodes([id, strokeNodeId]);
                    newSelection.push(groupId);
                } else if (hasStroke && !hasFill) {
                    // Stroke only → outline in place
                    outlineStroke(this.ui.ck, this.scene, id);
                    newSelection.push(id);
                } else {
                    // Fill only or no paint → nothing more to do
                    newSelection.push(id);
                }
            }

            // Restore selection to the resulting nodes
            this.scene.engine!.clear_selection();
            for (const id of newSelection) {
                this.scene.selectNode(id, true);
            }
        });

        this.scene.invalidateCache();
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.contextBar?.refresh();
    }

    /** Whether the current pen path was closed by clicking near the first point. */
    penPathClosed: boolean = false;
    /** While closing the path: a handle drag targets the first anchor, and the
     *  path is finalized on mouse-up (so the closing point behaves like any
     *  other — click to close with a corner, or drag to pull a bezier handle). */
    penClosingDrag: boolean = false;
    /** Latches true once a pen mouse-down turns into a real handle drag (cursor
     *  moved past PEN_HANDLE_DEAD_ZONE screen-px). Until then a press stays a
     *  crisp corner, so a shaky click doesn't pull a stray handle. */
    penHandleDragging: boolean = false;
    /** Snapped cursor position while hovering with the pen (for the rubber-band
     *  preview segment); null when not hovering. */
    penHoverPos: { x: number; y: number } | null = null;
    /** True when the hover cursor is close enough to the first anchor that a
     *  click would close the path (drives the close-indicator ring). */
    penHoverClosing: boolean = false;
    /** World position of an existing open-path endpoint the idle pen is hovering
     *  (a click there would continue that path); null when none. Drives the
     *  continuation-indicator ring. */
    penHoverAdopt: { x: number; y: number } | null = null;

    // ─── Endpoint continuation (extend an existing open path) ───────────
    /** When the pen path was started by clicking a free endpoint of an existing
     *  open path, the id of that source node. New anchors extend it in place;
     *  null means the pen is drawing a brand-new path. */
    penSourceNodeId: number | null = null;
    /** The source node's local→world transform, captured at adoption time, used
     *  to convert the world-space pen points back to local on finalize. */
    penSourceTransform: Float32Array | null = null;
    /** Deep copy of the source node's full (local-space) subpaths at adoption
     *  time. The extended subpath is written back into this array on finalize so
     *  the node's other subpaths are preserved. */
    penSourceSubpaths: Subpath[] | null = null;
    /** Index (within penSourceSubpaths) of the open subpath being extended. */
    penSourceSubpathIndex: number = -1;

    /** Screen-space radius (px) for hitting the first anchor to close the path. */
    static readonly PEN_CLOSE_RADIUS = 10;
    /** Screen-space distance (px) the cursor must travel before a pen press is
     *  treated as a handle drag rather than a plain click. */
    static readonly PEN_HANDLE_DEAD_ZONE = 4;

    handlePenDown(pos: { x: number; y: number }, bypassSnap = false) {
        this.penHandleDragging = false;

        // Endpoint continuation: on the very first click of a new path, if the
        // cursor lands on a free endpoint of an existing open path, adopt that
        // path and extend it in place rather than starting a fresh one
        // (Figma-style forgiveness). Cmd/Ctrl bypasses this to force a new path.
        if (!bypassSnap && this.currentPathPoints.length === 0 && this.tryAdoptEndpoint(pos)) {
            return;
        }

        // If we have existing points, check if clicking near the first point to
        // close the path. Threshold is in screen pixels (zoom-independent), so
        // the close target feels the same at any zoom level. Cmd/Ctrl bypasses
        // this the same way it bypasses snapping — place a point without closing.
        if (!bypassSnap && this.currentPathPoints.length > 1) {
            const first = this.currentPathPoints[0];
            const dist = Math.hypot(pos.x - first.x, pos.y - first.y);
            if (dist < InputManager.PEN_CLOSE_RADIUS / this.renderer.zoom) {
                // Close the path, but keep it live so the user can drag out a
                // bezier handle on the closing anchor. Finalized on mouse-up.
                this.penPathClosed = true;
                this.penClosingDrag = true;
                this.isDraggingHandle = true;
                this.ui.contextBar?.refresh();
                return;
            }
        }

        // Add a new anchor point (control points default to the anchor position)
        this.currentPathPoints.push({
            x: pos.x,
            y: pos.y,
            cp1x: pos.x,
            cp1y: pos.y,
            cp2x: pos.x,
            cp2y: pos.y,
        });
        this.isDraggingHandle = true;
        this.ui.contextBar?.refresh();
    }

    finalizePenPath() {
        if (this.penSourceNodeId !== null) {
            // Endpoint continuation: write the extended subpath back into the
            // source node, in its own local space, preserving its other subpaths.
            this.finalizeAdoptedPenPath();
        } else if (this.currentPathPoints.length >= 2) {
            const rustPoints = this.currentPathPoints.map((p) => this.penPointToLocal(p, null, 0));
            const subpaths = [{ points: rustPoints, closed: this.penPathClosed }];
            const newId = this.scene.addPath(JSON.stringify(subpaths));

            // Apply the current UI style and select the new path
            this.scene.setNodeStyleNoHistory(newId, this.ui.getCurrentStyle());
            this.scene.engine!.clear_selection();
            this.scene.selectNode(newId, false);
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
            // One-shot: a completed path returns to Selection like the shape
            // tools, unless the pen was locked (double-click) for multiple paths.
            this.maybeRevertTool();
        }
        this.resetPenState();
    }

    /** Write the extended pen buffer back into the adopted source node. The pen
     *  points live in world space; convert them to the node's local space via
     *  the captured transform and replace the open subpath being extended. */
    private finalizeAdoptedPenPath() {
        const t = this.penSourceTransform;
        const subs = this.penSourceSubpaths;
        if (!t || !subs || this.currentPathPoints.length < 2) return;
        const det = t[0] * t[4] - t[1] * t[3];
        if (Math.abs(det) < 1e-10) return; // degenerate transform — leave node as-is

        const localPoints = this.currentPathPoints.map((p) => this.penPointToLocal(p, t, det));
        const out: Subpath[] = JSON.parse(JSON.stringify(subs));
        out[this.penSourceSubpathIndex] = { points: localPoints, closed: this.penPathClosed };

        this.scene.updatePathPoints(this.penSourceNodeId!, JSON.stringify(out));
        this.scene.engine!.clear_selection();
        this.scene.selectNode(this.penSourceNodeId!, false);
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
        this.maybeRevertTool();
    }

    /** Convert a world-space pen point to a PathPoint. When t/det are given, map
     *  through the node's inverse transform (local space); otherwise pass the
     *  world coordinates straight through (new path at identity). */
    private penPointToLocal(p: PenPathPoint, t: Float32Array | null, det: number): PathPoint {
        const map = (x: number, y: number): [number, number] =>
            t ? this.penWorldToLocal(t, det, x, y) : [x, y];
        const [ax, ay] = map(p.x, p.y);
        const pt: PathPoint = {
            x: ax,
            y: ay,
            cp1: map(p.cp1x, p.cp1y),
            cp2: map(p.cp2x, p.cp2y),
        };
        if (p.corner_radius) pt.corner_radius = p.corner_radius;
        return pt;
    }

    /** Convert a world point to the source node's local space. `det` is the
     *  precomputed 2×2 determinant (t0·t4 − t1·t3). */
    private penWorldToLocal(
        t: Float32Array,
        det: number,
        wx: number,
        wy: number,
    ): [number, number] {
        const dx = wx - t[2],
            dy = wy - t[5];
        return [(t[4] * dx - t[1] * dy) / det, (t[0] * dy - t[3] * dx) / det];
    }

    /** Convert a local point to world space using a node's local→world transform. */
    private penLocalToWorld(t: Float32Array, lx: number, ly: number): [number, number] {
        return [t[0] * lx + t[1] * ly + t[2], t[3] * lx + t[4] * ly + t[5]];
    }

    /** Clear all in-progress pen state after finalizing. */
    private resetPenState() {
        this.currentPathPoints = [];
        this.penPathClosed = false;
        this.penClosingDrag = false;
        this.penSourceNodeId = null;
        this.penSourceTransform = null;
        this.penSourceSubpaths = null;
        this.penSourceSubpathIndex = -1;
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    /** Discard the in-progress pen path without committing. When a path was
     *  adopted for continuation the (hidden) source node reappears unchanged,
     *  since it was never mutated. */
    abandonPenPath() {
        this.resetPenState();
    }

    /** If `pos` lands on a free endpoint of an existing open path, load that
     *  subpath into the pen buffer (oriented so the clicked end is last) and
     *  remember the source node for write-back on finalize. Returns true if a
     *  path was adopted. */
    private tryAdoptEndpoint(pos: { x: number; y: number }): boolean {
        const hit = this.findAdoptableEndpoint(pos);
        if (!hit) return false;

        const geo = this.scene.getNodeGeometry(hit.nodeId);
        if (!geo?.Path) return false;
        const subpaths = JSON.parse(JSON.stringify(geo.Path.subpaths)) as Subpath[];
        const sp = subpaths[hit.subpathIndex];
        if (!sp || sp.closed || sp.points.length < 1) return false;

        const t = this.scene.getTransform(hit.nodeId);
        let pts: PenPathPoint[] = sp.points.map((p) => {
            const a = this.penLocalToWorld(t, p.x, p.y);
            const c1 = this.penLocalToWorld(t, p.cp1[0], p.cp1[1]);
            const c2 = this.penLocalToWorld(t, p.cp2[0], p.cp2[1]);
            const pp: PenPathPoint = {
                x: a[0],
                y: a[1],
                cp1x: c1[0],
                cp1y: c1[1],
                cp2x: c2[0],
                cp2y: c2[1],
            };
            if (p.corner_radius) pp.corner_radius = p.corner_radius;
            return pp;
        });

        // Orient so the clicked endpoint is LAST (the extension grows from it).
        // Clicking the start reverses point order and swaps each point's
        // incoming/outgoing handles.
        if (hit.end === 'start') {
            pts = pts.reverse().map((p) => ({
                x: p.x,
                y: p.y,
                cp1x: p.cp2x,
                cp1y: p.cp2y,
                cp2x: p.cp1x,
                cp2y: p.cp1y,
                corner_radius: p.corner_radius,
            }));
        }

        this.currentPathPoints = pts;
        this.penSourceNodeId = hit.nodeId;
        this.penSourceTransform = t;
        this.penSourceSubpaths = subpaths;
        this.penSourceSubpathIndex = hit.subpathIndex;
        this.penPathClosed = false;
        this.penClosingDrag = false;
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
        return true;
    }

    /** Find the nearest free endpoint of an open path near `pos`, within the pen
     *  close radius. Scans only nodes whose bounds fall near the cursor. */
    private findAdoptableEndpoint(pos: {
        x: number;
        y: number;
    }): { nodeId: number; subpathIndex: number; end: 'start' | 'end' } | null {
        const r = InputManager.PEN_CLOSE_RADIUS / this.renderer.zoom;
        const pad = r * 1.5;
        const candidates = this.scene.getVisibleNodes(
            pos.x - pad,
            pos.y - pad,
            pos.x + pad,
            pos.y + pad,
        );
        let best: { nodeId: number; subpathIndex: number; end: 'start' | 'end' } | null = null;
        let bestDist = r;
        for (const id of candidates) {
            if (this.scene.getNodeLocked(id) || !this.scene.getNodeVisible(id)) continue;
            const geo = this.scene.getNodeGeometry(id);
            if (!geo?.Path) continue;
            const t = this.scene.getTransform(id);
            const subs = geo.Path.subpaths;
            for (let si = 0; si < subs.length; si++) {
                const sp = subs[si];
                if (sp.closed || sp.points.length < 1) continue;
                const ends: Array<'start' | 'end'> =
                    sp.points.length === 1 ? ['start'] : ['start', 'end'];
                for (const end of ends) {
                    const p = end === 'start' ? sp.points[0] : sp.points[sp.points.length - 1];
                    const w = this.penLocalToWorld(t, p.x, p.y);
                    const d = Math.hypot(pos.x - w[0], pos.y - w[1]);
                    if (d < bestDist) {
                        bestDist = d;
                        best = { nodeId: id, subpathIndex: si, end };
                    }
                }
            }
        }
        return best;
    }

    // --- Modifier helpers ---
    private constrainToAxis(
        start: { x: number; y: number },
        current: { x: number; y: number },
    ): { x: number; y: number } {
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
        this.lastMouseEvent = e;
        const lastPos = this.currentPos;
        this.currentPos = this.getPos(e);
        this.shiftKey = e.shiftKey;
        this.altKey = e.altKey;
        this.metaKey = e.metaKey;
        this.ctrlKey = e.ctrlKey;

        // Artboard move/resize drag in progress.
        if (this.artboardDrag && this.isMouseDown) {
            this.didMove = true;
            this.updateArtboardDrag();
            return;
        }

        // Viewport pan drag (space or middle mouse held)
        if (this.panDrag && this.isMouseDown) {
            this.renderer.pan.x = this.panDrag.panX + (e.clientX - this.panDrag.screenX);
            this.renderer.pan.y = this.panDrag.panY + (e.clientY - this.panDrag.screenY);
            this.renderer.notifyViewChange();
            return;
        }
        if (this.isSpacePan) return; // hand tool active — no hover/tool behavior

        // Hover cursor for resize handles (when not dragging, skip in node-editing mode)
        if (!this.isMouseDown && this.ui.activeTool === 'selection') {
            const gHit =
                this.editingNodeId === null && this.ui.gradientEdit.isActive()
                    ? this.ui.gradientEdit.hitTest(this.currentPos, this.renderer.zoom)
                    : null;
            const frame = this.editingNodeId === null && !gHit ? this.getSelectionFrame() : null;
            const handle = frame ? this.checkResizeHandle(this.currentPos, frame) : null;
            const rotHandle =
                !handle && frame ? this.checkRotateHandle(this.currentPos, frame) : null;
            if (gHit) {
                this.hoverNodeId = null;
                // 'copy' hints that clicking the axis inserts a new stop
                this.canvas.style.cursor = gHit.type === 'insert' ? 'copy' : 'default';
            } else if (handle && frame) {
                this.hoverNodeId = null;
                this.canvas.style.cursor = this.resizeCursorFor(handle.type, frame);
            } else if (rotHandle && frame) {
                this.hoverNodeId = null;
                this.canvas.style.cursor = this.rotateCursorForCorner(rotHandle.type, frame);
            } else if (
                this.editingNodeId === null &&
                this.checkCornerRadiusHandle(this.currentPos)
            ) {
                this.hoverNodeId = null;
                // Diagonal pointer — corner radius handles sit on the diagonal
                this.canvas.style.cursor = 'pointer';
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

        // Paint bucket hover preview. Filling is primary, so we highlight the
        // region under the cursor; only when Alt is held (edge mode) do we
        // highlight the nearest edge — matching what a click will do.
        if (!this.isMouseDown && this.ui.activeTool === 'paint-bucket') {
            const edgeTol = 6 / this.renderer.zoom;
            const faceId = this.scene.engine!.query_face_at(this.currentPos.x, this.currentPos.y);
            if (e.altKey || faceId < 0) {
                // Edge mode (Alt), or outside any region → preview the edge.
                const edgeId = this.scene.queryEdgeAt(
                    this.currentPos.x,
                    this.currentPos.y,
                    edgeTol,
                );
                this.renderer.hoverEdgeId = edgeId;
                this.renderer.hoverFaceId = e.altKey ? -1 : faceId;
                this.canvas.style.cursor = edgeId >= 0 ? 'crosshair' : 'default';
            } else {
                this.renderer.hoverEdgeId = -1;
                this.renderer.hoverFaceId = faceId;
                this.canvas.style.cursor = 'crosshair';
            }
        }

        // Scissors / Add-Point / Segment hover preview
        if (
            !this.isMouseDown &&
            (this.ui.activeTool === 'scissors' ||
                (this.ui.activeTool === 'direct' && this.editingNodeId))
        ) {
            this.scissorsHoverPoint = null;
            this.hoverSegment = null;

            // For scissors: snap the preview dot to the nearest path outline.
            if (this.ui.activeTool === 'scissors') {
                const target = this.findScissorTarget(this.currentPos);
                if (target) this.scissorsHoverPoint = { x: target.worldX, y: target.worldY };
            }
            // For direct tool: hit test the editing path's segments for highlighting or add-point
            else if (this.editingNodeId && this.editingPoints && this.editingTransform) {
                const seg = findNearestSegment(
                    this.editingPoints,
                    this.editingTransform,
                    this.currentPos.x,
                    this.currentPos.y,
                    10 / this.renderer.zoom,
                );
                if (seg) {
                    this.hoverSegment = {
                        subpathIndex: seg.subpathIndex,
                        segmentIndex: seg.segmentIndex,
                    };
                    if (this.addPointMode) {
                        this.scissorsHoverPoint = { x: seg.worldX, y: seg.worldY };
                    }
                }
                // Cursor affordance: Alt over an anchor pulls/collapses handles.
                const hnd = this.findNearestHandle(this.currentPos);
                if (hnd?.type === 'anchor' && e.altKey) {
                    this.canvas.style.cursor = 'crosshair';
                } else if (hnd) {
                    this.canvas.style.cursor = 'move';
                } else {
                    this.canvas.style.cursor = 'default';
                }
            }
        } else {
            this.scissorsHoverPoint = null;
            this.hoverSegment = null;
        }

        // Pen tool hover: rubber-band preview segment + close-indicator ring.
        this.updatePenHover();

        // Pre-drag snap preview: for tools that snap their origin, show the snap
        // guides while hovering so the start point is defined by snapping too.
        if (!this.isMouseDown) this.updateHoverSnapPreview(e.metaKey || e.ctrlKey);

        if (!this.isMouseDown) return;
        this.onMouseMoveDrag(e, lastPos);
    }

    /** Pointer-drag handling — runs only while the mouse button is held. */
    private onMouseMoveDrag(e: MouseEvent, lastPos: { x: number; y: number }) {
        // On-canvas gradient handle drag (endpoints / stops / freshly inserted stop)
        if (this.gradientDragActive) {
            this.ui.gradientEdit.moveDrag(this.currentPos, e.shiftKey);
            return;
        }

        const dx = this.currentPos.x - lastPos.x;
        const dy = this.currentPos.y - lastPos.y;

        if (this.ui.activeTool === 'selection') {
            // Corner radius drag
            if (this.cornerRadiusDragging) {
                const { nodeId, startRadius, startPos } = this.cornerRadiusDragging;
                const node = this.scene.getNode(nodeId);
                if (node?.geometry.Rect) {
                    const rect = node.geometry.Rect;
                    const transform = this.scene.getTransform(nodeId);

                    const a = transform[0],
                        b = transform[1],
                        tx = transform[2];
                    const c = transform[3],
                        d = transform[4],
                        ty = transform[5];
                    const det = a * d - b * c;
                    const invDet = 1 / det;
                    const ia = d * invDet,
                        ib = -b * invDet,
                        ic = -c * invDet,
                        id_ = a * invDet;
                    const itx = (b * ty - d * tx) * invDet,
                        ity = (c * tx - a * ty) * invDet;

                    const slx = ia * startPos.x + ib * startPos.y + itx;
                    const sly = ic * startPos.x + id_ * startPos.y + ity;
                    const clx = ia * this.currentPos.x + ib * this.currentPos.y + itx;
                    const cly = ic * this.currentPos.x + id_ * this.currentPos.y + ity;

                    const corners = [
                        [0, 0, 1, 1],
                        [rect.width, 0, -1, 1],
                        [rect.width, rect.height, -1, -1],
                        [0, rect.height, 1, -1],
                    ];

                    let bestDist = Infinity;
                    let bestCorner = corners[0];
                    for (const cor of corners) {
                        const d = Math.hypot(slx - cor[0], sly - cor[1]);
                        if (d < bestDist) {
                            bestDist = d;
                            bestCorner = cor;
                        }
                    }

                    const dx_local = clx - slx;
                    const dy_local = cly - sly;
                    const dragProj =
                        (dx_local * bestCorner[2] + dy_local * bestCorner[3]) / Math.SQRT2;

                    let newRadius = startRadius + dragProj * Math.SQRT2;
                    newRadius = Math.round(
                        Math.max(0, Math.min(newRadius, rect.width / 2, rect.height / 2)),
                    );

                    const style = { ...node.style, corner_radius: newRadius };
                    this.scene.setNodeStyleNoHistory(nodeId, JSON.stringify(style));
                    this.ui.syncWithSelection({ interactive: true });
                    return;
                }
            }

            // Rotate handle drag (returns early from mouseDown, like resize)
            if (
                this.rotateHandleType &&
                this.rotatePivot &&
                this.rotateSnapshot &&
                this.rotateTargetIds.length > 0
            ) {
                const p = this.rotatePivot;
                const cur = Math.atan2(this.currentPos.y - p.y, this.currentPos.x - p.x);
                let deltaDeg = (cur - this.rotateStartAngle) * (180 / Math.PI);

                // Shift snaps to 15° increments — absolute angle for a single
                // node (so a shape at 0° lands on clean multiples), delta for
                // multi-selection.
                if (e.shiftKey) {
                    if (this.rotateSingleStartDeg !== null) {
                        const snapped =
                            Math.round((this.rotateSingleStartDeg + deltaDeg) / 15) * 15;
                        deltaDeg = snapped - this.rotateSingleStartDeg;
                    } else {
                        deltaDeg = Math.round(deltaDeg / 15) * 15;
                    }
                }

                this.applyRotationDrag(deltaDeg * (Math.PI / 180));
                // Keep the glyph oriented to the grab point as it orbits the pivot
                this.canvas.style.cursor = this.rotateCursorForAngle(cur * (180 / Math.PI));
                return;
            }

            // Oriented resize drag (rotated/skewed frame): all math happens in
            // frame space, so the drag follows the shape's own axes.
            if (
                this.resizeHandleType &&
                this.resizeFrame &&
                this.resizeSnapshot &&
                this.resizeLocalBounds &&
                this.resizeTargetIds.length > 0
            ) {
                const F0 = this.resizeFrame;
                const inv = this.matInv(F0.m);
                const sp = this.matApply(inv, this.startPos);
                const cp = this.matApply(inv, this.currentPos);
                const fdx = cp.x - sp.x,
                    fdy = cp.y - sp.y;
                const t = this.resizeHandleType;
                let newW = F0.w,
                    newH = F0.h,
                    moveX = 0,
                    moveY = 0;

                if (t.includes('e')) newW = F0.w + fdx;
                if (t.includes('w')) {
                    newW = F0.w - fdx;
                    moveX = fdx;
                }
                if (t.includes('s')) newH = F0.h + fdy;
                if (t.includes('n')) {
                    newH = F0.h - fdy;
                    moveY = fdy;
                }

                // Shift: maintain aspect ratio (corners only, like legacy)
                if (e.shiftKey && t.length === 2) {
                    const aspect = F0.w / F0.h;
                    if (Math.abs(fdx) / F0.w > Math.abs(fdy) / F0.h) {
                        newH = newW / aspect;
                    } else {
                        newW = newH * aspect;
                    }
                    if (t.includes('w')) moveX = F0.w - newW;
                    if (t.includes('n')) moveY = F0.h - newH;
                }

                // Alt: resize from center
                if (e.altKey) {
                    const deltaW = newW - F0.w;
                    const deltaH = newH - F0.h;
                    newW = F0.w + deltaW * 2;
                    newH = F0.h + deltaH * 2;
                    moveX = -deltaW;
                    moveY = -deltaH;
                }

                newW = Math.max(newW, 1);
                newH = Math.max(newH, 1);

                this.liveFrame = {
                    w: newW,
                    h: newH,
                    m: this.matMul(F0.m, { a: 1, b: 0, c: 0, d: 1, e: moveX, f: moveY }),
                };

                // Restore pristine state, then apply the resize in local space.
                this.scene.engine!.deserialize_scene(this.resizeSnapshot);
                const id = this.resizeTargetIds[0];
                const kx = newW / F0.w,
                    ky = newH / F0.h;
                const lb = this.resizeLocalBounds;

                const nodeType = this.scene.getNodeType(id);
                if (nodeType === 3) {
                    // Group: scale the local transform about the local-bounds
                    // anchor so the whole subtree scales along the frame axes.
                    //   L' = L0 · T(lb+move) · S(kx,ky) · T(-lb)
                    const l = this.scene.getNodeLocalTransform(id);
                    const L0: Mat = { a: l[0], b: l[1], c: l[3], d: l[4], e: l[6], f: l[7] };
                    const Lp = this.matMul(
                        L0,
                        this.matMul(
                            { a: 1, b: 0, c: 0, d: 1, e: lb.x + moveX, f: lb.y + moveY },
                            this.matMul(
                                { a: kx, b: 0, c: 0, d: ky, e: 0, f: 0 },
                                { a: 1, b: 0, c: 0, d: 1, e: -lb.x, f: -lb.y },
                            ),
                        ),
                    );
                    this.scene.engine!.set_node_transform_matrix(
                        id,
                        JSON.stringify([Lp.a, Lp.b, 0, Lp.c, Lp.d, 0, Lp.e, Lp.f, 1]),
                    );
                } else if (nodeType === 4) {
                    // Text (auto-width): resizing scales the FONT SIZE, like
                    // Figma — its box hugs the content, so there's no width/height
                    // to stretch. Edges use the dragged axis; corners use the
                    // geometric mean sqrt(kx·ky) so the scale is smooth and
                    // direction-independent (matches Figma's proportional feel).
                    const tg = this.scene.getNodeGeometry(id)?.Text;
                    if (tg) {
                        const k =
                            t === 'e' || t === 'w'
                                ? kx
                                : t === 'n' || t === 's'
                                  ? ky
                                  : Math.sqrt(Math.abs(kx * ky));
                        const newSize = Math.max(1, Math.min(2000, tg.font_size * k));
                        this.scene.engine!.set_text_content(id, tg.content, newSize);
                        this.anchorNodeToFrameTopLeft(id);
                    }
                } else {
                    // Geometry resize (local units), then move so the frame's
                    // top-left corner lands where the live frame says.
                    this.scene.engine!.resize_node(id, lb.w * kx, lb.h * ky);
                    this.anchorNodeToFrameTopLeft(id);
                }

                this.scene.invalidateCache();
                this.ui.syncWithSelection({ interactive: true });
                return;
            }

            // Resize handle drag (checked before dragMode since resize returns early from mouseDown)
            if (
                this.resizeHandleType &&
                this.resizeStartBounds &&
                this.resizeTargetIds.length > 0 &&
                this.resizeSnapshot
            ) {
                const bounds = this.resizeStartBounds;
                const rdx = this.currentPos.x - this.startPos.x;
                const rdy = this.currentPos.y - this.startPos.y;
                let newW = bounds.w,
                    newH = bounds.h;
                let moveX = 0,
                    moveY = 0;

                if (this.resizeHandleType.includes('e')) newW = bounds.w + rdx;
                if (this.resizeHandleType.includes('w')) {
                    newW = bounds.w - rdx;
                    moveX = rdx;
                }
                if (this.resizeHandleType.includes('s')) newH = bounds.h + rdy;
                if (this.resizeHandleType.includes('n')) {
                    newH = bounds.h - rdy;
                    moveY = rdy;
                }

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
                        if (s) {
                            newW = s.value - bounds.x;
                            this.activeSnapGuides.push(s.guide);
                        }
                    }
                    if (this.resizeHandleType.includes('w')) {
                        const s = this.snap.snapAxis('x', bounds.x + moveX, threshold);
                        if (s) {
                            const d = s.value - (bounds.x + moveX);
                            moveX += d;
                            newW -= d;
                            this.activeSnapGuides.push(s.guide);
                        }
                    }
                    if (this.resizeHandleType.includes('s')) {
                        const s = this.snap.snapAxis('y', bounds.y + newH, threshold);
                        if (s) {
                            newH = s.value - bounds.y;
                            this.activeSnapGuides.push(s.guide);
                        }
                    }
                    if (this.resizeHandleType.includes('n')) {
                        const s = this.snap.snapAxis('y', bounds.y + moveY, threshold);
                        if (s) {
                            const d = s.value - (bounds.y + moveY);
                            moveY += d;
                            newH -= d;
                            this.activeSnapGuides.push(s.guide);
                        }
                    }
                }

                newW = Math.max(newW, 1);
                newH = Math.max(newH, 1);

                // Update live bounds for the renderer to show smooth handles
                this.liveResizeBounds = {
                    x: bounds.x + moveX,
                    y: bounds.y + moveY,
                    w: newW,
                    h: newH,
                };

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
                    // Text is auto-width: resize_node is a no-op for it, so scale
                    // the font size (geometric mean of the axes) instead. Read from
                    // the just-restored snapshot state, so it never compounds.
                    const tg =
                        this.scene.getNodeType(id) === 4
                            ? this.scene.getNodeGeometry(id)?.Text
                            : null;
                    if (tg) {
                        const newSize = Math.max(
                            1,
                            Math.min(2000, tg.font_size * Math.sqrt(Math.abs(scaleX * scaleY))),
                        );
                        this.scene.engine!.set_text_content(id, tg.content, newSize);
                    } else {
                        this.scene.engine!.resize_node(
                            id,
                            (b[2] - b[0]) * scaleX,
                            (b[3] - b[1]) * scaleY,
                        );
                    }
                    const nb = this.scene.getNodeBounds(id);
                    const dx = targetX - nb[0];
                    const dy = targetY - nb[1];
                    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
                        const local = this.worldDeltaToLocal(id, dx, dy);
                        this.scene.engine!.move_node(id, local.dx, local.dy);
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
                    this.activeSnapGuides = snapped.guides.filter(
                        (g) => (g.axis === 'x' && !xLocked) || (g.axis === 'y' && !yLocked),
                    );
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
                    const local = this.worldDeltaToLocal(id, totalDx, totalDy);
                    this.scene.engine!.move_node(id, local.dx, local.dy);
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

            // If in path edit mode, marquee selects points
            if (
                this.ui.activeTool === 'direct' &&
                this.editingNodeId !== null &&
                this.editingPoints &&
                this.editingTransform
            ) {
                const t = this.editingTransform;
                const rect = this.marqueeRect;

                if (!e.shiftKey) this.selectedPoints.clear();

                for (let si = 0; si < this.editingPoints.length; si++) {
                    const sp = this.editingPoints[si];
                    for (let i = 0; i < sp.points.length; i++) {
                        const p = sp.points[i];
                        const wx = t[0] * p.x + t[1] * p.y + t[2];
                        const wy = t[3] * p.x + t[4] * p.y + t[5];
                        if (
                            wx >= rect.x &&
                            wx <= rect.x + rect.w &&
                            wy >= rect.y &&
                            wy <= rect.y + rect.h
                        ) {
                            this.selectedPoints.add(`${si}:${i}`);
                        }
                    }
                }
                // Keep the context bar's selected-point count live during the marquee
                this.ui.contextBar?.refresh();
            }
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

        // Line tool: track the moving endpoint (snap, or Shift → 45° steps).
        if (this.previewLine) {
            let cur = this.currentPos;
            this.activeSnapGuides = [];
            if (e.shiftKey) {
                const c = this.snapAngle45(cur.x - this.startPos.x, cur.y - this.startPos.y);
                cur = { x: this.startPos.x + c.dx, y: this.startPos.y + c.dy };
            } else if (!e.metaKey && !e.ctrlKey) {
                const s = this.snap.snapPoint(cur.x, cur.y, 8 / this.renderer.zoom);
                cur = { x: s.x, y: s.y };
                this.activeSnapGuides = s.guides;
            }
            this.previewLine.x2 = cur.x;
            this.previewLine.y2 = cur.y;
        }

        // Pencil tool: sample the freehand stroke, thinning near-duplicate points.
        if (this.pencilPoints) {
            const last = this.pencilPoints[this.pencilPoints.length - 1];
            const minGap = 2 / this.renderer.zoom;
            if (Math.hypot(this.currentPos.x - last.x, this.currentPos.y - last.y) >= minGap) {
                this.pencilPoints.push({ x: this.currentPos.x, y: this.currentPos.y });
            }
        }

        // Pen tool: adjust control handles while dragging after placing an anchor
        if (
            this.ui.activeTool === 'pen' &&
            this.isDraggingHandle &&
            this.currentPathPoints.length > 0
        ) {
            // Dead-zone: ignore sub-threshold jitter so a click stays a crisp
            // corner. Once past it, latch into drag mode for the rest of the press.
            if (!this.penHandleDragging) {
                const moved =
                    Math.hypot(
                        this.currentPos.x - this.startPos.x,
                        this.currentPos.y - this.startPos.y,
                    ) * this.renderer.zoom;
                if (moved < InputManager.PEN_HANDLE_DEAD_ZONE) return;
                this.penHandleDragging = true;
            }
            // When closing the path, the drag shapes the handle of the first
            // anchor (the point we're joining back to); otherwise the last one.
            const anchor = this.penClosingDrag
                ? this.currentPathPoints[0]
                : this.currentPathPoints[this.currentPathPoints.length - 1];
            let hdx = this.currentPos.x - anchor.x;
            let hdy = this.currentPos.y - anchor.y;

            // Shift: snap handle to 45° angles
            if (e.shiftKey) {
                const snapped = this.snapAngle45(hdx, hdy);
                hdx = snapped.dx;
                hdy = snapped.dy;
            }

            anchor.cp2x = anchor.x + hdx;
            anchor.cp2y = anchor.y + hdy;
            // Alt: break tangent — only move outgoing handle, don't mirror
            if (!e.altKey) {
                anchor.cp1x = anchor.x - hdx;
                anchor.cp1y = anchor.y - hdy;
            }
        }

        // Direct selection: drag point or handle
        if (
            this.ui.activeTool === 'direct' &&
            this.draggingHandleType &&
            this.editingPoints &&
            this.editingTransform
        ) {
            const sp = this.editingPoints[this.draggingSubpathIndex];
            if (!sp) return;
            const p = sp.points[this.draggingPointIndex];
            if (!p) return;

            // Compute world-space drag position
            let worldPos = this.currentPos;
            this.activeSnapGuides = [];

            if (this.draggingHandleType === 'anchor') {
                // Snapping for anchors (bypass with Cmd/Ctrl)
                if (!e.metaKey && !e.ctrlKey) {
                    const s = this.snap.snapPoint(worldPos.x, worldPos.y, 8 / this.renderer.zoom);
                    worldPos = { x: s.x, y: s.y };
                    this.activeSnapGuides = s.guides;
                }

                // Axis constraint (Shift)
                if (e.shiftKey) {
                    worldPos = this.constrainToAxis(this.startPos, worldPos);
                }
            }

            const local = this.worldToLocal(worldPos.x, worldPos.y);

            if (this.draggingHandleType === 'anchor') {
                const ldx = local.x - p.x;
                const ldy = local.y - p.y;

                // Move all selected points
                for (const key of this.selectedPoints) {
                    const [si, pi] = key.split(':').map(Number);
                    const pt = this.editingPoints[si].points[pi];
                    pt.x += ldx;
                    pt.y += ldy;
                    pt.cp1[0] += ldx;
                    pt.cp1[1] += ldy;
                    pt.cp2[0] += ldx;
                    pt.cp2[1] += ldy;
                }
            } else if (this.draggingHandleType === 'cp1') {
                p.cp1[0] = local.x;
                p.cp1[1] = local.y;
                // Alt: break tangent — move only this handle. While pulling a
                // new handle out of an anchor (convertingAnchor), keep it
                // symmetric even though Alt is held.
                if (!e.altKey || this.convertingAnchor) {
                    p.cp2[0] = 2 * p.x - local.x;
                    p.cp2[1] = 2 * p.y - local.y;
                }
            } else if (this.draggingHandleType === 'cp2') {
                p.cp2[0] = local.x;
                p.cp2[1] = local.y;
                // Alt: break tangent — move only this handle. While pulling a
                // new handle out of an anchor (convertingAnchor), keep it
                // symmetric even though Alt is held.
                if (!e.altKey || this.convertingAnchor) {
                    p.cp1[0] = 2 * p.x - local.x;
                    p.cp1[1] = 2 * p.y - local.y;
                }
            }
            // Live update the engine so it renders immediately
            this.scene.engine!.update_path_points(
                this.editingNodeId!,
                JSON.stringify(this.editingPoints),
            );
            this.scene.invalidateCache();
            this.ui.syncWithSelection({ interactive: true });
        }
    }

    onMouseUp(e: MouseEvent) {
        if (!this.isMouseDown) return;
        this.isMouseDown = false;
        this.dragMode = 'none';
        this.isDraggingHandle = false;
        this.penHandleDragging = false;
        this.snap.end();
        this.activeSnapGuides = [];

        // Finish a path that was just closed on the first anchor. Deferred to
        // mouse-up so the click could pull a bezier handle off the closing point.
        if (this.penClosingDrag) {
            this.finalizePenPath();
            return;
        }

        // End artboard move/resize drag
        if (this.artboardDrag) {
            this.endArtboardDrag();
            return;
        }

        // End viewport pan drag
        if (this.panDrag) {
            this.panDrag = null;
            this.canvas.style.cursor = this.isSpacePan ? 'grab' : 'default';
            return;
        }

        // Commit gradient handle drag
        if (this.gradientDragActive) {
            this.gradientDragActive = false;
            this.ui.gradientEdit.endDrag();
            this.ui.syncWithSelection();
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
        // Clean up corner radius dragging
        if (this.cornerRadiusDragging) {
            this.cornerRadiusDragging = null;
            this.scene.invalidateCache();
            this.scene.autosave?.trigger();
            this.ui.syncWithSelection();
            return;
        }

        // Restore the cursor to match the active tool (a locked creation tool
        // keeps its crosshair; Selection gets the default arrow). A revert to
        // Selection later in this handler re-applies it via setActiveTool.
        this.ui.applyToolCursor();

        if (this.rotateHandleType) {
            this.rotateHandleType = null;
            this.rotateSnapshot = null;
            this.rotateTargetIds = [];
            this.rotatePivot = null;
            this.rotateSingleStartDeg = null;
            this.scene.invalidateCache();
            this.scene.autosave?.trigger();
            this.ui.syncWithSelection();
            return;
        }

        if (this.resizeHandleType) {
            this.resizeHandleType = null;
            this.resizeStartBounds = null;
            this.resizeTargetIds = [];
            this.resizeSnapshot = null;
            this.liveResizeBounds = null;
            this.resizeFrame = null;
            this.resizeLocalBounds = null;
            this.liveFrame = null;
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
            // Alt-click on an anchor without dragging collapses its handles,
            // converting a smooth point back to a corner. (A real drag already
            // pulled symmetric handles out via convertingAnchor.)
            if (this.convertingAnchor && dist <= 3) {
                const sp = this.editingPoints[this.draggingSubpathIndex];
                const p = sp?.points[this.draggingPointIndex];
                if (p) {
                    p.cp1[0] = p.x;
                    p.cp1[1] = p.y;
                    p.cp2[0] = p.x;
                    p.cp2[1] = p.y;
                    this.scene.engine!.update_path_points(
                        this.editingNodeId!,
                        JSON.stringify(this.editingPoints),
                    );
                }
            }
            this.scene.updatePathPoints(this.editingNodeId!, JSON.stringify(this.editingPoints));
            this.draggingPointIndex = -1;
            this.draggingHandleType = null;
            this.convertingAnchor = false;
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

        // Commit line / pencil strokes (their own point-based previews).
        if (this.previewLine) {
            this.finalizeLine();
        }
        if (this.pencilPoints) {
            this.finalizePencil();
        }

        // Commit shape creation (use previewRect which already has Shift/Alt constraints applied)
        if (this.previewRect && (this.previewRect.w > 5 || this.previewRect.h > 5)) {
            const { x, y, w, h, tool } = this.previewRect;

            if (tool === 'artboard') {
                // Create a new artboard (frame) and select it, then revert to the
                // selection tool like Figma.
                const id = this.scene.addArtboard(x, y, w, h);
                this.scene.engine!.clear_selection();
                this.renderer.selectedArtboardId = id;
                this.ui.syncWithSelection();
                this.ui.refreshArtboardPanel();
                this.ui.updateLayerList();
                this.maybeRevertTool();
            } else {
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
                    this.maybeRevertTool();
                }
                this.ui.updateLayerList();
            }
        }

        this.dragMode = 'none';
        this.previewRect = null;
        this.previewLine = null;
        this.pencilPoints = null;
        this.marqueeRect = null;
    }

    /** Turn the line-tool preview into a 2-point open path, styled and selected. */
    finalizeLine() {
        const L = this.previewLine;
        this.previewLine = null;
        if (!L) return;
        // Ignore degenerate clicks that never became a drag.
        if (Math.hypot(L.x2 - L.x1, L.y2 - L.y1) < 2) return;
        const mk = (x: number, y: number) => ({ x, y, cp1: [x, y], cp2: [x, y] });
        const subpaths = [{ points: [mk(L.x1, L.y1), mk(L.x2, L.y2)], closed: false }];
        this.commitDrawnPath(JSON.stringify(subpaths));
    }

    /** Turn the sampled pencil stroke into an open path, styled and selected. */
    finalizePencil() {
        const pts = this.pencilPoints;
        this.pencilPoints = null;
        if (!pts || pts.length < 2) return;
        const mk = (p: { x: number; y: number }) => ({
            x: p.x,
            y: p.y,
            cp1: [p.x, p.y],
            cp2: [p.x, p.y],
        });
        const subpaths = [{ points: pts.map(mk), closed: false }];
        this.commitDrawnPath(JSON.stringify(subpaths));
    }

    /** Add a freshly drawn path (line/pencil), apply the active style, select it.
     *  Open strokes are stroke-only — a fill would shade the region between the
     *  endpoints, which is never what you want from a line or freehand stroke. */
    private commitDrawnPath(subpathsJson: string) {
        const newId = this.scene.addPath(subpathsJson);
        let style = this.ui.getCurrentStyle();
        try {
            const s = JSON.parse(style);
            s.fills = [];
            style = JSON.stringify(s);
        } catch {
            /* fall back to the raw style */
        }
        this.scene.setNodeStyleNoHistory(newId, style);
        this.scene.engine!.clear_selection();
        this.scene.selectNode(newId, false);
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
        this.maybeRevertTool();
    }

    /** After creating a shape, one-shot back to the Selection tool (Figma-style)
     *  unless the tool is locked via double-click. */
    private maybeRevertTool() {
        if (this.ui.toolLocked) return;
        this.ui.setActiveTool('selection');
    }

    /** Union of the selected nodes' world bounds, or null if nothing is selected. */
    getSelectionBounds(): { x: number; y: number; w: number; h: number } | null {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return null;

        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
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

    checkResizeHandle(
        pos: { x: number; y: number },
        frame?: SelectionFrame | null,
    ): { type: string } | null {
        const F = frame ?? this.getSelectionFrame();
        if (!F) return null;

        // Nearest handle within reach wins, so tiny shapes stay usable.
        let best: { type: string } | null = null;
        let bestDist = 8 / this.renderer.zoom;
        for (const h of this.frameHandles(F)) {
            const d = Math.hypot(pos.x - h.x, pos.y - h.y);
            if (d < bestDist) {
                bestDist = d;
                best = { type: h.type };
            }
        }
        return best;
    }

    // ─── Selection frame (oriented bounding box) ────────────────────────

    /** Map a frame-space point to world space. */
    private framePoint(F: SelectionFrame, fx: number, fy: number): { x: number; y: number } {
        return { x: F.m.a * fx + F.m.c * fy + F.m.e, y: F.m.b * fx + F.m.d * fy + F.m.f };
    }

    /** Apply an affine matrix to a point. */
    private matApply(M: Mat, p: { x: number; y: number }): { x: number; y: number } {
        return { x: M.a * p.x + M.c * p.y + M.e, y: M.b * p.x + M.d * p.y + M.f };
    }

    /** True when the frame's axes are world-axis-aligned with no flip — the
     *  case the legacy AABB resize pipeline (with snapping) handles. */
    private frameIsAxisAligned(F: SelectionFrame): boolean {
        return Math.abs(F.m.b) < 1e-6 && Math.abs(F.m.c) < 1e-6 && F.m.a > 0 && F.m.d > 0;
    }

    /**
     * The selection frame the handles live on. Single node → its local bounds
     * under its world transform, so the frame rotates/skews with the shape.
     * Multi-selection (or unknown local bounds) → axis-aligned union bounds.
     * During a drag the live frame is returned so handles track with zero lag.
     */
    getSelectionFrame(): SelectionFrame | null {
        if (this.liveFrame) return this.liveFrame;
        if (this.liveResizeBounds) {
            const b = this.liveResizeBounds;
            return { w: b.w, h: b.h, m: { a: 1, b: 0, c: 0, d: 1, e: b.x, f: b.y } };
        }
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 1) {
            const id = selection[0];
            const lb = this.getNodeLocalBounds(id);
            if (lb && lb.w > 1e-6 && lb.h > 1e-6) {
                const t = this.scene.getTransform(id); // row-major world [a,b,tx, c,d,ty, …]
                const W: Mat = { a: t[0], b: t[3], c: t[1], d: t[4], e: t[2], f: t[5] };
                return {
                    w: lb.w,
                    h: lb.h,
                    m: this.matMul(W, { a: 1, b: 0, c: 0, d: 1, e: lb.x, f: lb.y }),
                };
            }
        }
        const b = this.getSelectionBounds();
        return b ? { w: b.w, h: b.h, m: { a: 1, b: 0, c: 0, d: 1, e: b.x, f: b.y } } : null;
    }

    /** After a geometry/font resize, translate the node so its local-bounds
     *  top-left lands on the live frame's top-left — keeping the drag anchor
     *  (the handle opposite the one being dragged) fixed. */
    private anchorNodeToFrameTopLeft(id: number) {
        if (!this.liveFrame) return;
        const lb2 = this.getNodeLocalBounds(id);
        if (!lb2) return;
        const wt = this.scene.getTransform(id);
        const W: Mat = { a: wt[0], b: wt[3], c: wt[1], d: wt[4], e: wt[2], f: wt[5] };
        const actual = this.matApply(W, { x: lb2.x, y: lb2.y });
        const target = this.framePoint(this.liveFrame, 0, 0);
        const ddx = target.x - actual.x,
            ddy = target.y - actual.y;
        if (Math.abs(ddx) > 1e-4 || Math.abs(ddy) > 1e-4) {
            const local = this.worldDeltaToLocal(id, ddx, ddy);
            this.scene.engine!.move_node(id, local.dx, local.dy);
        }
    }

    /**
     * A node's bounds in its own local (pre-transform) space, mirroring what
     * the renderer draws for the selection outline. Groups union their
     * children's local bounds through the children's local transforms.
     */
    getNodeLocalBounds(
        id: number,
        depth = 0,
    ): { x: number; y: number; w: number; h: number } | null {
        if (depth > 16) return null;
        if (this.scene.getNodeType(id) === 3) {
            // Group
            const kids = this.scene.getNodeChildren(id);
            let minX = Infinity,
                minY = Infinity,
                maxX = -Infinity,
                maxY = -Infinity;
            for (const kid of kids) {
                const lb = this.getNodeLocalBounds(kid, depth + 1);
                if (!lb) continue;
                const l = this.scene.getNodeLocalTransform(kid); // column-major
                const M: Mat = { a: l[0], b: l[1], c: l[3], d: l[4], e: l[6], f: l[7] };
                for (const [cx, cy] of [
                    [lb.x, lb.y],
                    [lb.x + lb.w, lb.y],
                    [lb.x + lb.w, lb.y + lb.h],
                    [lb.x, lb.y + lb.h],
                ]) {
                    const p = this.matApply(M, { x: cx, y: cy });
                    minX = Math.min(minX, p.x);
                    minY = Math.min(minY, p.y);
                    maxX = Math.max(maxX, p.x);
                    maxY = Math.max(maxY, p.y);
                }
            }
            return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }
        const geo = this.scene.getNodeGeometry(id);
        if (geo.Rect) return { x: 0, y: 0, w: geo.Rect.width, h: geo.Rect.height };
        if (geo.Image) return { x: 0, y: 0, w: geo.Image.width, h: geo.Image.height };
        if (geo.Ellipse) {
            const { radius_x: rx, radius_y: ry } = geo.Ellipse;
            return { x: -rx, y: -ry, w: 2 * rx, h: 2 * ry };
        }
        if (geo.Path) {
            const b = this.renderer.calculatePathBounds({
                subpaths: this.scene.getResolvedSubpaths(id),
            });
            return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
        }
        if (geo.Text) {
            const b = this.renderer.getTextLocalBounds(id);
            if (b) return b;
            const approxW = geo.Text.content.length * geo.Text.font_size * 0.6;
            return { x: 0, y: -geo.Text.font_size, w: approxW, h: geo.Text.font_size };
        }
        return null;
    }

    /** The 8 resize handle positions of a frame, in world space. */
    private frameHandles(F: SelectionFrame): Array<{ type: string; x: number; y: number }> {
        const mw = F.w / 2,
            mh = F.h / 2;
        const spots: Array<[string, number, number]> = [
            ['nw', 0, 0],
            ['n', mw, 0],
            ['ne', F.w, 0],
            ['w', 0, mh],
            ['e', F.w, mh],
            ['sw', 0, F.h],
            ['s', mw, F.h],
            ['se', F.w, F.h],
        ];
        return spots.map(([type, fx, fy]) => ({ type, ...this.framePoint(F, fx, fy) }));
    }

    /**
     * Detect the rotate zone: the ring just *outside* a corner of the selection
     * frame. Returns the nearest corner within reach, or null. Only fires when
     * the cursor is outside the frame (so it never conflicts with move/resize),
     * giving the familiar "nudge past the resize handle → rotate" affordance.
     */
    checkRotateHandle(
        pos: { x: number; y: number },
        frame?: SelectionFrame | null,
    ): { type: string } | null {
        const F = frame ?? this.getSelectionFrame();
        if (!F) return null;

        // Must be outside the frame — inside is move/resize territory.
        const p = this.matApply(this.matInv(F.m), pos);
        if (p.x >= 0 && p.x <= F.w && p.y >= 0 && p.y <= F.h) return null;

        const outer = 18 / this.renderer.zoom;
        const corners: Array<[string, number, number]> = [
            ['nw', 0, 0],
            ['ne', F.w, 0],
            ['se', F.w, F.h],
            ['sw', 0, F.h],
        ];

        let best: { type: string } | null = null;
        let bestDist = outer;
        for (const [type, fx, fy] of corners) {
            const c = this.framePoint(F, fx, fy);
            const d = Math.hypot(pos.x - c.x, pos.y - c.y);
            if (d < bestDist) {
                bestDist = d;
                best = { type };
            }
        }
        return best;
    }

    /**
     * Rotate every target about {@link rotatePivot} by `deltaRad` (world space),
     * starting from the pre-drag snapshot. Uses full matrix composition so it is
     * correct for any node, nesting, and pivot:
     *   L' = parentWorld⁻¹ · R(θ, pivot) · parentWorld · L₀
     */
    private applyRotationDrag(deltaRad: number) {
        if (!this.rotateSnapshot || !this.rotatePivot) return;
        this.scene.engine!.deserialize_scene(this.rotateSnapshot);

        const cos = Math.cos(deltaRad),
            sin = Math.sin(deltaRad);
        const px = this.rotatePivot.x,
            py = this.rotatePivot.y;
        // World rotation about the pivot, DOMMatrix form {a,b,c,d,e,f}:
        //   x' = a·x + c·y + e,  y' = b·x + d·y + f
        const R: Mat = {
            a: cos,
            b: sin,
            c: -sin,
            d: cos,
            e: px - px * cos + py * sin,
            f: py - px * sin - py * cos,
        };

        for (const id of this.rotateTargetIds) {
            const parentId = this.scene.engine!.get_node_parent(id);
            let PW: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
            if (parentId >= 0) {
                // getTransform is row-major global [a,b,tx, c,d,ty, …]
                const t = this.scene.getTransform(parentId);
                PW = { a: t[0], b: t[3], c: t[1], d: t[4], e: t[2], f: t[5] };
            }
            // getNodeLocalTransform is column-major [a,b,0, c,d,0, e,f,1]
            const l = this.scene.getNodeLocalTransform(id);
            const L0: Mat = { a: l[0], b: l[1], c: l[3], d: l[4], e: l[6], f: l[7] };

            const Lp = this.matMul(this.matInv(PW), this.matMul(R, this.matMul(PW, L0)));
            const col = [Lp.a, Lp.b, 0, Lp.c, Lp.d, 0, Lp.e, Lp.f, 1];
            this.scene.engine!.set_node_transform_matrix(id, JSON.stringify(col));
        }

        this.scene.invalidateCache();
        this.ui.syncWithSelection({ interactive: true });
    }

    /** Compose two affine matrices: result applies B first, then A. */
    private matMul(A: Mat, B: Mat): Mat {
        return {
            a: A.a * B.a + A.c * B.b,
            b: A.b * B.a + A.d * B.b,
            c: A.a * B.c + A.c * B.d,
            d: A.b * B.c + A.d * B.d,
            e: A.a * B.e + A.c * B.f + A.e,
            f: A.b * B.e + A.d * B.f + A.f,
        };
    }

    /** Invert an affine matrix (falls back to identity-ish on a singular matrix). */
    private matInv(A: Mat): Mat {
        const det = A.a * A.d - A.b * A.c;
        const inv = Math.abs(det) < 1e-12 ? 0 : 1 / det;
        return {
            a: A.d * inv,
            b: -A.b * inv,
            c: -A.c * inv,
            d: A.a * inv,
            e: (A.c * A.f - A.d * A.e) * inv,
            f: (A.b * A.e - A.a * A.f) * inv,
        };
    }

    /** Rotate cursor for a corner of the frame: oriented by the world-space
     *  direction from the frame center to that corner, so it stays correct on
     *  rotated frames. */
    private rotateCursorForCorner(type: string, F: SelectionFrame): string {
        const fx = type.includes('e') ? F.w : 0;
        const fy = type.includes('s') ? F.h : 0;
        const c = this.framePoint(F, fx, fy);
        const center = this.framePoint(F, F.w / 2, F.h / 2);
        return this.rotateCursorForAngle(
            Math.atan2(c.y - center.y, c.x - center.x) * (180 / Math.PI),
        );
    }

    /** Build (and cache) a small rotate cursor. `deg` is the world direction of
     *  the corner being grabbed (glyph art is drawn for the SE corner ≈ 45°). */
    private rotateCursorForAngle(deg: number): string {
        const r = Math.round((deg - 45) / 15) * 15;
        const key = `rot:${r}`;
        if (this.cursorCache[key]) return this.cursorCache[key];
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">` +
            `<g transform="rotate(${r} 11 11)">` +
            `<path d="M11 4.5 A 6.5 6.5 0 1 1 4.5 11" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>` +
            `<polygon points="11,0.8 11,8.2 15.5,4.5" fill="#fff"/>` +
            `<path d="M11 4.5 A 6.5 6.5 0 1 1 4.5 11" fill="none" stroke="#111" stroke-width="1.5" stroke-linecap="round"/>` +
            `<polygon points="11,1.9 11,7.1 14.2,4.5" fill="#111"/>` +
            `</g></svg>`;
        const uri = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 11 11, auto`;
        this.cursorCache[key] = uri;
        return uri;
    }

    /** Resize cursor for a handle: native CSS cursors on axis-aligned frames,
     *  an angle-oriented double arrow on rotated/skewed frames. */
    private resizeCursorFor(type: string, F: SelectionFrame): string {
        if (this.frameIsAxisAligned(F)) {
            const cursorMap: Record<string, string> = {
                nw: 'nwse-resize',
                se: 'nwse-resize',
                ne: 'nesw-resize',
                sw: 'nesw-resize',
                n: 'ns-resize',
                s: 'ns-resize',
                e: 'ew-resize',
                w: 'ew-resize',
            };
            return cursorMap[type] || 'default';
        }
        // Resize direction in frame space → world space via the linear part.
        const dx = type.includes('e') ? 1 : type.includes('w') ? -1 : 0;
        const dy = type.includes('s') ? 1 : type.includes('n') ? -1 : 0;
        const wx = F.m.a * dx + F.m.c * dy;
        const wy = F.m.b * dx + F.m.d * dy;
        const deg = Math.atan2(wy, wx) * (180 / Math.PI);
        // Double arrow is symmetric — fold to [0,180) before caching.
        const r = (((Math.round(deg / 10) * 10) % 180) + 180) % 180;
        const key = `arrow:${r}`;
        if (this.cursorCache[key]) return this.cursorCache[key];
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">` +
            `<g transform="rotate(${r} 11 11)">` +
            `<path d="M5 11 H17" stroke="#fff" stroke-width="4.2" stroke-linecap="round"/>` +
            `<polygon points="1.5,11 6.8,7.2 6.8,14.8" fill="#fff"/>` +
            `<polygon points="20.5,11 15.2,7.2 15.2,14.8" fill="#fff"/>` +
            `<path d="M6 11 H16" stroke="#111" stroke-width="1.6"/>` +
            `<polygon points="2.8,11 7,8.2 7,13.8" fill="#111"/>` +
            `<polygon points="19.2,11 15,8.2 15,13.8" fill="#111"/>` +
            `</g></svg>`;
        const uri = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 11 11, auto`;
        this.cursorCache[key] = uri;
        return uri;
    }

    checkCornerRadiusHandle(pos: { x: number; y: number }): { nodeId: number } | null {
        const selection = this.scene.getSelection();
        if (selection.length !== 1) return null;

        const id = selection[0];
        const node = this.scene.getNode(id);
        // Groups report a placeholder Rect{0,0}; require positive dimensions so
        // only real rectangles expose draggable corner-radius handles.
        if (!node?.geometry.Rect || node.geometry.Rect.width <= 0 || node.geometry.Rect.height <= 0)
            return null;

        const rect = node.geometry.Rect;
        const radius = node.style.corner_radius || 0;
        const transform = this.scene.getTransform(id);

        // Convert world position to local space
        // Skia row-major: [a, b, tx, c, d, ty, 0, 0, 1]
        const a = transform[0],
            b = transform[1],
            tx = transform[2];
        const c = transform[3],
            d = transform[4],
            ty = transform[5];

        const det = a * d - b * c;
        if (Math.abs(det) < 1e-6) return null;
        const invDet = 1 / det;
        const ia = d * invDet;
        const ib = -b * invDet;
        const ic = -c * invDet;
        const id_ = a * invDet;
        const itx = (b * ty - d * tx) * invDet;
        const ity = (c * tx - a * ty) * invDet;

        const lx = ia * pos.x + ib * pos.y + itx;
        const ly = ic * pos.x + id_ * pos.y + ity;

        const visualMin = 14 / this.renderer.zoom;
        const rx = Math.min(Math.max(radius, visualMin), rect.width / 2);
        const ry = Math.min(Math.max(radius, visualMin), rect.height / 2);

        const handlePos = [
            [rx, ry],
            [rect.width - rx, ry],
            [rect.width - rx, rect.height - ry],
            [rx, rect.height - ry],
        ];

        const threshold = 10 / this.renderer.zoom;
        for (const [hx, hy] of handlePos) {
            if (Math.abs(lx - hx) < threshold && Math.abs(ly - hy) < threshold) {
                return { nodeId: id };
            }
        }
        return null;
    }

    /**
     * Find the node that should be selected given a hit position and the current selection.
     * This implements "context-aware" selection: if you are inside a group, you select
     * siblings/children of that group. If not, you select the topmost group.
     */
    private getTargetIdForHit(
        pos: { x: number; y: number },
        deepSelect: boolean = false,
    ): number | undefined {
        const rawHitId = this.scene.hitTest(pos.x, pos.y);
        if (rawHitId === undefined) return undefined;

        if (deepSelect) {
            return rawHitId;
        }

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

    /** Convert a text node to a path node (destructive). Parses the font with
     *  opentype.js off the cached TTF, so it's async (font may need fetching). */
    async createOutlines(id: number) {
        const geo = this.scene.getNodeGeometry(id)?.Text;
        if (!geo) return;
        const subpaths = await textNodeToSubpaths(geo, this.renderer.ck);
        if (subpaths && subpaths.length > 0) {
            this.scene.replaceGeometryWithPath(id, subpaths);
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
            this.renderer.requestRender();
        }
    }
}
