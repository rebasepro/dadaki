import init, { Engine, History } from '../engine/pkg/engine';
import type { AutosaveManager } from './persistence';
import type { SceneData, Transform2D, Artboard } from './types';
import type { CanvasKit } from 'canvaskit-wasm';
import type { Document } from './document';

import type { Renderer } from './renderer';

export class WasmScene {
    engine: Engine | null = null;
    history: History | null = null;
    /** WASM module instance — needed for `memory.buffer` access. */
    wasm: { memory: WebAssembly.Memory } | null = null;
    autosave: AutosaveManager | null = null;
    ck: CanvasKit;

    /** Cached scene data, invalidated on mutation. */
    private _cachedSceneData: SceneData | null = null;
    private _sceneDataDirty: boolean = true;

    /** Back-reference to the renderer for cache invalidation. */
    renderer: Renderer | null = null;

    /**
     * Mutation counter — bumped by every mutation via invalidateCache().
     * The active Document compares this against its savedCounter for dirty
     * state. Selection-only changes do NOT flow through invalidateCache(), so
     * they correctly leave this untouched.
     */
    changeCounter = 0;
    /** Notified on every mutation; pointed at the active document's markMutated. */
    onMutate: (() => void) | null = null;

    constructor(ck: CanvasKit) {
        this.ck = ck;
    }

    /** Max undo depth, retained so newDocument() can rebuild the history. */
    private maxHistorySize: number = 50;

    async init(maxHistorySize: number = 50) {
        this.maxHistorySize = maxHistorySize;
        this.wasm = await init();
        // A default engine so the scene is usable before the DocumentManager
        // attaches the first document. Session restore (per-document engines +
        // autosave) is owned by the DocumentManager, not here.
        this.engine = new Engine();
        this.history = new History(maxHistorySize);
        this.autosave = null;
        this.invalidateCache(false);
    }

    /**
     * Reset to a blank document: fresh engine, cleared history, and (optionally)
     * a set document size. Used by "New Document" and by the SVG conformance
     * harness to isolate each test. Autosave is managed per-document elsewhere.
     */
    newDocument(width?: number, height?: number) {
        this.engine = new Engine();
        this.history = new History(this.maxHistorySize);
        if (width !== undefined && height !== undefined) {
            this.engine.set_document_size(width, height);
        }
        this.autosave = null;
        // The fresh engine restarts image-id numbering, so previously-decoded
        // images/pattern shaders in the renderer would be returned for the new
        // document's colliding ids. Drop them (same reason as the .vec drop path).
        this.renderer?.clearImageCache();
        this.invalidateCache(false);
    }

    /**
     * Point the scene at a document's live engine/history/autosave. This is a
     * pointer swap, not a content change, so it does NOT bump the mutation
     * counter (invalidateCache(false)). The caller must have instantiated the
     * document's engine first.
     */
    attachDocument(doc: Document) {
        this.engine = doc.engine;
        this.history = doc.history;
        this.autosave = doc.autosave;
        // Different document → different engine with its own image-id space;
        // drop cached image/pattern shaders keyed by the previous doc's ids.
        this.renderer?.clearImageCache();
        this.invalidateCache(false);
    }

    // ─── Artboards ──────────────────────────────────────────────────────────
    // Undo-disciplined wrappers (saveHistory before the mutation) + a cached
    // getter parsing get_artboards_json, invalidated in invalidateCache().

    private _cachedArtboards: Artboard[] | null = null;

    getArtboards(): Artboard[] {
        if (this._cachedArtboards) return this._cachedArtboards;
        if (!this.engine) return [];
        try {
            this._cachedArtboards = JSON.parse(this.engine.get_artboards_json()) as Artboard[];
        } catch {
            this._cachedArtboards = [];
        }
        return this._cachedArtboards;
    }

    addArtboard(x: number, y: number, w: number, h: number): number {
        this.saveHistory();
        const id = this.engine!.add_artboard(x, y, w, h);
        this.invalidateCache();
        this.autosave?.trigger();
        return id;
    }

