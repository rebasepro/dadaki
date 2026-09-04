/**
 * Going into a group brings the Objects panel with you.
 *
 * Entering a group is navigation, not selection: after it, "where am I" is a
 * real question, and the only thing on screen that can answer it is the panel.
 * It used to answer wrongly — still showing the collapsed group you were
 * looking at, with the child you had just entered hidden inside it and
 * possibly scrolled off the list entirely. `revealSelection` (the panel's
 * Locate button) already knew how to expand the ancestors and scroll; nothing
 * called it.
 *
 * These tests drive the real InputManager against the real engine, with the
 * panel stubbed, and assert on WHAT it was asked to reveal.
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

let wasmModule: { memory: WebAssembly.Memory };
beforeAll(async () => {
    wasmModule = await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});

/** What the panel was asked to reveal, in order — as node ids, read off the
 *  selection at the moment of the call, which is what the real one does. */
interface Reveals {
    ui: UIEngine;
    calls: number[][];
}

function makeUI(scene: WasmScene, activeTool = 'selection'): Reveals {
    const calls: number[][] = [];
    const ui = {
        activeTool,
        setActiveTool(t: string) {
            (ui as { activeTool: string }).activeTool = t;
        },
        syncWithSelection() {},
        updateLayerList() {},
        revealSelection() {
            calls.push(Array.from(scene.engine!.get_selection()));
        },
        hideContextMenu() {},
        refreshArtboardPanel() {},
        applyToolCursor() {},
        collapseSubtreeByDefault() {},
        contextBar: { refresh() {} },
        setActiveRegion() {},
        gradientEdit: { isActive: () => false, hitTest: () => null },
    } as unknown as UIEngine;
    return { ui, calls };
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

/** Two rects side by side, grouped. Returns the group and its members. */
function groupedScene() {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    scene.wasm = wasmModule;
    const a = scene.engine.add_rect(0, 0, 40, 40);
    const b = scene.engine.add_rect(60, 0, 40, 40);
    const group = scene.engine.group_nodes(JSON.stringify([a, b]));
    return { scene, group, a, b };
}

const dbl = (x: number, y: number) =>
    ({
        clientX: x,
        clientY: y,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        button: 0,
        detail: 2,
        preventDefault() {},
        stopPropagation() {},
    }) as unknown as MouseEvent;

describe('entering a group reveals it in the Objects panel', () => {
    it('double-clicking into a group reveals the child you landed on', () => {
        const { scene, group, a } = groupedScene();
        const { ui, calls } = makeUI(scene);
        const input = new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());

        scene.selectNode(group, false);
        input.onDoubleClick(dbl(20, 20));

        expect(calls).toEqual([[a]]);
    });

    it('Enter on a selected group reveals its first member', () => {
        const { scene, group, a } = groupedScene();
        const { ui, calls } = makeUI(scene);
        const input = new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());

        scene.selectNode(group, false);
        input.enterSelectedNode(group);

        // The same "go inside" verb the context bar's Edit button and the
        // breadcrumb use, so all three leave the panel in the same place.
        expect(calls).toEqual([[a]]);
    });

    it('reveals again, one level deeper, on a nested group', () => {
        const { scene, group, a } = groupedScene();
        // Wrap the pair in an outer group, so entering twice is a real descent.
        const outer = scene.engine!.group_nodes(JSON.stringify([group]));
        const { ui, calls } = makeUI(scene);
        const input = new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());

        scene.selectNode(outer, false);
        input.onDoubleClick(dbl(20, 20)); // outer → inner group
        input.onDoubleClick(dbl(20, 20)); // inner group → the rect

        expect(calls).toEqual([[group], [a]]);
    });

    it('does not reveal when the double-click lands on empty canvas', () => {
        const { scene, group } = groupedScene();
        const { ui, calls } = makeUI(scene);
        const input = new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());

        scene.selectNode(group, false);
        input.onDoubleClick(dbl(400, 400));

        expect(calls).toEqual([]);
    });

    it('does not drill in — or reveal — while a creation tool is armed', () => {
        // A double-click with the rectangle tool is two zero-size drags, not a
        // request to go inside whatever is underneath.
        const { scene, group } = groupedScene();
        const { ui, calls } = makeUI(scene, 'rect');
        const input = new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());

        scene.selectNode(group, false);
        input.onDoubleClick(dbl(20, 20));

        expect(calls).toEqual([]);
    });
});
