/**
 * Shape-fitted mesh creation (Illustrator-parity boundary).
 *
 * Converting a fill to a mesh fits the outer mesh ring to the node's outline:
 * the four mesh corners land ON the path (at the outline points nearest the
 * bounding-box corners), each boundary edge is a cubic fitted to its stretch
 * of outline (endpoint tangents, ⅓-arc-length handles), and interior vertices
 * are placed by Coons transfinite interpolation. Colors are seeded from the
 * fill being replaced (gradients are sampled per-vertex).
 *
 * The renderer paints `node path ∩ mesh raster` (plus a small boundary-color
 * outset), so a fit that can't follow every wiggle of a spiky path stays
 * visually correct — the clip guarantees the fill never spills, the outset
 * guarantees no transparent slivers.
 */

import { sampleGradientColor } from './gradient_edit';
import type { Cubic, Vec2 } from './mesh_geom';
import { evalCoons, evalCubic, makeRectMesh, pointToUV } from './mesh_geom';
import type { Color, MeshGradient, NodeGeometry, Paint } from './types';
import { isGradient, isMeshGradient, isPattern } from './types';

// ─── Outline extraction ──────────────────────────────────────────────────

/** Circle-quadrant bezier constant. */
const KAPPA = 0.5522847498;

/** The node's outline as a closed loop of cubics in node-local coords, or
 *  null when the geometry has no usable closed outline. For Paths, uses the
 *  largest closed subpath (by bbox area). */
export function outlineCubics(geo: NodeGeometry): Cubic[] | null {
    if (geo.Rect) {
        const { width: w, height: h } = geo.Rect;
        if (!(w > 0 && h > 0)) return null;
        const line = (a: Vec2, b: Vec2): Cubic => [
            a,
            [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
            [a[0] + ((b[0] - a[0]) * 2) / 3, a[1] + ((b[1] - a[1]) * 2) / 3],
            b,
        ];
        return [
            line([0, 0], [w, 0]),
            line([w, 0], [w, h]),
            line([w, h], [0, h]),
            line([0, h], [0, 0]),
        ];
    }
    if (geo.Ellipse) {
        const { radius_x: rx, radius_y: ry } = geo.Ellipse;
        if (!(rx > 0 && ry > 0)) return null;
        const kx = rx * KAPPA;
        const ky = ry * KAPPA;
        // Clockwise from the top point.
        return [
            [
                [0, -ry],
                [kx, -ry],
                [rx, -ky],
                [rx, 0],
            ],
            [
                [rx, 0],
                [rx, ky],
                [kx, ry],
                [0, ry],
            ],
            [
                [0, ry],
                [-kx, ry],
                [-rx, ky],
                [-rx, 0],
            ],
            [
                [-rx, 0],
                [-rx, -ky],
                [-kx, -ry],
                [0, -ry],
            ],
        ];
    }
    if (geo.Path) {
        let best: Cubic[] | null = null;
        let bestArea = 0;
        for (const sp of geo.Path.subpaths ?? []) {
            if (!sp.closed || sp.points.length < 3) continue;
            const cubics: Cubic[] = [];
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (let i = 0; i < sp.points.length; i++) {
                const a = sp.points[i];
                const b = sp.points[(i + 1) % sp.points.length];
                cubics.push([
                    [a.x, a.y],
                    [a.cp2[0], a.cp2[1]],
                    [b.cp1[0], b.cp1[1]],
                    [b.x, b.y],
                ]);
                minX = Math.min(minX, a.x);
                minY = Math.min(minY, a.y);
                maxX = Math.max(maxX, a.x);
                maxY = Math.max(maxY, a.y);
            }
            const area = (maxX - minX) * (maxY - minY);
            if (area > bestArea) {
                bestArea = area;
                best = cubics;
            }
        }
        return best;
    }
    return null; // Text / Image: no mesh
}

// ─── Outline sampling ────────────────────────────────────────────────────

interface OutlineSamples {
    pts: Vec2[];
    /** Cumulative arc length up to each sample; [0] = 0. */
    cum: number[];
    /** Unit tangent (forward direction) at each sample. */
    tan: Vec2[];
    total: number;
}

const SAMPLES_PER_CUBIC = 32;

function sampleOutline(cubics: Cubic[]): OutlineSamples {
    const pts: Vec2[] = [];
    for (const c of cubics) {
        for (let i = 0; i < SAMPLES_PER_CUBIC; i++) {
            pts.push(evalCubic(c, i / SAMPLES_PER_CUBIC));
        }
    }
    const n = pts.length;
    const cum: number[] = [0];
    for (let i = 1; i < n; i++) {
        cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const total = cum[n - 1] + Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]);
    const tan: Vec2[] = [];
    for (let i = 0; i < n; i++) {
        const p = pts[(i + n - 1) % n];
        const q = pts[(i + 1) % n];
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        const l = Math.hypot(dx, dy) || 1;
        tan.push([dx / l, dy / l]);
    }
    return { pts, cum, tan, total };
}

