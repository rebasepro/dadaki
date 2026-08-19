/**
 * The editor's states, the modifier keys, and the transitions between them.
 *
 * Selection and creation are covered elsewhere (`interaction_sweep`,
 * `pen_text_sweep`). This file is about the MODES a person can be in — at the
 * root, inside a group, editing a path, holding a tool — and about the two keys
 * that move between them, Escape and Enter. Mode bugs are the expensive kind:
 * the click you make next means something different from what you intended, and
 * nothing on screen necessarily says so.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { InputManager } from './input';
import type { Renderer } from './renderer';
import type { UIEngine } from './ui';
import { WasmScene } from './wasm_scene';

let wasmModule: { memory: WebAssembly.Memory };
beforeAll(async () => {
    wasmModule = await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});
beforeEach(() => {
    document.body.innerHTML = '<div id="canvas-container"></div>';
});

function makeScene(): WasmScene {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    scene.wasm = wasmModule;
    return scene;
}
function makeRenderer(): Renderer {
    return {
        zoom: 1,
        pan: { x: 0, y: 0 },
        dpr: 1,
        requestRender() {},
        notifyViewChange() {},
        onViewChange() {},
        clearImageCache() {},
        beginDragLayerCache: () => false,
        setDragMovingRoots() {},
        endDragLayerCache() {},
        invalidateGroupSpriteFor() {},
        invalidateAllGroupSprites() {},
        hoverEdgeId: -1,
        hoverFaceId: -1,
        selectedArtboardId: null,
        artboardHandleHitTest: () => null,
        artboardLabelHitTest: () => null,
    } as unknown as Renderer;
}
/** A UI stub that behaves like UIEngine where the transitions depend on it. */
function makeUI(activeTool = 'selection') {
    const ui = {
        activeTool,
        toolLocked: false,
        setActiveTool(t: string, lock = false) {
            ui.activeTool = t;
            ui.toolLocked = lock;
            // Mirrors UIEngine.setActiveTool: leaving the pen commits, leaving
            // node-editing exits. Tests of "what mode am I in" are worthless if
            // the stub silently skips the part that changes modes.
            const im = ui.__im as InputManager | undefined;
            if (!im) return;
            im.commitActiveTextEdit();
            if (t !== 'pen' && im.currentPathPoints.length > 0) im.finalizePenPath();
            if (im.editingNodeId !== null) im.exitEditMode();
        },
        __im: undefined as InputManager | undefined,
        getCurrentStyle: () =>
            JSON.stringify({
                fills: [{ r: 0.8, g: 0.8, b: 0.8, a: 1 }],
                strokes: [
                    {
                        paint: { r: 0, g: 0, b: 0, a: 1 },
                        width: 1,
                        cap: 0,
                        join: 0,
                        dash_array: [],
                        dash_offset: 0,
                        miter_limit: 4,
                        alignment: 'Center',
                    },
                ],
                opacity: 1,
                blend_mode: 0,
                corner_radius: 0,
            }),
        syncWithSelection() {},
        updateLayerList() {},
        hideContextMenu() {},
        refreshArtboardPanel() {},
        applyToolCursor() {},
        collapseSubtreeByDefault() {},
        contextBar: { refresh() {} },
        setActiveRegion() {},
        gradientEdit: { isActive: () => false, hitTest: () => null, stopFocused: false },
        meshEdit: { selectedVertices: new Set(), cancelDrag() {} },
    };
    return ui;
}
const mouse = (clientX: number, clientY: number, o: Record<string, unknown> = {}) =>
    ({
        clientX,
        clientY,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        button: 0,
        detail: 1,
        preventDefault() {},
        stopPropagation() {},
        ...o,
    }) as unknown as MouseEvent;
const keyEv = (key: string, o: Record<string, unknown> = {}) =>
    ({
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        shiftKey: false,
        metaKey: false,
        altKey: false,
        ctrlKey: false,
        target: document.body,
        preventDefault() {},
        stopPropagation() {},
        ...o,
    }) as unknown as KeyboardEvent;

function makeInput(scene: WasmScene, tool = 'selection') {
    const ui = makeUI(tool);
    const input = new InputManager(
        document.createElement('canvas'),
        scene,
        ui as unknown as UIEngine,
        makeRenderer(),
    );
    ui.__im = input;
    return { input, ui };
}
const click = (i: InputManager, x: number, y: number, o: Record<string, unknown> = {}) => {
    i.onMouseDown(mouse(x, y, o));
    i.onMouseUp(mouse(x, y, o));
};
const sel = (s: WasmScene) => Array.from(s.engine!.get_selection());

