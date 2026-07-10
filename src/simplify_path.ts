/**
 * simplify_path.ts — Illustrator "Object › Path › Simplify".
 *
 * Reduces the number of anchor points on a path while preserving its shape,
 * governed by a tolerance (world units). Each subpath is flattened to a dense
 * polyline, reduced with Ramer–Douglas–Peucker, then refit to smooth cubic
 * béziers (Catmull-Rom tangents). Pairs naturally with the Pencil tool, which
 * produces dense paths. Edits in place, one undo step.
 */
import { evalCubic } from './path_ops';
import type { PathPoint, Subpath } from './types';
import type { WasmScene } from './wasm_scene';

type Pt = [number, number];

/** Flatten a subpath's cubic segments into a dense polyline. */
function flatten(sp: Subpath, perSeg = 16): Pt[] {
    const pts = sp.points;
    if (pts.length < 2) return pts.map((p) => [p.x, p.y] as Pt);
    const out: Pt[] = [];
    const segEnd = sp.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segEnd; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % pts.length];
        for (let s = 0; s < perSeg; s++) out.push(evalCubic(p0, p1, s / perSeg));
    }
    if (!sp.closed) out.push([pts[pts.length - 1].x, pts[pts.length - 1].y]);
    return out;
}

/** Perpendicular distance from p to the line through a→b. */
function perpDist(p: Pt, a: Pt, b: Pt): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Ramer–Douglas–Peucker polyline simplification. */
function rdp(pts: Pt[], eps: number): Pt[] {
    if (pts.length < 3) return pts.slice();
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack: [number, number][] = [[0, pts.length - 1]];
    while (stack.length) {
        const [s, e] = stack.pop()!;
        let maxD = 0;
        let idx = -1;
        for (let i = s + 1; i < e; i++) {
            const d = perpDist(pts[i], pts[s], pts[e]);
            if (d > maxD) {
                maxD = d;
                idx = i;
            }
        }
        if (maxD > eps && idx > 0) {
            keep[idx] = true;
            stack.push([s, idx], [idx, e]);
        }
    }
    return pts.filter((_, i) => keep[i]);
}

/** Refit a polyline to smooth cubic béziers using Catmull-Rom tangents. */
function refit(poly: Pt[], closed: boolean): PathPoint[] {
    // Drop a duplicated closing point if present.
    const P = poly.slice();
    if (closed && P.length > 1) {
        const a = P[0];
        const b = P[P.length - 1];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) P.pop();
    }
    const n = P.length;
    const at = (i: number): Pt => {
        if (closed) return P[((i % n) + n) % n];
        return P[Math.max(0, Math.min(n - 1, i))];
    };
    const out: PathPoint[] = [];
    for (let i = 0; i < n; i++) {
        const prev = at(i - 1);
        const next = at(i + 1);
        const cur = P[i];
        // Catmull-Rom tangent direction through the point.
        let tx = (next[0] - prev[0]) / 6;
        let ty = (next[1] - prev[1]) / 6;
        // Clamp handle length to a fraction of the nearer neighbor gap so tight
        // turns between unevenly-spaced points don't overshoot into cusps/loops.
        const dPrev = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
        const dNext = Math.hypot(cur[0] - next[0], cur[1] - next[1]);
        const hlen = Math.hypot(tx, ty);
        const maxLen = 0.4 * Math.min(dPrev || Infinity, dNext || Infinity);
        if (hlen > maxLen && hlen > 1e-9) {
            const scale = maxLen / hlen;
            tx *= scale;
            ty *= scale;
        }
        out.push({
            x: cur[0],
            y: cur[1],
            cp1: [cur[0] - tx, cur[1] - ty],
            cp2: [cur[0] + tx, cur[1] + ty],
        });
    }
    return out;
}

/** Total anchor count across a path's subpaths. */
export function pathPointCount(scene: WasmScene, nodeId: number): number {
    const subs = scene.getNodeGeometry(nodeId)?.Path?.subpaths;
    return subs ? subs.reduce((n, s) => n + s.points.length, 0) : 0;
}

/**
 * Simplify the given path node in place. `tolerance` is the max deviation in
 * world units (larger = fewer points). Returns the new total point count, or
 * null if the node isn't a path.
 */
export function simplifyPath(scene: WasmScene, nodeId: number, tolerance: number): number | null {
    const geom = scene.getNodeGeometry(nodeId);
    const subpaths = geom?.Path?.subpaths;
    if (!subpaths || subpaths.length === 0) return null;
    const eps = Math.max(0.01, tolerance);

    const simplified: Subpath[] = subpaths.map((sp) => {
        if (sp.points.length < 3) return sp; // nothing worth simplifying
        const reduced = rdp(flatten(sp), eps);
        if (reduced.length < 2) return sp;
        return { points: refit(reduced, sp.closed), closed: sp.closed };
    });

    let count = 0;
    scene.transaction(() => {
        scene.replaceGeometryWithPath(nodeId, simplified);
    });
    for (const sp of simplified) count += sp.points.length;
    return count;
}
