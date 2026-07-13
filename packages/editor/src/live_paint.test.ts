/**
 * Live Paint integration tests, driven against the REAL wasm Engine through
 * WasmScene (loaded headless, same pattern as gesture_history.test.ts).
 *
 * Two layers are covered:
 *   A. The WasmScene Live Paint surface (face fills, group scoping, the
 *      live_paint special-object flag, edge painting) + save/load round-trips.
 *   B. getEditorContext classification — the logic behind the two UI bugs that
 *      were reported: the bar must switch to Live Paint when the tool is armed
 *      (even with a selection), and a Live Paint group must read as its own
 *      object, not a plain group.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import init, { Engine, History } from '../engine/pkg/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { getEditorContext } from './context';
import type { InputManager } from './input';
import type { UIEngine } from './ui';
import { WasmScene } from './wasm_scene';

beforeAll(async () => {
    await init({ module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')) });
});

function makeScene(): WasmScene {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    return scene;
}

/** Minimal fakes for the non-scene collaborators getEditorContext reads. */
function fakeUI(activeTool: string): UIEngine {
    return { activeTool } as unknown as UIEngine;
}
function fakeInput(): InputManager {
    return {
        editingNodeId: null,
        currentPathPoints: [],
        editingPoints: null,
        selectedPoints: new Set<string>(),
    } as unknown as InputManager;
}

/** Wrap `ids` in a Live Paint–flagged group and make it active. Shapes only
 * form a paint surface inside a flagged group, so tests call this before
 * painting/querying. */
function makeLP(e: Engine, ids: number[]): number {
    const g = e.group_nodes(JSON.stringify(ids));
    e.set_node_live_paint(g, true);
    e.set_live_paint_group(g);
    return g;
}

// ─── A. WasmScene Live Paint surface ───────────────────────────────────────

describe('Live Paint — engine surface via WasmScene', () => {
    it('two overlapping rects make three distinct fillable regions', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        makeLP(e, [a, b]);
        const aOnly = e.query_face_at(25, 25);
        const overlap = e.query_face_at(75, 75);
        const bOnly = e.query_face_at(125, 125);
        expect(aOnly).toBeGreaterThanOrEqual(0);
        expect(overlap).toBeGreaterThanOrEqual(0);
        expect(bOnly).toBeGreaterThanOrEqual(0);
        expect(new Set([aOnly, overlap, bOnly]).size).toBe(3);
    });

    it('setFaceFill stores a region fill that get_filled_faces returns', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        makeLP(e, [a, b]);
        const overlap = e.query_face_at(75, 75);
        scene.setFaceFill(overlap, 0, 1, 0, 1);
        expect(e.get_filled_faces()).toContain('"g":1.0');
    });

    it('a region fill follows its shape across a large move (containment signature)', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        makeLP(e, [a, b]);
        const aOnly = e.query_face_at(25, 25);
        scene.setFaceFill(aOnly, 1, 0, 0, 1);
        e.move_node(a, 400, 400); // separate the rects entirely
        expect(e.get_filled_faces()).toContain('"r":1.0');
    });

    it('the live_paint flag scopes painting; a second group is independent', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        const outside = e.add_rect(500, 500, 100, 100); // outside the group
        const group = makeLP(e, [a, b]);
        expect(scene.getLivePaintGroup()).toBe(group);
        expect(e.query_face_at(75, 75)).toBeGreaterThanOrEqual(0); // in group
        expect(e.query_face_at(550, 550)).toBe(-1); // outside → not paintable

        // A second flagged group is its OWN network — both coexist.
        makeLP(e, [outside]);
        expect(e.query_face_at(550, 550)).toBeGreaterThanOrEqual(0); // now paintable
        expect(e.query_face_at(75, 75)).toBeGreaterThanOrEqual(0); // first group still works
    });

    it('a face carries an exact-bézier outline (true curves, not a polygon)', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const c = e.add_ellipse(200, 200, 100, 100); // circle r=100
        makeLP(e, [c]);
        const f = e.query_face_at(200, 200);
        scene.setFaceFill(f, 1, 0, 0, 1);
        const faces = JSON.parse(e.get_filled_faces());
        const outline = faces[0].outline as Array<{
            x: number;
            y: number;
            cp1: number[];
            cp2: number[];
        }>;
        expect(Array.isArray(outline)).toBe(true);
        expect(outline.length).toBeGreaterThanOrEqual(3);
        // Real handles ⇒ curved (a polygon would have handles coincident with anchors).
        const curved = outline.some((p) => Math.hypot(p.cp1[0] - p.x, p.cp1[1] - p.y) > 1);
        expect(curved).toBe(true);
    });

    it('the live_paint flag is groups-only and survives save/load', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 100, 100);
        const g = e.group_nodes(JSON.stringify([r]));

        scene.setNodeLivePaint(r, true);
        expect(scene.getNodeLivePaint(r)).toBe(false); // non-group ignores the flag
        scene.setNodeLivePaint(g, true);
        expect(scene.getNodeLivePaint(g)).toBe(true);
        scene.setLivePaintGroup(g);

        // Round-trip through the snapshot format undo/save use.
        const snap = e.serialize_scene();
        const e2 = new Engine();
        expect(e2.deserialize_scene(snap)).toBe(true);
        expect(e2.get_node_live_paint(g)).toBe(true);
        expect(e2.get_live_paint_group()).toBe(g);
    });

    it('a painted edge round-trips through save/load', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 200, 200);
        makeLP(e, [r]);
        const edge = scene.queryEdgeAt(100, 0, 8); // on the top edge
        expect(edge).toBeGreaterThanOrEqual(0);
        scene.setEdgePaint(edge, 1, 0, 0, 1, 4);
        expect(e.get_painted_edges()).toContain('"r":1.0');

        const snap = e.serialize_scene();
        const e2 = new Engine();
        expect(e2.deserialize_scene(snap)).toBe(true);
        expect(e2.get_painted_edges()).toContain('"r":1.0');
    });
});

// ─── B. getEditorContext classification (the reported UI bugs) ──────────────

describe('Live Paint — editor context classification', () => {
    it('the paint-bucket tool wins over a selection (bar switches to Live Paint)', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r1 = e.add_rect(0, 0, 100, 100);
        const r2 = e.add_rect(120, 0, 100, 100);
        e.select_node(r1, false);
        e.select_node(r2, true); // 2 shapes selected

        // Selection tool → the selection wins.
        expect(getEditorContext(fakeUI('selection'), fakeInput(), scene).context).toBe(
            'multi-select',
        );
        // Paint-bucket tool → Live Paint wins even with the selection.
        expect(getEditorContext(fakeUI('paint-bucket'), fakeInput(), scene).context).toBe(
            'live-paint',
        );
    });

    it('a selected Live Paint group reads as its own object, not a plain group', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r1 = e.add_rect(0, 0, 100, 100);
        const r2 = e.add_rect(50, 50, 100, 100);
        const group = e.group_nodes(JSON.stringify([r1, r2]));

        e.clear_selection();
        e.select_node(group, false);
        // Plain group first.
        expect(getEditorContext(fakeUI('selection'), fakeInput(), scene).context).toBe(
            'group-selected',
        );
        // Flag it → it becomes a Live Paint object.
        scene.setNodeLivePaint(group, true);
        expect(getEditorContext(fakeUI('selection'), fakeInput(), scene).context).toBe(
            'live-paint-object',
        );
    });
});
