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
        // SVG import needs the UI engine's DOM parsing and raster fallbacks,
        // neither of which exists headless; the importSVG tests assert the
        // validation that happens before this is ever reached.
        importSVG: async () => [],
        // Rasterizing needs the renderer's offscreen surface, which doesn't
        // exist headless; the transports are covered by the MCP smoke test.
        renderPNG: async () => '',
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

    // The engine defaults text to a WHITE fill, which is invisible on the
    // default white artboard. The node describes fine and draws nothing, so an
    // agent has no way to diagnose it — it just sees a blank canvas.
    it('does not create text that is invisible on a white canvas', () => {
        const { agent } = makeAgent();
        const id = agent.createText(10, 10, 'hello', 24);
        expect(agent.describeNode(id)?.fill).toBe('#000000');
    });

    it('still honours an explicit text colour', () => {
        const { agent } = makeAgent();
        const id = agent.createText(10, 10, 'hello', 24, { fill: '#ff0000' });
        expect(agent.describeNode(id)?.fill).toBe('#ff0000');
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

describe('agent API — canvas', () => {
    // Without this an agent cannot centre anything or reason about margins.
    // I hit exactly this drawing an icon: the only way to learn the canvas
    // size was reading ruler markings out of a PNG.
    it('reports the artboard so the agent can centre artwork', () => {
        const { agent } = makeAgent();
        const canvas = agent.describe().canvas;
        expect(canvas).not.toBeNull();
        expect(canvas!.width).toBeGreaterThan(0);
        expect(canvas!.height).toBeGreaterThan(0);
    });

    it('resizes the canvas', () => {
        const { agent } = makeAgent();
        agent.setCanvas({ width: 512, height: 512 });
        const canvas = agent.describe().canvas;
        expect([canvas!.width, canvas!.height]).toEqual([512, 512]);
    });

    it('fits the canvas around the artwork with a margin', () => {
        const { agent } = makeAgent();
        agent.createRect(100, 200, 50, 80);
        agent.fitCanvasToArtwork(20);
        const canvas = agent.describe().canvas!;
        expect(canvas.x).toBeCloseTo(80, 0);
        expect(canvas.y).toBeCloseTo(180, 0);
        expect(canvas.width).toBeCloseTo(90, 0);
        expect(canvas.height).toBeCloseTo(120, 0);
    });

    it('refuses to fit an empty canvas rather than producing a degenerate one', () => {
        const { agent } = makeAgent();
        expect(() => agent.fitCanvasToArtwork()).toThrow(/canvas is empty/);
    });
});

describe('agent API — SVG path data', () => {
    it('accepts an SVG d attribute', () => {
        const { agent } = makeAgent();
        const id = agent.createPathData('M 0 0 L 100 0 L 100 100 L 0 100 Z', { fill: '#ff0000' });
        const [, , w, h] = agent.describeNode(id)!.bounds;
        expect(w).toBeCloseTo(100, 0);
        expect(h).toBeCloseTo(100, 0);
    });

    it('handles curves and arcs the point form cannot express', () => {
        const { agent } = makeAgent();
        const id = agent.createPathData('M 0 50 A 50 50 0 1 1 100 50 Z');
        const [, , w, h] = agent.describeNode(id)!.bounds;
        expect(w).toBeGreaterThan(50);
        expect(h).toBeGreaterThan(20);
    });

    // The engine turns unparseable data into an empty path with no error, so
    // this has to be caught at the boundary or artwork silently loses shapes.
    it('rejects data that yields no geometry instead of a silent empty path', () => {
        const { agent } = makeAgent();
        expect(() => agent.createPathData('not path data')).toThrow(/no drawable geometry/);
    });
});

describe('agent API — gradients', () => {
    it('applies a linear gradient and reports it as a gradient fill', () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 100, 100);
        agent.setGradient(id, {
            type: 'linear',
            angle: 90,
            stops: [
                { offset: 0, color: '#ff0000' },
                { offset: 1, color: '#0000ff' },
            ],
        });
        const node = agent.describeNode(id)!;
        // `fill` can only carry solids, so the kind must be reported separately
        // or a gradient is indistinguishable from no fill at all.
        expect(node.fill).toBeNull();
        expect(node.fillType).toBe('gradient');
    });

    it('applies a radial gradient', () => {
        const { agent } = makeAgent();
        const id = agent.createEllipse(50, 50, 40, 40);
        agent.setGradient(id, {
            type: 'radial',
            stops: [
                { offset: 0, color: '#ffffff' },
                { offset: 1, color: '#000000' },
            ],
        });
        expect(agent.describeNode(id)!.fillType).toBe('gradient');
    });

    /**
     * Asserting only `fillType === 'gradient'` is not enough — it passed while
     * gradients rendered as flat colour. Local space differs per node type: a
     * Rect spans 0..w from a top-left origin, an Ellipse spans -r..r about the
     * centre. Endpoints computed as if everything were centred land outside a
     * Rect, so the shape pads to the last stop and looks solid. So check the
     * endpoints actually straddle each shape's own box.
     */
    const gradientOf = (scene: WasmScene, id: number) => {
        const paint = scene.getNodeStyle(id).fills?.[0] as {
            start_x: number;
            start_y: number;
            end_x: number;
            end_y: number;
        };
        return paint;
    };

    it('spans a RECT across its own local box (origin at top-left)', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createRect(0, 0, 160, 160);
        agent.setGradient(id, {
            type: 'linear',
            angle: 90,
            stops: [
                { offset: 0, color: '#ec4899' },
                { offset: 1, color: '#3b82f6' },
            ],
        });
        const g = gradientOf(scene, id);
        // A rect's local box is 0..160, so the gradient must run 0 → 160 in y,
        // NOT -80 → 80 (which would leave most of the shape past the last stop).
        expect(g.start_y).toBeCloseTo(0, 0);
        expect(g.end_y).toBeCloseTo(160, 0);
    });

    it('spans an ELLIPSE across its own local box (centred on origin)', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createEllipse(200, 200, 50, 50);
        agent.setGradient(id, {
            type: 'linear',
            angle: 0,
            stops: [
                { offset: 0, color: '#000000' },
                { offset: 1, color: '#ffffff' },
            ],
        });
        const g = gradientOf(scene, id);
        expect(g.start_x).toBeCloseTo(-50, 0);
        expect(g.end_x).toBeCloseTo(50, 0);
    });

    it('centres a radial gradient on the shape, not on the origin', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createRect(0, 0, 100, 100);
        agent.setGradient(id, {
            type: 'radial',
            stops: [
                { offset: 0, color: '#ffffff' },
                { offset: 1, color: '#000000' },
            ],
        });
        const g = gradientOf(scene, id);
        expect(g.start_x).toBeCloseTo(50, 0);
        expect(g.start_y).toBeCloseTo(50, 0);
    });

    // cos(90°) is 6e-17, not 0, so an unsnapped endpoint ships into every
    // exported SVG as "-1.7145055e-14".
    it('emits clean endpoints rather than floating-point noise', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createRect(0, 0, 200, 200);
        agent.setGradient(id, {
            type: 'linear',
            angle: 90,
            stops: [
                { offset: 0, color: '#000000' },
                { offset: 1, color: '#ffffff' },
            ],
        });
        const g = gradientOf(scene, id);
        expect(g.start_x).toBe(100);
        expect(g.end_x).toBe(100);
    });

    it('rejects a gradient with too few stops', () => {
        const { agent } = makeAgent();
        const id = agent.createRect(0, 0, 10, 10);
        expect(() =>
            agent.setGradient(id, { type: 'linear', stops: [{ offset: 0, color: '#fff' }] }),
        ).toThrow(/at least 2 stops/);
    });

    it('is one undo step across a batch', () => {
        const { agent, scene } = makeAgent();
        const a1 = agent.createRect(0, 0, 10, 10);
        const a2 = agent.createRect(20, 0, 10, 10);
        const before = snapshot(scene);
        agent.setGradient([a1, a2], {
            type: 'linear',
            stops: [
                { offset: 0, color: '#000000' },
                { offset: 1, color: '#ffffff' },
            ],
        });
        scene.undo();
        expect(snapshot(scene)).toEqual(before);
    });
});

