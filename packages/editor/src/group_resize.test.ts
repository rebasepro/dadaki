/**
 * The selection frame must sit ON the artwork, and a resize drag must land the
 * artwork under the pointer — for groups shaped like an SVG import: rotated
 * children, ellipses, curves, nested groups.
 *
 * Reported as "resizing a group is all wrong — the final shape does not
 * correspond at all with the bounding box". Three separate faults stacked up,
 * all of them in the gap between the box the user grabs and the box the
 * gesture measures:
 *
 *   - the engine boxed an ellipse with its *untransformed* radii, so scaling a
 *     group left every circle in it reporting the size it was drawn at;
 *   - the frame unioned each child's box pushed through the child's transform,
 *     and the box of a rotated box is bigger than the rotated shape;
 *   - both sides measured curves by sampling, landing just inside the true
 *     extreme, and disagreeing with each other about by how much.
 *
 * Every input test stubs `calculatePathBounds` to a zero box, which is exactly
 * why none of them could see any of it. These use the real one.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { InputManager } from './input';
import { pathBounds } from './path_bounds';
import type { Renderer } from './renderer';
import type { UIEngine } from './ui';
import { WasmScene } from './wasm_scene';

let wasmModule: { memory: WebAssembly.Memory };
beforeAll(async () => {
    wasmModule = await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
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
        // The real measure — the whole point of this file.
        calculatePathBounds: (p: Parameters<Renderer['calculatePathBounds']>[0]) =>
            pathBounds(p.subpaths),
        getTextLocalBounds: () => null,
        hoverEdgeId: -1,
        hoverFaceId: -1,
        selectedArtboardId: null,
        artboardHandleHitTest: () => null,
        artboardLabelHitTest: () => null,
    } as unknown as Renderer;
}
function makeUI(): UIEngine {
    return {
        activeTool: 'selection',
        syncWithSelection() {},
        updateLayerList() {},
        revealSelection() {},
        revealSelectionIfChanged() {},
        hideContextMenu() {},
        refreshArtboardPanel() {},
        applyToolCursor() {},
        collapseSubtreeByDefault() {},
        gradientEdit: { isActive: () => false, hitTest: () => null },
    } as unknown as UIEngine;
}
/** Cmd is held throughout: these assert the geometry, not the snapping. */
const mouse = (clientX: number, clientY: number) =>
    ({
        clientX,
        clientY,
        shiftKey: false,
        altKey: false,
        metaKey: true,
        ctrlKey: false,
        button: 0,
        preventDefault() {},
        stopPropagation() {},
    }) as unknown as MouseEvent;

function makeInput(scene: WasmScene) {
    return new InputManager(document.createElement('canvas'), scene, makeUI(), makeRenderer());
}

/** The frame's world-space top-left and bottom-right corners. */
function frameCorners(input: InputManager) {
    const F = input.getSelectionFrame();
    if (!F) throw new Error('no selection frame');
    const at = (fx: number, fy: number) => ({
        x: F.m.a * fx + F.m.c * fy + F.m.e,
        y: F.m.b * fx + F.m.d * fy + F.m.f,
    });
    return { nw: at(0, 0), se: at(F.w, F.h) };
}

/**
 * The artwork's true world box, measured from local geometry pushed through
 * each node's world transform — deliberately NOT the engine's own bounds, so
 * this test can catch the engine being wrong about them.
 */
