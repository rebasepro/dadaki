/**
 * Who owns a click on a Live Paint group.
 *
 * The rule this pins down: the TOOL decides. The bucket paints; the selection
 * tools select and edit. Live Paint used to break it by spending double-click —
 * the one gesture that means "go deeper" everywhere else in the editor — on
 * arming the bucket, which left the shapes inside a painted group with no
 * gesture at all. The Objects panel was the only way in, and only if you thought
 * to look there.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { InputManager } from './input';
import type { Renderer } from './renderer';
import type { UIEngine } from './ui';
import { WasmScene } from './wasm_scene';

beforeAll(async () => {
    await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});

function makeScene(): WasmScene {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
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
        calculatePathBounds: () => ({ minX: 0, minY: 0, maxX: 0, maxY: 0 }),
        hoverEdgeId: -1,
        hoverFaceId: -1,
        selectedArtboardId: null,
        artboardHandleHitTest: () => null,
        artboardLabelHitTest: () => null,
    } as unknown as Renderer;
}

function makeUI(activeTool = 'selection'): UIEngine {
    const ui = {
        activeTool,
        toolLocked: false,
        setActiveTool(t: string) {
            ui.activeTool = t;
        },
        setActiveRegion() {},
        syncWithSelection() {},
        updateLayerList() {},
        collapseSubtreeByDefault() {},
        getCurrentStyle: () => '{}',
        contextBar: { refresh() {} },
        gradientEdit: { isActive: () => false, hitTest: () => null, clear() {} },
        meshEdit: { isActive: () => false },
    };
    return ui as unknown as UIEngine;
}

function mouse(clientX: number, clientY: number, detail = 1): MouseEvent {
    return {
        clientX,
        clientY,
        detail,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        button: 0,
        preventDefault() {},
        stopPropagation() {},
    } as unknown as MouseEvent;
}

/** Two overlapping rects in a Live Paint group, one region painted. */
function painted(activeTool = 'selection') {
    const scene = makeScene();
    const e = scene.engine!;
    const ui = makeUI(activeTool);
    const input = new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());
    const a = e.add_rect(0, 0, 100, 100);
    const b = e.add_rect(50, 50, 100, 100);
    const group = e.group_nodes(JSON.stringify([a, b]));
    e.set_node_live_paint(group, true);
    e.set_live_paint_group(group);
    scene.setFaceFill(e.query_face_at(75, 75), 0, 1, 0, 1);
    return { scene, e, ui, input, a, b, group };
}

describe('a Live Paint group is still a group', () => {
    it('double-click with a selection tool reaches the shape, not the bucket', () => {
        const { e, ui, input, a, group } = painted();
        e.select_node(group, false); // what the first press leaves selected

        input.onDoubleClick(mouse(25, 25, 2)); // inside `a` only

        expect(Array.from(e.get_selection())).toEqual([a]);
        expect(ui.activeTool).not.toBe('paint-bucket');
    });

    it('the shape it reaches can then be moved, and the paint follows', () => {
        const { scene, e, group, a } = painted();
        e.select_node(group, false);
        // `a` spans 0..100; a point only it covers, which the move will vacate.
        expect(e.query_face_at(80, 25)).toBeGreaterThanOrEqual(0);

        // Move the member the way a drag does: 0..100 becomes -40..60.
        scene.moveNodes([a], -40, 0);

        // The network rebuilt around the new geometry rather than going stale.
        expect(e.query_face_at(80, 25)).toBe(-1); // nothing there any more
        expect(e.query_face_at(25, 25)).toBeGreaterThanOrEqual(0); // still inside `a`
        expect(e.query_face_at(75, 75)).toBeGreaterThanOrEqual(0); // the overlap moved with it
    });

    it('the bucket keeps the gesture, so it can move scope between groups', () => {
        const { e, ui, input } = painted('paint-bucket');
        const c = e.add_rect(400, 400, 100, 100);
        const second = e.group_nodes(JSON.stringify([c]));
        e.set_node_live_paint(second, true);

        input.onDoubleClick(mouse(450, 450, 2));

        expect(ui.activeTool).toBe('paint-bucket');
        expect(e.get_live_paint_group()).toBe(second);
    });

    it('arming the bucket on the selected group starts painting it', () => {
        const { e, ui, input, group } = painted();
        e.clear_selection();
        e.select_node(group, false);

        input.enterPaintBucketMode(); // what pressing B does

        expect(ui.activeTool).toBe('paint-bucket');
        expect(e.get_live_paint_group()).toBe(group);
    });
});
