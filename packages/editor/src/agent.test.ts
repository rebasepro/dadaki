/**
 * Contracts for the agent authoring API (`EditorHandle.agent`).
 *
 * The invariant worth pinning is undo granularity: ONE agent call must be
 * exactly ONE undo step, so a human can step back through an agent's work at
 * the same granularity they'd step through their own. This is easy to break —
 * every `WasmScene` wrapper pushes its own history entry, so a composite verb
 * like `createRect({fill})` (add + style) silently becomes two steps unless it
 * is wrapped in `transaction()`.
 *
 * "Exactly one" is provable by byte-comparing `serialize_scene()` against the
 * pre-call snapshot: if the call pushed 0 steps, one undo overshoots past it;
 * if it pushed 2, one undo lands on an intermediate state. Only exactly-one
 * lands byte-equal on the pre-call state.
 *
 * Runs against the REAL wasm engine + History, stubbing only the renderer,
 * autosave and CanvasKit that this path never touches.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { type AgentApi, createAgentApi } from './agent';
import { WasmScene } from './wasm_scene';

beforeAll(async () => {
    await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});

function makeAgent(): { agent: AgentApi; scene: WasmScene; selection: number[] } {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    // Selection is owned by the UI engine in the real editor; here a plain
    // array stands in, which is all the agent API actually needs.
    const state = { selection: [] as number[] };
    const agent = createAgentApi({
        scene,
        ck: {} as never,
        getSelection: () => state.selection,
        setSelection: (ids) => {
            state.selection = ids;
        },
        exportSVG: () => '<svg/>',
    });
    return { agent, scene, selection: state.selection };
}

const snapshot = (scene: WasmScene): number[] => Array.from(scene.engine!.serialize_scene());

/**
 * Assert `fn` produces exactly one undo step: after running it, a single undo
 * must land byte-equal on the state captured before it ran.
 */
function expectOneUndoStep(label: string, fn: (a: AgentApi, s: WasmScene) => void) {
    const { agent, scene } = makeAgent();
    // Seed a shape so verbs that need an existing target have one, and so the
    // pre-state is non-trivial (an empty scene would mask an overshooting undo).
    const seed = agent.createRect(0, 0, 10, 10);
    const before = snapshot(scene);

    fn(agent, scene);
    expect(snapshot(scene), `${label} should have changed the scene`).not.toEqual(before);

    scene.undo();
    expect(snapshot(scene), `${label} should be exactly one undo step`).toEqual(before);
    return seed;
}

describe('agent API — undo granularity', () => {
    it('createRect with style is one step, not two', () => {
        expectOneUndoStep('createRect+style', (a) => {
            a.createRect(20, 20, 50, 50, { fill: '#ff0000', stroke: '#000000', strokeWidth: 2 });
        });
    });

    it('createEllipse with style is one step', () => {
        expectOneUndoStep('createEllipse+style', (a) => {
            a.createEllipse(40, 40, 20, 10, { fill: '#00ff00' });
        });
    });

    it('createPath with style is one step', () => {
        expectOneUndoStep('createPath+style', (a) => {
            a.createPath(
                [
                    { x: 0, y: 0 },
                    { x: 50, y: 0 },
                    { x: 50, y: 50 },
                ],
                true,
                { fill: '#0000ff' },
            );
        });
    });

    it('setFill across MULTIPLE nodes is one step for the whole batch', () => {
        const { agent, scene } = makeAgent();
        const a1 = agent.createRect(0, 0, 10, 10);
        const a2 = agent.createRect(20, 0, 10, 10);
        const a3 = agent.createRect(40, 0, 10, 10);
        const before = snapshot(scene);

        agent.setFill([a1, a2, a3], '#123456');
        expect(snapshot(scene)).not.toEqual(before);

        scene.undo();
        expect(snapshot(scene), 'a 3-node recolor is one undo, not three').toEqual(before);
    });

    it('move across multiple nodes is one step', () => {
        const { agent, scene } = makeAgent();
        const a1 = agent.createRect(0, 0, 10, 10);
        const a2 = agent.createRect(20, 0, 10, 10);
        const before = snapshot(scene);

        agent.move([a1, a2], 15, 25);
        scene.undo();
        expect(snapshot(scene)).toEqual(before);
    });

    it('group is one step', () => {
        const { agent, scene } = makeAgent();
        const a1 = agent.createRect(0, 0, 10, 10);
        const a2 = agent.createRect(20, 0, 10, 10);
        const before = snapshot(scene);

        agent.group([a1, a2]);
        scene.undo();
        expect(snapshot(scene)).toEqual(before);
    });

    it('removing multiple nodes is one step', () => {
        const { agent, scene } = makeAgent();
        const a1 = agent.createRect(0, 0, 10, 10);
        const a2 = agent.createRect(20, 0, 10, 10);
        const before = snapshot(scene);

        agent.remove([a1, a2]);
        scene.undo();
        expect(snapshot(scene), 'a 2-node delete is one undo, not two').toEqual(before);
    });
});