    removeArtboard(id: number): boolean {
        this.saveHistory();
        const ok = this.engine!.remove_artboard(id);
        this.invalidateCache();
        this.autosave?.trigger();
        return ok;
    }

    /** Resize/move an artboard. Wrap drag gestures in beginGesture/endGesture. */
    setArtboardBounds(id: number, x: number, y: number, w: number, h: number): boolean {
        this.saveHistory();
        const ok = this.engine!.set_artboard_bounds(id, x, y, w, h);
        this.invalidateCache();
        this.autosave?.trigger();
        return ok;
    }

    setArtboardName(id: number, name: string): boolean {
        this.saveHistory();
        const ok = this.engine!.set_artboard_name(id, name);
        this.invalidateCache();
        this.autosave?.trigger();
        return ok;
    }

    setArtboardBackground(id: number, r: number, g: number, b: number, a: number): boolean {
        this.saveHistory();
        const ok = this.engine!.set_artboard_background(id, r, g, b, a);
        this.invalidateCache();
        this.autosave?.trigger();
        return ok;
    }

    getRenderData(visibleIds: Uint32Array): DataView {
        if (!this.engine || !this.wasm) throw new Error("WasmScene not initialized");
        
        // Tell engine to update the binary render buffer
        this.engine.update_render_buffer(visibleIds);
        
        const ptr = this.engine.get_render_buffer();
        const size = this.engine.get_render_buffer_size();

        // Copy the buffer OUT of WASM linear memory into a JS-owned ArrayBuffer.
        // The renderer decodes images mid-iteration (get_image_bytes), which
        // allocates in WASM memory and can grow it — that would detach a view
        // held over `wasm.memory.buffer` and crash the reader ("detached
        // ArrayBuffer"). A view into our own copy can never be detached. The
        // render buffer is geometry-only (image/font bytes stay in the engine,
        // referenced by id), so it stays small and this copy is cheap.
        return new DataView(this.wasm.memory.buffer.slice(ptr, ptr + size));
    }

    /**
     * @param isMutation when true (default) this invalidation reflects a scene
     *   content change, so the dirty counter advances and the active document is
     *   notified. Structural swaps (attach/newDocument/init) pass false.
     */
    invalidateCache(isMutation = true) {
        this._sceneDataDirty = true;
        this._cachedSceneData = null;
        this._cachedArtboards = null;
        if (isMutation) {
            this.changeCounter++;
            this.onMutate?.();
        }
        // Invalidate renderer caches (paths, gradients, filled faces) and request a new frame
        if (this.renderer) {
            this.renderer.invalidateRenderCaches();
        }
    }

    addRect(x: number, y: number, w: number, h: number): number {
        this.saveHistory();
        const id = this.engine!.add_rect(x, y, w, h);
        this.invalidateCache();
        this.autosave?.trigger();
        return id;
    }

    addEllipse(cx: number, cy: number, rx: number, ry: number): number {
        this.saveHistory();
        const id = this.engine!.add_ellipse(cx, cy, rx, ry);
        this.invalidateCache();
        this.autosave?.trigger();
        return id;
    }

    addPath(pointsJson: string): number {
        this.saveHistory();
        const id = this.engine!.add_path(pointsJson);
        this.invalidateCache();
        this.autosave?.trigger();
        return id;
    }

    addPolygon(cx: number, cy: number, radius: number, sides: number): number {
        this.saveHistory();
        const id = this.engine!.add_polygon(cx, cy, radius, sides);
        this.invalidateCache();
        this.autosave?.trigger();
        return id;
    }

    addStar(cx: number, cy: number, outerR: number, innerR: number, points: number): number {
        this.saveHistory();
        const id = this.engine!.add_star(cx, cy, outerR, innerR, points);
        this.invalidateCache();
        this.autosave?.trigger();
        return id;
    }