function artBounds(scene: WasmScene, id: number, depth = 0): [number, number, number, number] {
    const acc: [number, number, number, number] = [
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
    ];
    const t = Array.from(scene.getTransform(id));
    const push = (x: number, y: number) => {
        const wx = t[0] * x + t[1] * y + t[2];
        const wy = t[3] * x + t[4] * y + t[5];
        acc[0] = Math.min(acc[0], wx);
        acc[1] = Math.min(acc[1], wy);
        acc[2] = Math.max(acc[2], wx);
        acc[3] = Math.max(acc[3], wy);
    };
    if (scene.getNodeType(id) === 3) {
        if (depth > 12) return acc;
        for (const kid of Array.from(scene.getNodeChildren(id))) {
            const b = artBounds(scene, kid, depth + 1);
            if (!Number.isFinite(b[0])) continue;
            acc[0] = Math.min(acc[0], b[0]);
            acc[1] = Math.min(acc[1], b[1]);
            acc[2] = Math.max(acc[2], b[2]);
            acc[3] = Math.max(acc[3], b[3]);
        }
        return acc;
    }
    const geo = scene.getNodeGeometry(id);
    if (!geo) return acc;
    if (geo.Ellipse) {
        const { radius_x: rx, radius_y: ry } = geo.Ellipse;
        for (let i = 0; i < 4096; i++) {
            const a = (i / 4096) * Math.PI * 2;
            push(rx * Math.cos(a), ry * Math.sin(a));
        }
        return acc;
    }
    if (geo.Rect) {
        const { width: w, height: h } = geo.Rect;
        const r = Math.min(scene.getNodeStyle(id)?.corner_radius ?? 0, w / 2, h / 2);
        if (r <= 1e-3) {
            for (const [x, y] of [
                [0, 0],
                [w, 0],
                [w, h],
                [0, h],
            ])
                push(x, y);
            return acc;
        }
        // A rounded rect's arcs cut the sharp corners away, and under a
        // rotation it is the cut corner that reaches furthest.
        for (const [cx, cy, a0] of [
            [w - r, r, -Math.PI / 2],
            [w - r, h - r, 0],
            [r, h - r, Math.PI / 2],
            [r, r, Math.PI],
        ]) {
            for (let i = 0; i <= 128; i++) {
                const a = a0 + (i / 128) * (Math.PI / 2);
                push(cx + r * Math.cos(a), cy + r * Math.sin(a));
            }
        }
        return acc;
    }
    if (geo.Path) {
        const seg = (p: PathLike, q: PathLike) => {
            for (let i = 0; i <= 256; i++) {
                const tt = i / 256;
                const u = 1 - tt;
                push(
                    u * u * u * p.x +
                        3 * u * u * tt * p.cp2[0] +
                        3 * u * tt * tt * q.cp1[0] +
                        tt * tt * tt * q.x,
                    u * u * u * p.y +
                        3 * u * u * tt * p.cp2[1] +
                        3 * u * tt * tt * q.cp1[1] +
                        tt * tt * tt * q.y,
                );
            }
        };
        for (const sp of scene.getResolvedSubpaths(id)) {
            const pts = sp.points;
            if (!pts.length) continue;
            push(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
            if (sp.closed && pts.length >= 2) seg(pts[pts.length - 1], pts[0]);
        }
    }
    return acc;
}
type PathLike = { x: number; y: number; cp1: [number, number]; cp2: [number, number] };

/** An SVG-import-shaped group: a curve, a rotated ellipse, a nested group. */
function importLikeGroup(scene: WasmScene): number {
    const e = scene.engine!;
    const blob = e.add_path(
        JSON.stringify([
            {
                points: [
                    { x: 20, y: 100, cp1: [20, 100], cp2: [20, 20] },
                    { x: 120, y: 30, cp1: [60, 20], cp2: [180, 40] },
                    { x: 140, y: 140, cp1: [190, 90], cp2: [140, 140] },
                ],
                closed: true,
            },
        ]),
    );
    const inner = e.add_ellipse(200, 60, 45, 18);
    e.set_node_rotation(inner, 37);
    const nested = e.group_nodes(JSON.stringify([blob, inner]));
    e.set_node_rotation(nested, 12);
    const tail = e.add_rect(60, 170, 90, 40);
    const style = scene.getNode(tail)!.style;
    e.set_node_style(tail, JSON.stringify({ ...style, corner_radius: 14 }));
    e.set_node_rotation(tail, -20);
    return e.group_nodes(JSON.stringify([nested, tail]));
}

describe('resizing an imported group', () => {
    it('draws its frame on the artwork, not around it', () => {
        const scene = makeScene();
        const g = importLikeGroup(scene);
        const input = makeInput(scene);
        scene.engine!.select_node(g, false);

        const art = artBounds(scene, g);
        const { nw, se } = frameCorners(input);
        expect(nw.x).toBeCloseTo(art[0], 1);
        expect(nw.y).toBeCloseTo(art[1], 1);
        expect(se.x).toBeCloseTo(art[2], 1);
        expect(se.y).toBeCloseTo(art[3], 1);
    });

    it('does not jump the moment a handle is grabbed', () => {
        const scene = makeScene();
        const g = importLikeGroup(scene);
        const input = makeInput(scene);
        scene.engine!.select_node(g, false);

        const grab = frameCorners(input).se;
        input.onMouseDown(mouse(grab.x, grab.y));
        input.onMouseMove(mouse(grab.x + 0.5, grab.y + 0.5));
        // The handle must still be under the pointer, not somewhere the
        // gesture's own idea of the box put it.
        const moved = frameCorners(input).se;
        expect(moved.x).toBeCloseTo(grab.x + 0.5, 1);
        expect(moved.y).toBeCloseTo(grab.y + 0.5, 1);
        input.onMouseUp(mouse(grab.x + 0.5, grab.y + 0.5));
    });

    it('lands the artwork under the pointer, and the frame back on the artwork', () => {
        const scene = makeScene();
        const g = importLikeGroup(scene);
        const input = makeInput(scene);
        scene.engine!.select_node(g, false);

        const before = frameCorners(input);
        const drop = { x: before.se.x + 120, y: before.se.y + 70 };
        input.onMouseDown(mouse(before.se.x, before.se.y));
        input.onMouseMove(mouse(drop.x, drop.y));
        input.onMouseUp(mouse(drop.x, drop.y));

        const art = artBounds(scene, g);
        expect(art[0]).toBeCloseTo(before.nw.x, 1);
        expect(art[1]).toBeCloseTo(before.nw.y, 1);
        expect(art[2]).toBeCloseTo(drop.x, 1);
        expect(art[3]).toBeCloseTo(drop.y, 1);

        const after = frameCorners(input);
        expect(after.se.x).toBeCloseTo(art[2], 1);
        expect(after.se.y).toBeCloseTo(art[3], 1);
    });

    it('keeps every child on its own box while the group scales', () => {
        const scene = makeScene();
        const g = importLikeGroup(scene);
        const input = makeInput(scene);
        scene.engine!.select_node(g, false);

        const se = frameCorners(input).se;
        input.onMouseDown(mouse(se.x, se.y));
        input.onMouseMove(mouse(se.x + 200, se.y + 40));
        input.onMouseUp(mouse(se.x + 200, se.y + 40));

        const walk = (id: number, out: number[] = []): number[] => {
            out.push(id);
            for (const k of Array.from(scene.getNodeChildren(id))) walk(k, out);
            return out;
        };
        for (const id of walk(g)) {
            const art = artBounds(scene, id);
            if (!Number.isFinite(art[0])) continue;
            const b = scene.getMeasuredNodeBounds(id);
            expect(b[0], `node ${id} min x`).toBeCloseTo(art[0], 1);
            expect(b[1], `node ${id} min y`).toBeCloseTo(art[1], 1);
            expect(b[2], `node ${id} max x`).toBeCloseTo(art[2], 1);
            expect(b[3], `node ${id} max y`).toBeCloseTo(art[3], 1);
        }
    });
});