/** A group of two rects, plus a loose rect outside it. */
function nested(scene: WasmScene) {
    const e = scene.engine!;
    const a = e.add_rect(0, 0, 60, 60);
    const b = e.add_rect(80, 0, 60, 60);
    const g = e.group_nodes(JSON.stringify([a, b]));
    const loose = e.add_rect(0, 200, 60, 60);
    return { a, b, g, loose };
}

describe('states: getting into a group and back out', () => {
    it('a click selects the group; a double-click goes one level in', () => {
        const scene = makeScene();
        const { a, g } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        expect(sel(scene)).toEqual([g]);
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([a]);
    });

    it('once inside, a plain click selects siblings, not the group again', () => {
        const scene = makeScene();
        const { a, b } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([a]);
        click(input, 110, 30);
        expect(sel(scene)).toEqual([b]);
    });

    it('Escape steps out to the group, and again to nothing', () => {
        const scene = makeScene();
        const { a, g } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([a]);
        input.onKeyDown(keyEv('Escape'));
        expect(sel(scene)).toEqual([g]);
        input.onKeyDown(keyEv('Escape'));
        expect(sel(scene)).toEqual([]);
    });

    it('Enter is the way in: it drills into a selected group', () => {
        const scene = makeScene();
        const { g } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        expect(sel(scene)).toEqual([g]);
        input.onKeyDown(keyEv('Enter'));
        expect(sel(scene)).not.toEqual([g]);
        expect(sel(scene).length).toBe(1);
    });

    it('clicking a shape OUTSIDE the group leaves the group', () => {
        const scene = makeScene();
        const { loose } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        click(input, 30, 230);
        expect(sel(scene)).toEqual([loose]);
    });
});

describe('states: node editing', () => {
    it('double-clicking a lone shape enters node editing; Escape leaves it', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 100, 100);
        const { input } = makeInput(scene);
        click(input, 50, 50);
        input.onDoubleClick(mouse(50, 50));
        expect(input.editingNodeId).toBe(r);
        input.onKeyDown(keyEv('Escape'));
        expect(input.editingNodeId).toBeNull();
    });

    it('switching tools leaves node editing rather than leaving it armed', () => {
        const scene = makeScene();
        const e = scene.engine!;
        e.add_rect(0, 0, 100, 100);
        const { input, ui } = makeInput(scene);
        click(input, 50, 50);
        input.onDoubleClick(mouse(50, 50));
        expect(input.editingNodeId).not.toBeNull();
        ui.setActiveTool('rect');
        expect(input.editingNodeId).toBeNull();
    });

    it('Enter also leaves node editing, and hands back the selection tool', () => {
        const scene = makeScene();
        const e = scene.engine!;
        e.add_rect(0, 0, 100, 100);
        const { input, ui } = makeInput(scene);
        click(input, 50, 50);
        input.onDoubleClick(mouse(50, 50));
        input.onKeyDown(keyEv('Enter'));
        expect(input.editingNodeId).toBeNull();
        expect(ui.activeTool).toBe('selection');
    });
});

describe('states: an armed tool is its own mode', () => {
    it('Escape disarms a creation tool back to selection', () => {
        const scene = makeScene();
        const { input, ui } = makeInput(scene, 'rect');
        input.onKeyDown(keyEv('Escape'));
        expect(ui.activeTool).toBe('selection');
    });

    it('Escape with a live pen path commits it before disarming', () => {
        const scene = makeScene();
        const { input, ui } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 0);
        input.onKeyDown(keyEv('Escape'));
        const roots = JSON.parse(scene.engine!.get_scene_json()).root_nodes;
        expect(roots.length).toBe(1);
        // The path is committed; the tool goes back on the NEXT Escape, so the
        // first one is never ambiguous between "finish this" and "put it away".
        input.onKeyDown(keyEv('Escape'));
        expect(ui.activeTool).toBe('selection');
    });
});