    updatePathPoints(id: number, pointsJson: string) {
        this.saveHistory();
        this.engine!.update_path_points(id, pointsJson);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    setNodeStyle(id: number, styleJson: string) {
        this.saveHistory();
        this.engine!.set_node_style(id, styleJson);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Apply a style change without pushing history. Used for live preview during
     *  drag-editing (e.g. color picker) and for applying the current style to
     *  newly created shapes (where the creation already pushed history). */
    setNodeStyleNoHistory(id: number, styleJson: string) {
        this.engine!.set_node_style(id, styleJson);
        this.invalidateCache();
    }



    setNodeVisible(id: number, visible: boolean) {
        this.saveHistory();
        this.engine!.set_node_visible(id, visible);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    setNodeLocked(id: number, locked: boolean) {
        this.saveHistory();
        this.engine!.set_node_locked(id, locked);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Toggle whether a node masks the siblings painted above it in its group. */
    setNodeIsMask(id: number, isMask: boolean) {
        this.saveHistory();
        this.engine!.set_node_is_mask(id, isMask);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    getNodeIsMask(id: number): boolean {
        return this.engine!.get_node_is_mask(id);
    }

    /** Update a text node's weight/italic/letter-spacing. One undo step. */
    setTextStyle(id: number, fontWeight: number, italic: boolean, letterSpacing: number) {
        this.saveHistory();
        this.engine!.set_text_style(id, fontWeight, italic, letterSpacing);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Replace a node's effects (JSON array of serde-tagged Effect). One undo step. */
    setNodeEffects(id: number, effectsJson: string) {
        this.saveHistory();
        this.engine!.set_node_effects(id, effectsJson);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    getNodeEffects(id: number): string {
        return this.engine!.get_node_effects(id);
    }

    /** Register encoded image bytes and place an image node centered at (cx,cy)
     *  with the given display size. One undo step. Returns the new node id. */
    placeImage(bytes: Uint8Array, mime: string, cx: number, cy: number, w: number, h: number): number {
        let id = 0;
        this.transaction(() => {
            const imageId = this.engine!.register_image(bytes, mime);
            id = this.engine!.add_image(cx - w / 2, cy - h / 2, w, h, imageId);
        });
        this.invalidateCache();
        this.autosave?.trigger();
        return id;
    }

    moveNode(id: number, dx: number, dy: number) {
        this.engine!.move_node(id, dx, dy);
        this.invalidateCache();
        // No autosave on every move frame — too expensive. Saved on mouseUp via saveHistoryAndPersist().
    }

    /** Call after a drag operation is complete to save state for undo. */
    saveMoveHistory() {
        this.saveHistory();
        this.autosave?.trigger();
    }

    /**
     * Public entry point for callers (e.g. InputManager) that need to push an
     * explicit undo snapshot — for example before a batch of grouped nudges or
     * when exiting a group context.  Unlike the private saveHistory(), this
     * also triggers autosave so disk state stays current.
     */
    pushHistorySnapshot() {
        this.saveHistory();
        this.autosave?.trigger();
    }

    selectNode(id: number, multi: boolean) {
        this.engine!.select_node(id, multi);
    }

    hitTest(x: number, y: number): number | undefined {
        const result = this.engine!.hit_test(x, y);
        // hit_test returns Option<u32> via wasm-bindgen, which is undefined for None
        return result;
    }

    hitTestGrouped(x: number, y: number): number | undefined {
        const result = this.engine!.hit_test_grouped(x, y);
        return result;
    }

    getNodeType(id: number): number | undefined {
        return this.engine!.get_node_type(id);
    }

    getNodeParent(id: number): number {
        return this.engine!.get_node_parent(id);
    }

    /** Drop ids whose ancestor is also in the list (prevents double-moves
     *  when a group and its children are both selected). */
    dedupSelection(ids: number[] | Uint32Array): Uint32Array {
        return this.engine!.dedup_selection(JSON.stringify(Array.from(ids)));
    }

    getSelection(): Uint32Array {
        return this.engine!.get_selection();
    }

    getRootNodes(): Uint32Array {
        return this.engine!.get_root_nodes();
    }

    undo() {
        const currentState = this.engine!.serialize_scene();
        const prevState = this.history!.undo(currentState);
        if (prevState) {
            this.engine!.deserialize_scene(prevState);
            this.invalidateCache();
            this.autosave?.trigger();
        }
    }

    redo() {
        const currentState = this.engine!.serialize_scene();
        const nextState = this.history!.redo(currentState);
        if (nextState) {
            this.engine!.deserialize_scene(nextState);
            this.invalidateCache();
            this.autosave?.trigger();
        }
    }

    /** True while inside a transaction() or gesture — intermediate history
     *  pushes are suppressed. */
    private _inTransaction = false;
    /** True only when an active gesture is the owner of the current
     *  suppression (i.e. beginGesture actually acquired it). Guards endGesture
     *  from closing a transaction it didn't open, or firing with no begin. */
    private _gestureOwnsSuppression = false;

    /**
     * Group several mutations into ONE undo step. A single history snapshot
     * is taken up front; saveHistory calls made by wrapper methods inside
     * `fn` become no-ops. Nested transactions join the outermost one.
     */
    transaction<T>(fn: () => T): T {
        if (this._inTransaction) return fn();
        this.saveHistory();
        this._inTransaction = true;
        try {
            return fn();
        } finally {
            this._inTransaction = false;
            this.invalidateCache();
            this.autosave?.trigger();
        }
    }

    private saveHistory() {
        if (this._inTransaction) return;
        const state = this.engine!.serialize_scene();
        this.history!.push_state(state);
    }

    /**
     * Bracketed variant of transaction() for multi-event gestures (label
     * scrubbing, slider drags): one undo snapshot at beginGesture(), then all
     * intermediate saveHistory pushes are suppressed until endGesture().
     * No-op when already inside a transaction/gesture.
     */
    beginGesture() {
        // If suppression is already active (e.g. inside a transaction), this
        // gesture piggybacks on it and must NOT claim ownership — the outer
        // owner is responsible for closing it.
        if (this._inTransaction) return;
        this.saveHistory();
        this._inTransaction = true;
        this._gestureOwnsSuppression = true;
    }

    endGesture() {
        // Only release suppression this gesture actually acquired. A stray
        // endGesture, or one nested inside a transaction, is a no-op.
        if (!this._gestureOwnsSuppression) return;
        this._gestureOwnsSuppression = false;
        this._inTransaction = false;
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /**
     * Returns the global transform for a node as a COPIED Float32Array in Skia row-major format.
     * Safe to store — won't be overwritten by subsequent calls.
     */
    getTransform(id: number): Float32Array {
        const ptr = this.engine!.get_node_transform_ptr(id);
        // IMPORTANT: Copy the data. The WASM pointer points to a single reused buffer
        // that gets overwritten on the next get_node_transform_ptr call.
        const view = new Float32Array(this.wasm!.memory.buffer, ptr, 9);
        return new Float32Array(view);
    }

    getVisibleNodes(minX: number, minY: number, maxX: number, maxY: number): Uint32Array {
        return this.engine!.get_visible_nodes(minX, minY, maxX, maxY);
    }

    isNodeDirty(id: number): boolean {
        return this.engine!.is_node_dirty(id);
    }

    clearNodeDirty(id: number) {
        this.engine!.clear_node_dirty(id);
    }

    /**
     * Returns parsed scene data. Cached per frame — only re-parsed if the scene
     * was mutated since the last call.
     */
    getSceneData(): SceneData {
        if (this._sceneDataDirty || !this._cachedSceneData) {
            this._cachedSceneData = JSON.parse(this.engine!.get_scene_json()) as SceneData;
            this._sceneDataDirty = false;
        }
        return this._cachedSceneData;
    }

    // ─── Per-Node Getters (avoid full-scene JSON serialization) ─────────

    /** Get a single node's style. Only serializes ~200 bytes instead of the whole scene. */
    getNodeStyle(id: number): import('./types').NodeStyle {
        return JSON.parse(this.engine!.get_node_style_json(id));
    }

    /** Get a single node's geometry. */
    getNodeGeometry(id: number): import('./types').NodeGeometry {
        return JSON.parse(this.engine!.get_node_geometry_json(id));
    }

    /**
     * Get a Path node's outline with per-vertex corner radii resolved into
     * explicit arcs. Returns [] for non-path geometry. Used where the rounded
     * outline is needed rather than the editable sharp geometry (SVG export,
     * boolean ops).
     */
    getResolvedSubpaths(id: number): import('./types').Subpath[] {
        return JSON.parse(this.engine!.resolve_subpaths_json(id));
    }

    /** Get a single node's full data as a SceneNode. */
    getNode(id: number): import('./types').SceneNode | null {
        const json = this.engine!.get_node_json(id);
        if (!json) return null;
        return JSON.parse(json);
    }

    /** Get a node's display name. */
    getNodeName(id: number): string {
        return this.engine!.get_node_name(id);
    }

    /** Get a node's visible flag. */
    getNodeVisible(id: number): boolean {
        return this.engine!.get_node_visible(id);
    }

    /** Get a node's locked flag. */
    getNodeLocked(id: number): boolean {
        return this.engine!.get_node_locked(id);
    }

    /** Get a node's children IDs. */
    getNodeChildren(id: number): Uint32Array {
        return this.engine!.get_node_children(id);
    }

    /** Get a node's local transform as a column-major array. */
    getNodeLocalTransform(id: number): Float32Array {
        return this.engine!.get_node_local_transform(id);
    }

    // ─── End Per-Node Getters ───────────────────────────────────────────

    resizeNode(id: number, w: number, h: number) {
        this.saveHistory();
        this.engine!.resize_node(id, w, h);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    setNodePosition(id: number, x: number, y: number) {
        this.saveHistory();
        this.engine!.set_node_position(id, x, y);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Set the full local transform of a node via a [f32; 9] matrix (column-major). */
    setNodeTransform(id: number, transform: number[]) {
        this.saveHistory();
        this.engine!.set_node_transform_matrix(id, JSON.stringify(transform));
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Set rotation in degrees. */
    setNodeRotation(id: number, deg: number) {
        this.saveHistory();
        this.engine!.set_node_rotation(id, deg);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Set skew in degrees. */
    setNodeSkew(id: number, xDeg: number, yDeg: number) {
        this.saveHistory();
        this.engine!.set_node_skew(id, xDeg, yDeg);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Set scale factors. */
    setNodeScale(id: number, sx: number, sy: number) {
        this.saveHistory();
        this.engine!.set_node_scale(id, sx, sy);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Get decomposed transform components (position, rotation, skew, scale). */
    getNodeTransformComponents(id: number): Transform2D {
        return JSON.parse(this.engine!.get_node_transform_components(id));
    }

    /** Set all transform components at once. */
    setNodeTransformComponents(id: number, components: Transform2D) {
        this.saveHistory();
        this.engine!.set_node_transform_components(id, JSON.stringify(components));
        this.invalidateCache();
        this.autosave?.trigger();
    }

    rotateNode(id: number, angleRad: number) {
        this.saveHistory();
        // Convert radians to degrees for the new set_node_rotation API
        const components = this.getNodeTransformComponents(id);
        this.engine!.set_node_rotation(id, components.rotation_deg + angleRad * (180 / Math.PI));
        this.invalidateCache();
        this.autosave?.trigger();
    }

    flipNodeH(id: number) {
        this.saveHistory();
        this.engine!.flip_node_horizontal(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    flipNodeV(id: number) {
        this.saveHistory();
        this.engine!.flip_node_vertical(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    flattenTransform(id: number) {
        this.saveHistory();
        this.engine!.flatten_transform(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    duplicateNode(id: number): number {
        this.saveHistory();
        const newId = this.engine!.duplicate_node(id);
        this.invalidateCache();
        this.autosave?.trigger();
        return newId;
    }

    removeNode(id: number) {
        this.saveHistory();
        this.engine!.remove_node(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Remove multiple nodes in a single history snapshot. */
    removeNodes(ids: number[] | Uint32Array) {
        this.saveHistory();
        for (const id of ids) {
            this.engine!.remove_node(id);
        }
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Replace a set of nodes with a single path node (used by boolean ops).
     *  All mutations land in ONE history snapshot so a single undo restores
     *  the originals. Returns the new node's id. */
    replaceNodesWithPath(
        ids: number[] | Uint32Array,
        subpathsJson: string,
        styleJson: string | null,
    ): number {
        this.saveHistory();
        this.engine!.clear_selection();
        for (const id of ids) {
            this.engine!.remove_node(id);
        }
        const newId = this.engine!.add_path(subpathsJson);
        if (styleJson) {
            this.engine!.set_node_style(newId, styleJson);
        }
        this.engine!.select_node(newId, false);
        this.invalidateCache();
        this.autosave?.trigger();
        return newId;
    }

    /** Group the given node ids. Accepts any array-like (including the
     *  Uint32Array that get_selection() returns — JSON.stringify on a typed
     *  array would produce an object, not an array, so normalize here). */
    groupNodes(ids: number[] | Uint32Array): number {
        const idsJson = JSON.stringify(Array.from(ids));
        this.saveHistory();
        const groupId = this.engine!.group_nodes(idsJson);
        this.invalidateCache();
        this.autosave?.trigger();
        return groupId;
    }

    ungroupNode(id: number) {
        this.saveHistory();
        this.engine!.ungroup_node(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    addText(x: number, y: number, content: string, fontSize: number): number {
        this.saveHistory();
        const id = this.engine!.add_text(x, y, content, fontSize);
        this.invalidateCache();
        this.autosave?.trigger();
        return id;
    }

    /** Update a text node's content and font size. */
    setTextContent(id: number, content: string, fontSize: number) {
        this.saveHistory();
        this.engine!.set_text_content(id, content, fontSize);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Update a text node's typography properties. */
    setTextProperties(id: number, fontFamily: string, textAlign: number, lineHeight: number) {
        this.saveHistory();
        this.engine!.set_text_properties(id, fontFamily, textAlign, lineHeight);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Replace a node's geometry with a new path (for Create Outlines). */
    replaceGeometryWithPath(id: number, subpaths: any[]) {
        this.saveHistory();
        const json = JSON.stringify(subpaths);
        this.engine!.replace_geometry_with_path(id, json);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    getNodeBounds(id: number): Float32Array {
        return this.engine!.get_node_bounds(id);
    }

    /** Fill a vector-network face (paint bucket). Undoable like any other mutation. */
    setFaceFill(faceId: number, r: number, g: number, b: number, a: number) {
        this.saveHistory();
        this.engine!.set_face_fill(faceId, r, g, b, a);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    convertToPath(id: number): boolean {
        this.saveHistory();
        const converted = this.engine!.convert_to_path(id);
        if (converted) {
            this.invalidateCache();
            this.autosave?.trigger();
        }
        return converted;
    }

    bringToFront(id: number) {
        this.saveHistory();
        this.engine!.bring_to_front(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    sendToBack(id: number) {
        this.saveHistory();
        this.engine!.send_to_back(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    bringForward(id: number) {
        this.saveHistory();
        this.engine!.bring_forward(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    sendBackward(id: number) {
        this.saveHistory();
        this.engine!.send_backward(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /**
     * Move `nodeId` to become a child of `newParent` (or a root when null),
     * inserted at `index` in the parent's bottom-up child order. Preserves the
     * node's visual position. Returns false if the move was rejected (e.g. a
     * cycle or a non-group parent). One undo snapshot per call.
     */
    reorderNode(nodeId: number, newParent: number | null, index: number): boolean {
        return this.reorderNodes([nodeId], newParent, index) === 1;
    }

    /**
     * Move several nodes (given in bottom-up z-order) so they become contiguous
     * siblings under `newParent` (or roots when null), starting at `index`.
     * Preserves their relative order and visual positions. Returns the number of
     * nodes actually moved. One undo snapshot per call, taken only if at least
     * one node moved so an invalid drop leaves no dead undo step.
     */
    reorderNodes(nodeIds: number[], newParent: number | null, index: number): number {
        const snapshot = this._inTransaction ? null : this.engine!.serialize_scene();
        const moved = this.engine!.reorder_nodes(JSON.stringify(nodeIds), newParent ?? undefined, index);
        if (moved > 0) {
            if (snapshot !== null) this.history!.push_state(snapshot);
            this.invalidateCache();
            this.autosave?.trigger();
        }
        return moved;
    }
}