/** Point/tangent at an absolute arc length along the (closed) outline. */
function atLength(s: OutlineSamples, len: number): { p: Vec2; t: Vec2 } {
    const n = s.pts.length;
    const l = ((len % s.total) + s.total) % s.total;
    // Binary search the cum array.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (s.cum[mid] <= l) lo = mid;
        else hi = mid - 1;
    }
    const i = lo;
    const j = (i + 1) % n;
    const segLen = (j === 0 ? s.total : s.cum[j]) - s.cum[i];
    const f = segLen > 1e-9 ? (l - s.cum[i]) / segLen : 0;
    const p: Vec2 = [
        s.pts[i][0] + (s.pts[j][0] - s.pts[i][0]) * f,
        s.pts[i][1] + (s.pts[j][1] - s.pts[i][1]) * f,
    ];
    const t: Vec2 = [
        s.tan[i][0] + (s.tan[j][0] - s.tan[i][0]) * f,
        s.tan[i][1] + (s.tan[j][1] - s.tan[i][1]) * f,
    ];
    const tl = Math.hypot(t[0], t[1]) || 1;
    return { p, t: [t[0] / tl, t[1] / tl] };
}

// ─── Boundary fitting ────────────────────────────────────────────────────

/** Fit one cubic to the outline stretch starting at `startLen`, walking
 *  FORWARD by `span`: endpoints on the outline, handles along the endpoint
 *  tangents at ⅓ of the stretch length. Endpoint tangents are measured a
 *  little INSIDE the stretch (chord to a 2%-inset point) — the outline's own
 *  tangent at a corner averages both adjoining edges, which would bow the
 *  fitted edge outward (an S-wave past every rect corner). `flip` reverses
 *  the cubic for sides whose outline direction opposes the mesh's +u/+v. */
function fitEdgeForward(s: OutlineSamples, startLen: number, span: number, flip: boolean): Cubic {
    const a = atLength(s, startLen);
    const b = atLength(s, startLen + span);
    const inset = span * 0.02;
    const aIn = atLength(s, startLen + inset).p;
    const bIn = atLength(s, startLen + span - inset).p;
    const norm = (dx: number, dy: number): Vec2 => {
        const l = Math.hypot(dx, dy) || 1;
        return [dx / l, dy / l];
    };
    const ta = norm(aIn[0] - a.p[0], aIn[1] - a.p[1]);
    const tb = norm(b.p[0] - bIn[0], b.p[1] - bIn[1]);
    const h = span / 3;
    const c: Cubic = [
        a.p,
        [a.p[0] + ta[0] * h, a.p[1] + ta[1] * h],
        [b.p[0] - tb[0] * h, b.p[1] - tb[1] * h],
        b.p,
    ];
    return flip ? ([c[3], c[2], c[1], c[0]] as Cubic) : c;
}