describe('modifiers: what each one means with the selection tool', () => {
    it('shift adds to and removes from the selection', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 60, 60);
        const b = e.add_rect(80, 0, 60, 60);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        click(input, 110, 30, { shiftKey: true });
        expect(sel(scene).sort()).toEqual([a, b].sort());
        click(input, 110, 30, { shiftKey: true });
        expect(sel(scene)).toEqual([a]);
    });

    it('cmd reaches inside a group without entering it', () => {
        const scene = makeScene();
        const { a, g } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30, { metaKey: true });
        expect(sel(scene)).toEqual([a]);
        // Deep-select picks the leaf, but does NOT put you inside the group:
        // Escape goes straight back to the group, as from any selected member.
        input.onKeyDown(keyEv('Escape'));
        expect(sel(scene)).toEqual([g]);
    });

    it('alt-drag clones instead of moving', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 60, 60);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        const before = JSON.parse(e.get_scene_json()).root_nodes.length;
        input.onMouseDown(mouse(30, 30, { altKey: true }));
        input.onMouseMove(mouse(120, 30, { altKey: true }));
        input.onMouseUp(mouse(120, 30, { altKey: true }));
        expect(JSON.parse(e.get_scene_json()).root_nodes.length).toBe(before + 1);
        expect(Array.from(scene.getNodeBounds(r))[0]).toBeCloseTo(0, 3);
    });

    it('shift-drag constrains a move to one axis', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 60, 60);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        const before = Array.from(scene.getNodeBounds(r));
        input.onMouseDown(mouse(30, 30, { shiftKey: true }));
        input.onMouseMove(mouse(130, 44, { shiftKey: true })); // mostly horizontal
        input.onMouseUp(mouse(130, 44, { shiftKey: true }));
        const after = Array.from(scene.getNodeBounds(r));
        expect(after[0]).toBeGreaterThan(before[0]);
        expect(after[1]).toBeCloseTo(before[1], 3); // y unchanged
    });
});

describe('transitions: one mode at a time', () => {
    it('arming a tool while inside a group does not silently leave it', () => {
        const scene = makeScene();
        const { a } = nested(scene);
        const { input, ui } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([a]);
        ui.setActiveTool('rect');
        // Still inside: a shape drawn now belongs to the group you are in.
        expect(sel(scene)).toEqual([a]);
    });

    it('entering text editing closes a live pen path rather than running both', () => {
        const scene = makeScene();
        const { input, ui } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 0);
        ui.setActiveTool('text');
        expect(input.currentPathPoints.length).toBe(0);
        expect(JSON.parse(scene.engine!.get_scene_json()).root_nodes.length).toBe(1);
    });

    it('deleting the shape you are editing leaves node editing behind', () => {
        const scene = makeScene();
        const e = scene.engine!;
        e.add_rect(0, 0, 100, 100);
        const { input } = makeInput(scene);
        click(input, 50, 50);
        input.onDoubleClick(mouse(50, 50));
        expect(input.editingNodeId).not.toBeNull();
        input.deleteSelection();
        // Editing a node that no longer exists is a state nothing can get out
        // of: the panel shows its properties, clicks route to its points.
        expect(input.editingNodeId).toBeNull();
    });
});

/** group( group(a, b), c ) — two levels deep, plus a loose rect at the root. */
function twoLevels(scene: WasmScene) {
    const e = scene.engine!;
    const a = e.add_rect(0, 0, 60, 60);
    const b = e.add_rect(80, 0, 60, 60);
    const inner = e.group_nodes(JSON.stringify([a, b]));
    const c = e.add_rect(0, 100, 60, 60);
    const outer = e.group_nodes(JSON.stringify([inner, c]));
    return { a, b, c, inner, outer };
}