describe('agent API — describe()', () => {
    it('reports geometry and style in the units the agent supplied', () => {
        const { agent } = makeAgent();
        agent.createRect(10, 20, 100, 50, { fill: '#ff0000' });

        const desc = agent.describe();
        expect(desc.nodes).toHaveLength(1);
        const [node] = desc.nodes;
        expect(node.fill).toBe('#ff0000');
        // Bounds are [x, y, w, h] in world units — the same numbers that went in.
        expect(node.bounds[2]).toBeCloseTo(100, 1);
        expect(node.bounds[3]).toBeCloseTo(50, 1);
    });

    it('nests children under groups so the agent can see structure', () => {
        const { agent } = makeAgent();
        const a1 = agent.createRect(0, 0, 10, 10);
        const a2 = agent.createRect(20, 0, 10, 10);
        agent.group([a1, a2]);

        const desc = agent.describe();
        expect(desc.nodes).toHaveLength(1);
        expect(desc.nodes[0].children?.map((c) => c.id).sort()).toEqual([a1, a2].sort());
    });

    it('returns null fill for unfilled nodes rather than inventing a colour', () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10);
        agent.setFill(id, null);
        expect(agent.describeNode(id)?.fill).toBeNull();
    });

    it('describeNode returns null for an unknown id', () => {
        const { agent } = makeAgent();
        expect(agent.describeNode(99999)).toBeNull();
    });
});

describe('agent API — input validation', () => {
    it('rejects a malformed colour instead of silently painting black', () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10);
        expect(() => agent.setFill(id, 'not-a-colour')).toThrow(/invalid color/);
    });

    it('accepts shorthand and alpha hex forms', () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10);
        agent.setFill(id, '#f00');
        expect(agent.describeNode(id)?.fill).toBe('#ff0000');
        agent.setFill(id, '#ff000080');
        expect(agent.describeNode(id)?.fill).toMatch(/^#ff0000/);
    });

    it('rejects a path with too few points', () => {
        const { agent } = makeAgent();
        expect(() => agent.createPath([{ x: 0, y: 0 }])).toThrow(/at least 2 points/);
    });

    // A stale id otherwise reaches getNodeStyle, whose JSON.parse of the
    // engine's empty string surfaces as "Unexpected end of JSON input" — which
    // tells an agent nothing about what went wrong or how to recover.
    it('names the unknown id instead of leaking a JSON parse error', () => {
        const { agent } = makeAgent();
        expect(() => agent.setFill(999, '#ffffff')).toThrow(/no object with id 999/);
        expect(() => agent.rotate(999, 45)).toThrow(/no object with id 999/);
        expect(() => agent.remove(999)).toThrow(/no object with id 999/);
    });

    it('reports every missing id in a batch, not just the first', () => {
        const { agent } = makeAgent();
        const ok = agent.createRect(0, 0, 10, 10);
        expect(() => agent.setFill([ok, 777, 888], '#ffffff')).toThrow(/777, 888/);
    });

    it('rejects a boolean op on fewer than 2 nodes', () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10);
        expect(() => agent.boolean([id], 'union')).toThrow(/at least 2 nodes/);
    });
});

describe('agent API — createPath geometry', () => {
    // The engine's `add_path` deserializes with `unwrap_or_default()`, so a
    // control-point shape mismatch produces a silently EMPTY path — it renders
    // as nothing and reports zero bounds, with no error anywhere. Pin the real
    // geometry so a format drift fails loudly here instead of in artwork.
    it('produces a path with real bounds, not a silently empty one', () => {
        const { agent } = makeAgent();
        const id = agent.createPath(
            [
                { x: 270, y: 350 },
                { x: 450, y: 220 },
                { x: 630, y: 350 },
            ],
            true,
            { fill: '#a63d40' },
        );
        const node = agent.describeNode(id);
        expect(node, 'path node should exist').not.toBeNull();
        const [, , w, h] = node!.bounds;
        expect(w, 'path width should span the supplied points').toBeCloseTo(360, 0);
        expect(h, 'path height should span the supplied points').toBeCloseTo(130, 0);
    });

    it('honours explicit control points', () => {
        const { agent } = makeAgent();
        const id = agent.createPath(
            [
                { x: 0, y: 0 },
                { x: 100, y: 0, cp1x: 25, cp1y: -60, cp2x: 75, cp2y: -60 },
            ],
            false,
        );
        // The curve bulges above y=0, so the bbox must be taller than the
        // straight-line case (which would be zero-height).
        expect(agent.describeNode(id)!.bounds[3]).toBeGreaterThan(0);
    });
});

describe('agent API — creation defaults', () => {
    // The engine's default node style has a black 2px stroke. A human sees and
    // deletes it; an agent won't notice a thin dark outline in a render and
    // will ship artwork with unintended borders. Creation must be opt-in.
    it('does not add a stroke the caller never asked for', () => {
        const { agent } = makeAgent();
        const id = agent.createEllipse(100, 100, 45, 45, { fill: '#f5c542' });
        expect(agent.describeNode(id)?.stroke, 'a fill-only request means no outline').toBeNull();
    });

    it('leaves a bare shape unstroked too', () => {
        const { agent } = makeAgent();
        expect(agent.describeNode(agent.createRect(0, 0, 10, 10))?.stroke).toBeNull();
    });

    it('still applies a stroke when one IS requested', () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10, { stroke: '#5c4033', strokeWidth: 4 });
        const node = agent.describeNode(id);
        expect(node?.stroke).toBe('#5c4033');
        expect(node?.strokeWidth).toBe(4);
    });
});

describe('agent API — styling', () => {
    it('setStroke preserves width when only the colour changes', () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10);
        agent.setStroke(id, '#000000', 7);
        agent.setStroke(id, '#ffffff');
        const node = agent.describeNode(id);
        expect(node?.strokeWidth).toBe(7);
        expect(node?.stroke).toBe('#ffffff');
    });

    it('a stroke width with no colour still paints something visible', () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10, { strokeWidth: 3 });
        const node = agent.describeNode(id);
        expect(node?.strokeWidth).toBe(3);
        expect(node?.stroke, 'width-only stroke should default to black').toBe('#000000');
    });
});
