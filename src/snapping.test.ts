import { describe, it, expect } from 'vitest';
import { SnapEngine } from './snapping';
import type { WasmScene } from './wasm_scene';

/** Minimal scene stub: two top-level nodes plus a 1000×1000 artboard. */
function makeScene(nodes: Record<number, [number, number, number, number]>, parents: Record<number, number> = {}): WasmScene {
    return {
        engine: {
            get_document_width: () => 1000,
            get_document_height: () => 1000,
        },
        getRootNodes: () => Uint32Array.from(Object.keys(nodes).map(Number).filter(id => !(id in parents))),
        getNodeParent: (id: number) => parents[id] ?? -1,
        getNodeVisible: () => true,
        getNodeBounds: (id: number) => Float32Array.from(nodes[id]),
    } as unknown as WasmScene;
}

describe('SnapEngine', () => {
    it('snaps a box edge to another node edge within threshold', () => {
        const engine = new SnapEngine();
        engine.begin(makeScene({ 1: [100, 100, 200, 200] }), []);

        // Box whose left edge is at 203 — should snap to 200 (right edge of node 1)
        const r = engine.snapBounds({ x: 203, y: 500, w: 50, h: 50 }, 8);
        expect(r.dx).toBeCloseTo(-3);
        expect(r.guides).toContainEqual({ axis: 'x', pos: 200 });
    });

    it('prefers the closest candidate among min/mid/max', () => {
        const engine = new SnapEngine();
        engine.begin(makeScene({ 1: [100, 100, 200, 200] }), []);

        // Box center at 151 → distance 1 to mid target 150; left edge at 101 → distance 1 to 100.
        // Left edge 103 (dist 3 to 100) vs center 128 — no; make it unambiguous:
        const r = engine.snapBounds({ x: 149, y: 500, w: 100, h: 50 }, 8);
        // Left edge 149 → 1 away from mid target 150; center 199 → 1 away from 200.
        // Both dist 1; the first found wins — either is a valid snap of magnitude 1.
        expect(Math.abs(r.dx)).toBeCloseTo(1);
    });

    it('does not snap outside the threshold', () => {
        const engine = new SnapEngine();
        engine.begin(makeScene({ 1: [100, 100, 200, 200] }), []);

        const r = engine.snapBounds({ x: 300, y: 300, w: 33, h: 33 }, 5);
        expect(r.dx).toBe(0);
        expect(r.dy).toBe(0);
        expect(r.guides).toHaveLength(0);
    });

    it('snaps to artboard edges and center', () => {
        const engine = new SnapEngine();
        engine.begin(makeScene({}), []);

        const p = engine.snapPoint(497, 998, 8);
        expect(p.x).toBe(500);
        expect(p.y).toBe(1000);
        expect(p.guides).toHaveLength(2);
    });

    it('excludes the dragged nodes and their root ancestors from targets', () => {
        const engine = new SnapEngine();
        // Node 2 is a child of root 1; dragging 2 must exclude root 1 entirely.
        const scene = makeScene(
            { 1: [100, 100, 200, 200], 3: [400, 400, 500, 500] },
            { 2: 1 },
        );
        engine.begin(scene, [2]);

        const r = engine.snapBounds({ x: 203, y: 103, w: 10, h: 10 }, 8);
        expect(r.dx).toBe(0); // node 1's edges are not targets
        // Node 3 still is: box center 402 snaps to node 3's left edge at 400
        // (dist 2 beats the left-edge candidate 397 → 400 at dist 3)
        const r2 = engine.snapBounds({ x: 397, y: 700, w: 10, h: 10 }, 8);
        expect(r2.dx).toBeCloseTo(-2);
        expect(r2.guides).toContainEqual({ axis: 'x', pos: 400 });
    });

    it('snapAxis returns null when inactive or out of range', () => {
        const engine = new SnapEngine();
        expect(engine.snapAxis('x', 100, 8)).toBeNull();
        engine.begin(makeScene({}), []);
        expect(engine.snapAxis('x', 700, 8)).toBeNull();
        expect(engine.snapAxis('x', 503, 8)?.value).toBe(500);
        engine.end();
        expect(engine.snapAxis('x', 503, 8)).toBeNull();
    });
});