describe('agent API — z-order', () => {
    it('brings a node to the front and sends it to the back', () => {
        const { agent, scene } = makeAgent();
        const bottom = agent.createRect(0, 0, 10, 10);
        agent.createRect(5, 5, 10, 10);
        const roots = () => Array.from(scene.getRootNodes());

        expect(roots()[0]).toBe(bottom);
        agent.bringToFront(bottom);
        expect(roots()[roots().length - 1]).toBe(bottom);
        agent.sendToBack(bottom);
        expect(roots()[0]).toBe(bottom);
    });
});

describe('agent API — text', () => {
    const textGeom = (scene: WasmScene, id: number) => scene.getNode(id)!.geometry.Text!;

    it('edits content without discarding typography', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createText(10, 10, 'hello', 24);
        agent.setText(id, { weight: 700, italic: true });
        agent.setText(id, { text: 'goodbye' });

        const t = textGeom(scene, id);
        expect(t.content).toBe('goodbye');
        expect(t.font_size, 'size must survive a content-only edit').toBe(24);
        expect(t.font_weight, 'weight must survive a content-only edit').toBe(700);
        expect(t.italic).toBe(true);
    });

    it('sets alignment by name rather than a magic number', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createText(0, 0, 'x', 16);
        agent.setText(id, { align: 'center' });
        expect(textGeom(scene, id).text_align).toBe(1);
    });

    it('is one undo step even when it touches all three engine setters', () => {
        const { agent, scene } = makeAgent();
        const id = agent.createText(0, 0, 'x', 16);
        const before = snapshot(scene);
        agent.setText(id, { text: 'y', fontSize: 32, align: 'right', weight: 700 });
        scene.undo();
        expect(snapshot(scene)).toEqual(before);
    });

    it('refuses to apply text edits to a non-text node', () => {
        const { agent } = makeAgent();
        const rect = agent.createRect(0, 0, 10, 10);
        expect(() => agent.setText(rect, { text: 'nope' })).toThrow(/not Text/);
    });
});

describe('agent API — clear', () => {
    it('empties the canvas in a single undo step', () => {
        const { agent, scene } = makeAgent();
        agent.createRect(0, 0, 10, 10);
        agent.createEllipse(50, 50, 10, 10);
        const before = snapshot(scene);

        agent.clear();
        expect(agent.describe().nodes).toHaveLength(0);

        scene.undo();
        expect(snapshot(scene), 'clear must be recoverable with one undo').toEqual(before);
    });

    it('is a no-op on an already-empty canvas', () => {
        const { agent } = makeAgent();
        expect(() => agent.clear()).not.toThrow();
    });
});

describe('agent API — importSVG', () => {
    it('rejects input that is not an SVG document', () => {
        const { agent } = makeAgent();
        return expect(agent.importSVG('just some text')).rejects.toThrow(/expects an <svg>/);
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