/** One side of the fitted mesh: an outline stretch (forward walk from
 *  `start` by `span`) plus whether that walk opposes the mesh direction
 *  (+u for top/bottom, +v for left/right). */
interface Side {
    start: number;
    span: number;
    reverse: boolean;
}

/** Outline point/tangent at mesh-direction fraction `f` of a side. */
function sideAt(s: OutlineSamples, side: Side, f: number) {
    return atLength(s, side.start + side.span * (side.reverse ? 1 - f : f));
}

/** Cubic fitted to the sub-stretch [f0, f1] (mesh-direction fractions). */
function sideEdge(s: OutlineSamples, side: Side, f0: number, f1: number): Cubic {
    const from = side.start + side.span * (side.reverse ? 1 - f1 : f0);
    return fitEdgeForward(s, from, side.span * (f1 - f0), side.reverse);
}

/** Roles of the four mesh corners on the outline. */
interface CornerPick {
    /** Arc lengths of TL, TR, BR, BL corner points along the outline. */
    len: { tl: number; tr: number; br: number; bl: number };
    /** True when walking the outline forward goes TL → TR (top first). */
    forward: boolean;
}

function pickCorners(s: OutlineSamples): CornerPick | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of s.pts) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
    }
    const nearest = (cx: number, cy: number): number => {
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < s.pts.length; i++) {
            const d = (s.pts[i][0] - cx) ** 2 + (s.pts[i][1] - cy) ** 2;
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        return best;
    };
    const iTL = nearest(minX, minY);
    const iTR = nearest(maxX, minY);
    const iBR = nearest(maxX, maxY);
    const iBL = nearest(minX, maxY);
    const idx = [iTL, iTR, iBR, iBL];
    if (new Set(idx).size !== 4) return null;
    // Walking forward from TL we must meet the other corners in either
    // TR→BR→BL order (forward/clockwise-ish) or BL→BR→TR (reversed).
    const rel = (i: number) => (i - iTL + s.pts.length) % s.pts.length;
    const rTR = rel(iTR);
    const rBR = rel(iBR);
    const rBL = rel(iBL);
    const forward = rTR < rBR && rBR < rBL;
    const reversed = rBL < rBR && rBR < rTR;
    if (!forward && !reversed) return null; // corners interleave weirdly
    return {
        len: { tl: s.cum[iTL], tr: s.cum[iTR], br: s.cum[iBR], bl: s.cum[iBL] },
        forward,
    };
}

/**
 * Build a shape-fitted mesh: boundary on the outline, interior by Coons
 * placement. `uFractions`/`vFractions` are the interior grid-line positions
 * in (0,1) (ascending). Colors are all-black — seed them afterwards.
 * Returns null when the geometry can't be fitted (no closed outline,
 * degenerate corners) — callers fall back to a rectangular grid.
 */
