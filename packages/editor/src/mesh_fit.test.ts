import { describe, expect, it } from 'vitest';
import { createMeshForNode, fitMeshToOutline, outlineCubics, samplePaintAt } from './mesh_fit';
import type { Cubic, Vec2 } from './mesh_geom';
import { evalCubic, vertexIndex } from './mesh_geom';
import type { Gradient, NodeGeometry } from './types';

const RECT: NodeGeometry = { Rect: { width: 300, height: 200 } };
const ELLIPSE: NodeGeometry = { Ellipse: { radius_x: 120, radius_y: 90 } };

/** A closed 4-point blob path (rounded diamond-ish). */
function blobGeometry(): NodeGeometry {
    const pts = [
        { x: 150, y: 0, cp1: [80, -20] as [number, number], cp2: [220, 20] as [number, number] },
        { x: 300, y: 120, cp1: [300, 50] as [number, number], cp2: [300, 190] as [number, number] },
        { x: 140, y: 240, cp1: [230, 240] as [number, number], cp2: [60, 240] as [number, number] },
        { x: 0, y: 110, cp1: [0, 180] as [number, number], cp2: [0, 40] as [number, number] },
    ];
    return { Path: { subpaths: [{ points: pts, closed: true }] } };
}

/** Distance from a point to the sampled outline. */
function distToOutline(cubics: Cubic[], p: Vec2): number {
    let best = Infinity;
    for (const c of cubics) {
        for (let i = 0; i <= 64; i++) {
            const q = evalCubic(c, i / 64);
            best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1]));
        }
    }
    return best;
}

describe('fitMeshToOutline', () => {
    it('rect: corners land on the rect corners, edges stay straight', () => {
        const mesh = fitMeshToOutline(RECT, [0.5], [0.5]);
        expect(mesh).not.toBeNull();
        if (!mesh) return;
        expect(mesh.rows).toBe(2);
        expect(mesh.cols).toBe(2);
        const tl = mesh.vertices[vertexIndex(mesh, 0, 0)];
        const br = mesh.vertices[vertexIndex(mesh, 2, 2)];
        expect(Math.hypot(tl.x, tl.y)).toBeLessThan(1);
        expect(Math.hypot(br.x - 300, br.y - 200)).toBeLessThan(1);
        // Top-middle boundary vertex sits on the top edge.
        const tm = mesh.vertices[vertexIndex(mesh, 0, 1)];
        expect(Math.abs(tm.y)).toBeLessThan(1);
        expect(tm.x).toBeGreaterThan(100);
        expect(tm.x).toBeLessThan(200);
    });

    it('ellipse: every boundary vertex lies on the ellipse', () => {
        const mesh = fitMeshToOutline(ELLIPSE, [0.5], [0.5]);
        expect(mesh).not.toBeNull();
        if (!mesh) return;
        for (let r = 0; r <= mesh.rows; r++) {
            for (let c = 0; c <= mesh.cols; c++) {
                if (r > 0 && r < mesh.rows && c > 0 && c < mesh.cols) continue; // interior
                const v = mesh.vertices[vertexIndex(mesh, r, c)];
                const e = (v.x / 120) ** 2 + (v.y / 90) ** 2;
                expect(Math.abs(e - 1)).toBeLessThan(0.05);
            }
        }
        // Interior vertex (center-ish) stays inside.
        const center = mesh.vertices[vertexIndex(mesh, 1, 1)];
        expect((center.x / 120) ** 2 + (center.y / 90) ** 2).toBeLessThan(0.5);
    });

    it('blob path: boundary vertices sit on the outline within tolerance', () => {
        const geo = blobGeometry();
        const cubics = outlineCubics(geo);
        expect(cubics).not.toBeNull();
        const mesh = fitMeshToOutline(geo, [0.35, 0.7], [0.5]);
        expect(mesh).not.toBeNull();
        if (!mesh || !cubics) return;
        expect(mesh.cols).toBe(3);
        for (let r = 0; r <= mesh.rows; r++) {
            for (let c = 0; c <= mesh.cols; c++) {
                if (r > 0 && r < mesh.rows && c > 0 && c < mesh.cols) continue;
                const v = mesh.vertices[vertexIndex(mesh, r, c)];
                expect(distToOutline(cubics, [v.x, v.y])).toBeLessThan(2);
            }
        }
        // Boundary edge midpoints follow the outline reasonably (fit quality).
        const topEdgeMid = evalCubic(
            [
                [mesh.vertices[0].x, mesh.vertices[0].y],
                mesh.vertices[0].handles?.e ?? [0, 0],
                mesh.vertices[1].handles?.w ?? [0, 0],
                [mesh.vertices[1].x, mesh.vertices[1].y],
            ],
            0.5,
        );
        expect(distToOutline(cubics, topEdgeMid)).toBeLessThan(6);
    });

    it('open path falls back to null', () => {
        const geo: NodeGeometry = {
            Path: {
                subpaths: [
                    {
                        points: [
                            { x: 0, y: 0, cp1: [0, 0], cp2: [0, 0] },
                            { x: 100, y: 10, cp1: [100, 10], cp2: [100, 10] },
                        ],
                        closed: false,
                    },
                ],
            },
        };
        expect(fitMeshToOutline(geo, [0.5], [0.5])).toBeNull();
    });
});

