import init, { Engine, History } from '../engine/pkg/engine';
import { PersistenceManager, AutosaveManager } from './persistence';
import type { SceneData } from './types';
import type { CanvasKit } from 'canvaskit-wasm';

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

    constructor(ck: CanvasKit) {
        this.ck = ck;
    }

    async init(maxHistorySize: number = 50) {
        this.wasm = await init();
        this.engine = new Engine();
        this.history = new History(maxHistorySize);
        this.autosave = new AutosaveManager(this.engine!);
        
        // Load persisted state if exists
        await PersistenceManager.loadScene(this.engine!);
        this.invalidateCache();
    }

    invalidateCache() {
        this._sceneDataDirty = true;
        this._cachedSceneData = null;
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

    private saveHistory() {
        const state = this.engine!.serialize_scene();
        this.history!.push_state(state);
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

    /** Set the full local transform of a node (column-major [f32; 9]). */
    setNodeTransform(id: number, transform: number[]) {
        this.saveHistory();
        this.engine!.set_node_transform(id, JSON.stringify(transform));
        this.invalidateCache();
        this.autosave?.trigger();
    }

    rotateNode(id: number, angleRad: number) {
        this.saveHistory();
        this.engine!.rotate_node(id, angleRad);
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

    getNodeBounds(id: number): Float32Array {
        return this.engine!.get_node_bounds(id);
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
}