export function fitMeshToOutline(
    geo: NodeGeometry,
    uFractions: number[],
    vFractions: number[],
): MeshGradient | null {
    const cubics = outlineCubics(geo);
    if (!cubics) return null;
    const s = sampleOutline(cubics);
    if (s.total < 1e-6) return null;
    const pick = pickCorners(s);
    if (!pick) return null;

    const { len, forward } = pick;
    const stretch = (a: number, b: number) => (((b - a) % s.total) + s.total) % s.total;
    // The four sides as forward outline stretches. Walking forward from TL
    // meets TR first (forward=true, clockwise-ish for y-down) or BL first;
    // sides whose outline direction opposes the mesh's +u/+v get `reverse`.
    let top: Side;
    let right: Side;
    let bottom: Side;
    let left: Side;
    if (forward) {
        top = { start: len.tl, span: stretch(len.tl, len.tr), reverse: false };
        right = { start: len.tr, span: stretch(len.tr, len.br), reverse: false };
        bottom = { start: len.br, span: stretch(len.br, len.bl), reverse: true };
        left = { start: len.bl, span: stretch(len.bl, len.tl), reverse: true };
    } else {
        left = { start: len.tl, span: stretch(len.tl, len.bl), reverse: false };
        bottom = { start: len.bl, span: stretch(len.bl, len.br), reverse: false };
        right = { start: len.br, span: stretch(len.br, len.tr), reverse: true };
        top = { start: len.tr, span: stretch(len.tr, len.tl), reverse: true };
    }
    if (Math.min(top.span, right.span, bottom.span, left.span) < s.total * 0.02) return null;

    const us = [0, ...uFractions, 1];
    const vs = [0, ...vFractions, 1];
    const rows = vs.length - 1;
    const cols = us.length - 1;

    // Whole-side cubics for Coons interior placement.
    const coons = {
        top: sideEdge(s, top, 0, 1),
        bottom: sideEdge(s, bottom, 0, 1),
        left: sideEdge(s, left, 0, 1),
        right: sideEdge(s, right, 0, 1),
    };

    const black: Color = { r: 0, g: 0, b: 0, a: 1 };
    const mesh: MeshGradient = { rows, cols, vertices: [] };
    for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
            let p: Vec2;
            if (r === 0) p = sideAt(s, top, us[c]).p;
            else if (r === rows) p = sideAt(s, bottom, us[c]).p;
            else if (c === 0) p = sideAt(s, left, vs[r]).p;
            else if (c === cols) p = sideAt(s, right, vs[r]).p;
            else p = evalCoons(coons, us[c], vs[r]);
            mesh.vertices.push({ x: p[0], y: p[1], color: { ...black } });
        }
    }

    // Boundary handles: fit a cubic per boundary edge and store its inner
    // control points on the edge's two vertices (interior handles stay auto).
    const setH = (r: number, c: number, dirKey: 'e' | 'w' | 's' | 'n', p: Vec2) => {
        const v = mesh.vertices[r * (cols + 1) + c];
        if (!v.handles) v.handles = {};
        v.handles[dirKey] = [p[0], p[1]];
    };
    for (let c = 0; c < cols; c++) {
        const te = sideEdge(s, top, us[c], us[c + 1]);
        setH(0, c, 'e', te[1]);
        setH(0, c + 1, 'w', te[2]);
        const be = sideEdge(s, bottom, us[c], us[c + 1]);
        setH(rows, c, 'e', be[1]);
        setH(rows, c + 1, 'w', be[2]);
    }
    for (let r = 0; r < rows; r++) {
        const le = sideEdge(s, left, vs[r], vs[r + 1]);
        setH(r, 0, 's', le[1]);
        setH(r + 1, 0, 'n', le[2]);
        const re = sideEdge(s, right, vs[r], vs[r + 1]);
        setH(r, cols, 's', re[1]);
        setH(r + 1, cols, 'n', re[2]);
    }
    return mesh;
}

// ─── Color seeding ───────────────────────────────────────────────────────

/** Sample the paint being replaced at a node-local point. */
export function samplePaintAt(paint: Paint | null | undefined, x: number, y: number): Color {
    if (!paint) return { r: 0.8, g: 0.8, b: 0.8, a: 1 };
    if (isMeshGradient(paint)) {
        // Replacing a mesh with a mesh: keep it simple, mean is predictable.
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (const v of paint.vertices) {
            r += v.color.r;
            g += v.color.g;
            b += v.color.b;
            a += v.color.a;
        }
        const n = Math.max(1, paint.vertices.length);
        return { r: r / n, g: g / n, b: b / n, a: a / n };
    }
    if (isPattern(paint)) return { r: 0.5, g: 0.5, b: 0.5, a: 1 };
    if (isGradient(paint)) {
        let t: number;
        if (paint.gradient_type === 'Linear') {
            const dx = paint.end_x - paint.start_x;
            const dy = paint.end_y - paint.start_y;
            const len2 = dx * dx + dy * dy;
            t = len2 < 1e-9 ? 0 : ((x - paint.start_x) * dx + (y - paint.start_y) * dy) / len2;
        } else {
            const r = Math.hypot(paint.end_x - paint.start_x, paint.end_y - paint.start_y);
            t = r < 1e-9 ? 0 : Math.hypot(x - paint.start_x, y - paint.start_y) / r;
        }
        return sampleGradientColor(paint, Math.max(0, Math.min(1, t)));
    }
    return { ...paint };
}