describe('createMeshForNode', () => {
    it('seeds colors from a linear gradient per-vertex', () => {
        const grad: Gradient = {
            gradient_type: 'Linear',
            stops: [
                { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
                { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
            ],
            start_x: 0,
            start_y: 0,
            end_x: 300,
            end_y: 0,
        };
        const mesh = createMeshForNode(RECT, grad);
        expect(mesh).not.toBeNull();
        if (!mesh) return;
        const left = mesh.vertices[vertexIndex(mesh, 0, 0)].color;
        const right = mesh.vertices[vertexIndex(mesh, 0, 2)].color;
        expect(left.r).toBeGreaterThan(0.9);
        expect(right.b).toBeGreaterThan(0.9);
    });

    it('interior lines pass near the click point', () => {
        const mesh = createMeshForNode(
            RECT,
            { r: 0.5, g: 0.5, b: 0.5, a: 1 },
            {
                clickLocal: { x: 75, y: 150 },
            },
        );
        expect(mesh).not.toBeNull();
        if (!mesh) return;
        const center = mesh.vertices[vertexIndex(mesh, 1, 1)];
        expect(Math.abs(center.x - 75)).toBeLessThan(8);
        expect(Math.abs(center.y - 150)).toBeLessThan(8);
    });

    it('open path falls back to a rectangular grid over the bbox', () => {
        const geo: NodeGeometry = {
            Path: {
                subpaths: [
                    {
                        points: [
                            { x: 10, y: 20, cp1: [10, 20], cp2: [10, 20] },
                            { x: 210, y: 20, cp1: [210, 20], cp2: [210, 20] },
                            { x: 210, y: 120, cp1: [210, 120], cp2: [210, 120] },
                        ],
                        closed: false,
                    },
                ],
            },
        };
        const mesh = createMeshForNode(geo, { r: 1, g: 0, b: 0, a: 1 });
        expect(mesh).not.toBeNull();
        if (!mesh) return;
        expect(mesh.rows).toBe(2);
        const tl = mesh.vertices[0];
        expect(tl.x).toBeCloseTo(10, 3);
        expect(tl.y).toBeCloseTo(20, 3);
    });
});

describe('samplePaintAt', () => {
    it('radial gradients sample by distance from center', () => {
        const grad: Gradient = {
            gradient_type: 'Radial',
            stops: [
                { offset: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
                { offset: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
            ],
            start_x: 0,
            start_y: 0,
            end_x: 100,
            end_y: 0,
        };
        expect(samplePaintAt(grad, 0, 0).r).toBeCloseTo(1, 5);
        expect(samplePaintAt(grad, 100, 0).r).toBeCloseTo(0, 5);
        expect(samplePaintAt(grad, 0, 50).r).toBeCloseTo(0.5, 5);
    });
});