describe('states: nested groups climb one level at a time', () => {
    it('double-click drills one level per click, not straight to the leaf', () => {
        const scene = makeScene();
        const { a, inner, outer } = twoLevels(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        expect(sel(scene)).toEqual([outer]);
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([inner]);
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([a]);
    });

    it('Escape climbs back out the same way', () => {
        const scene = makeScene();
        const { a, inner, outer } = twoLevels(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([a]);
        input.onKeyDown(keyEv('Escape'));
        expect(sel(scene)).toEqual([inner]);
        input.onKeyDown(keyEv('Escape'));
        expect(sel(scene)).toEqual([outer]);
        input.onKeyDown(keyEv('Escape'));
        expect(sel(scene)).toEqual([]);
    });

    it('clicking outside the group you are in drops you back to the top level', () => {
        const scene = makeScene();
        const { c, outer } = twoLevels(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        input.onDoubleClick(mouse(30, 30));
        // `c` lives in the OUTER group, not the inner one being edited. Clicking
        // it leaves the context rather than reaching sideways into a level you
        // are not in — the same rule as Illustrator's isolation mode — so what
        // gets selected is the top-level object that contains it.
        click(input, 30, 130);
        expect(sel(scene)).toEqual([outer]);
        expect(c).toBeGreaterThan(0);
    });
});

describe('modifiers: combinations', () => {
    it('shift+cmd adds a deep-selected leaf to the selection', () => {
        const scene = makeScene();
        const { a, loose } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 230); // the loose rect
        expect(sel(scene)).toEqual([loose]);
        click(input, 30, 30, { metaKey: true, shiftKey: true });
        expect(sel(scene).sort()).toEqual([a, loose].sort());
    });

    it('an alt-dragged copy lands where the pointer left it', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 60, 60);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onMouseDown(mouse(30, 30, { altKey: true }));
        input.onMouseMove(mouse(130, 80, { altKey: true }));
        input.onMouseUp(mouse(130, 80, { altKey: true }));
        const roots = JSON.parse(e.get_scene_json()).root_nodes;
        const copy = roots.find((id: number) => id !== r)!;
        const b = Array.from(scene.getNodeBounds(copy));
        // Dragged +100,+50 from a rect at the origin.
        expect(b[0]).toBeCloseTo(100, 3);
        expect(b[1]).toBeCloseTo(50, 3);
    });

    it('alt+shift drag clones along one axis', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 60, 60);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        const before = JSON.parse(e.get_scene_json()).root_nodes.length;
        input.onMouseDown(mouse(30, 30, { altKey: true, shiftKey: true }));
        input.onMouseMove(mouse(130, 40, { altKey: true, shiftKey: true }));
        input.onMouseUp(mouse(130, 40, { altKey: true, shiftKey: true }));
        const roots = JSON.parse(e.get_scene_json()).root_nodes;
        expect(roots.length).toBe(before + 1);
        expect(Array.from(scene.getNodeBounds(r))[0]).toBeCloseTo(0, 3);
        const copy = roots.find((id: number) => id !== r)!;
        // Constrained: the clone shares the original's y.
        expect(Array.from(scene.getNodeBounds(copy))[1]).toBeCloseTo(0, 3);
    });

    it('cmd-clicking an already deep-selected leaf keeps it selected', () => {
        const scene = makeScene();
        const { a } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30, { metaKey: true });
        expect(sel(scene)).toEqual([a]);
        click(input, 30, 30, { metaKey: true });
        expect(sel(scene)).toEqual([a]);
    });
});

describe('states: the bucket is a mode of its own', () => {
    function painted(scene: WasmScene) {
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 120, 120);
        const b = e.add_rect(80, 0, 120, 120);
        const g = e.group_nodes(JSON.stringify([a, b]));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);
        return { a, b, g };
    }

    it('arming the bucket with a selection makes a Live Paint group of it', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 120, 120);
        const b = e.add_rect(80, 0, 120, 120);
        const { input, ui } = makeInput(scene);
        e.select_node(a, false);
        e.select_node(b, true);
        ui.setActiveTool('paint-bucket');
        input.enterPaintBucketMode();
        expect(e.get_live_paint_group()).toBeGreaterThan(0);
    });

    it('Escape from the bucket goes back to selection, keeping the group', () => {
        const scene = makeScene();
        const { g } = painted(scene);
        const { input, ui } = makeInput(scene, 'paint-bucket');
        input.onKeyDown(keyEv('Escape'));
        expect(ui.activeTool).toBe('selection');
        expect(scene.engine!.get_node_live_paint(g)).toBe(true);
    });

    it('double-clicking a Live Paint group with the bucket held stays painting', () => {
        const scene = makeScene();
        const { g } = painted(scene);
        const { input, ui } = makeInput(scene, 'paint-bucket');
        input.onDoubleClick(mouse(40, 40));
        // The bucket drills between painted groups; it must not drop into
        // node-editing, which would leave the click meaning something else.
        expect(input.editingNodeId).toBeNull();
        expect(ui.activeTool).toBe('paint-bucket');
        expect(g).toBeGreaterThan(0);
    });
});

describe('transitions: nothing is left pointing at a corpse', () => {
    it('undo does not leave the selection holding a deleted id', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 60, 60);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.deleteSelection();
        scene.undo();
        // Whatever the selection is after undo, every id in it must exist.
        for (const id of sel(scene)) expect(e.get_node_type(id)).not.toBeUndefined();
        expect(r).toBeGreaterThan(0);
    });

    it('deleting the last member of a group you are inside does not strand you', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 60, 60);
        const g = e.group_nodes(JSON.stringify([a]));
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        input.deleteSelection();
        for (const id of sel(scene)) expect(e.get_node_type(id)).not.toBeUndefined();
        expect(g).toBeGreaterThan(0);
    });
});