/** Seed every vertex color by sampling `prevFill` at the vertex position. */
export function seedMeshColors(mesh: MeshGradient, prevFill: Paint | null | undefined) {
    for (const v of mesh.vertices) {
        v.color = samplePaintAt(prevFill, v.x, v.y);
    }
}

// ─── Creation entry point ────────────────────────────────────────────────

/** Clamp interior-line fractions away from the boundary so a click near the
 *  edge can't create a degenerate sliver row/column. */
const FRACTION_MIN = 0.04;

export interface CreateMeshOptions {
    /** Node-local click point the interior lines should pass through;
     *  omitted (panel path) = centered lines. */
    clickLocal?: { x: number; y: number };
}

/**
 * Create the initial 2×2-patch mesh for a node: shape-fitted boundary when
 * the outline allows it, rectangular-grid fallback otherwise; interior lines
 * through the click (or centered); colors seeded from the fill it replaces.
 * Returns null only when the geometry has no extent at all.
 */
export function createMeshForNode(
    geo: NodeGeometry,
    prevFill: Paint | null | undefined,
    opts: CreateMeshOptions = {},
): MeshGradient | null {
    // Interior line fractions from the click, via the coarse fitted surface.
    let fu = 0.5;
    let fv = 0.5;
    let coarse: MeshGradient | null = null;
    if (opts.clickLocal) {
        coarse = fitMeshToOutline(geo, [], []);
        if (coarse) {
            const hit = pointToUV(coarse, [opts.clickLocal.x, opts.clickLocal.y]);
            if (hit) {
                fu = hit.u;
                fv = hit.v;
            }
        }
    }
    fu = Math.max(FRACTION_MIN, Math.min(1 - FRACTION_MIN, fu));
    fv = Math.max(FRACTION_MIN, Math.min(1 - FRACTION_MIN, fv));

    let mesh = fitMeshToOutline(geo, [fu], [fv]);
    if (!mesh) {
        // Fallback: rectangular grid over the geometry bbox.
        const b = geometryBBox(geo);
        if (!b) return null;
        if (opts.clickLocal) {
            fu = Math.max(
                FRACTION_MIN,
                Math.min(1 - FRACTION_MIN, (opts.clickLocal.x - b.x) / b.w),
            );
            fv = Math.max(
                FRACTION_MIN,
                Math.min(1 - FRACTION_MIN, (opts.clickLocal.y - b.y) / b.h),
            );
        }
        mesh = makeRectMesh(b.x, b.y, b.w, b.h, [fv], [fu], { r: 0, g: 0, b: 0, a: 1 });
    }
    seedMeshColors(mesh, prevFill);
    return mesh;
}

/** Node-local bounding box of the geometry (fallback grid extent). */
export function geometryBBox(
    geo: NodeGeometry,
): { x: number; y: number; w: number; h: number } | null {
    if (geo.Rect) {
        const { width: w, height: h } = geo.Rect;
        return w > 0 && h > 0 ? { x: 0, y: 0, w, h } : null;
    }
    if (geo.Ellipse) {
        const { radius_x: rx, radius_y: ry } = geo.Ellipse;
        return rx > 0 && ry > 0 ? { x: -rx, y: -ry, w: 2 * rx, h: 2 * ry } : null;
    }
    if (geo.Path) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const sp of geo.Path.subpaths ?? []) {
            for (const p of sp.points) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
        }
        return minX < maxX && minY < maxY
            ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
            : null;
    }
    return null;
}
