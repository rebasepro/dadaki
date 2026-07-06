/**
 * Boolean path operations (union / subtract / intersect / exclude) built on
 * CanvasKit's Path.MakeFromOp. Input nodes are converted to world-space
 * CanvasKit paths, combined, and the result is parsed back into engine
 * subpaths via Path.toCmds().
 */
import type { CanvasKit, Path } from 'canvaskit-wasm';
import type { WasmScene } from './wasm_scene';
import type { Subpath, PathPoint } from './types';

export type BoolOp = 'union' | 'subtract' | 'intersect' | 'exclude';

/** Bezier circle constant: 4·(√2−1)/3 */
const KAPPA = 0.5522847498;

/**
 * Apply a boolean operation to the given nodes (2+). The originals are
 * replaced by a single path node carrying the first node's style.
 * Returns the new node id, or null if the operation failed.
 */
export function applyBooleanOp(
    ck: CanvasKit,
    scene: WasmScene,
    ids: number[],
    op: BoolOp,
): number | null {
    if (ids.length < 2) return null;

    const paths: Path[] = [];
    for (const id of ids) {
        const p = nodeToWorldPath(ck, scene, id);
        if (p) paths.push(p);
        else {
            // Unsupported node in the selection (e.g. text) — abort cleanly
            for (const q of paths) q.delete();
            return null;
        }
    }

    const opMap = {
        union: ck.PathOp.Union,
        subtract: ck.PathOp.Difference,
        intersect: ck.PathOp.Intersect,
        exclude: ck.PathOp.XOR,
    } as const;

    let result = paths[0];
    for (let i = 1; i < paths.length; i++) {
        const combined = ck.Path.MakeFromOp(result, paths[i], opMap[op]);
        result.delete();
        paths[i].delete();
        if (!combined) return null;
        result = combined;
    }

    const subpaths = pathToSubpaths(ck, result);
    // MakeFromOp emits contours under this fill type (in practice EvenOdd,
    // with holes wound the same way) — the node style must match or holes
    // render and hit-test as filled.
    const resultFillRule = result.getFillType() === ck.FillType.EvenOdd ? 1 : 0;
    result.delete();
    if (subpaths.length === 0) {
        // Empty result (e.g. intersect of disjoint shapes) — treat as failure
        // rather than silently deleting the originals.
        return null;
    }

    // Carry over the style of the first (bottom-most in selection order) node
    const styleData = scene.getNodeStyle(ids[0]);
    const styleJson = styleData
        ? JSON.stringify({ ...styleData, fill_rule: resultFillRule })
        : null;

    return scene.replaceNodesWithPath(ids, JSON.stringify(subpaths), styleJson);
}

/** Build a world-space CanvasKit path for a node (recursing into groups). */
function nodeToWorldPath(
    ck: CanvasKit,
    scene: WasmScene,
    id: number,
): Path | null {
    const node = scene.getNode(id);
    if (!node) return null;

    if (node.node_type === 'Group') {
        const acc = new ck.Path();
        const children = Array.from(scene.getNodeChildren(id));
        for (const childId of children) {
            const childPath = nodeToWorldPath(ck, scene, childId);
            if (childPath) {
                acc.addPath(childPath);
                childPath.delete();
            }
        }
        return acc;
    }

    const geometry = scene.getNodeGeometry(id);
    const style = scene.getNodeStyle(id);
    const path = new ck.Path();
    if (geometry.Rect) {
        const { width, height } = geometry.Rect;
        const r = style.corner_radius || 0;
        if (r > 0) {
            path.addRRect(ck.RRectXY(ck.LTRBRect(0, 0, width, height), r, r));
        } else {
            path.addRect(ck.LTRBRect(0, 0, width, height));
        }
    } else if (geometry.Ellipse) {
        // Build with cubics (not addOval) so boolean results contain no conics
        const { radius_x: rx, radius_y: ry } = geometry.Ellipse;
        const kx = rx * KAPPA, ky = ry * KAPPA;
        path.moveTo(0, -ry);
        path.cubicTo(kx, -ry, rx, -ky, rx, 0);
        path.cubicTo(rx, ky, kx, ry, 0, ry);
        path.cubicTo(-kx, ry, -rx, ky, -rx, 0);
        path.cubicTo(-rx, -ky, -kx, -ry, 0, -ry);
        path.close();
    } else if (geometry.Path) {
        // Use the resolved outline so per-vertex corner radii are honoured in
        // the boolean result (matches what is rendered).
        const resolved = scene.getResolvedSubpaths(id);
        const subpaths = resolved.length ? resolved : geometry.Path.subpaths;
        for (const sp of subpaths) {
            const pts = sp.points;
            if (pts.length < 2) continue;
            path.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
                const prev = pts[i - 1];
                const p = pts[i];
                path.cubicTo(prev.cp2[0], prev.cp2[1], p.cp1[0], p.cp1[1], p.x, p.y);
            }
            if (sp.closed) {
                const last = pts[pts.length - 1];
                const first = pts[0];
                path.cubicTo(last.cp2[0], last.cp2[1], first.cp1[0], first.cp1[1], first.x, first.y);
                path.close();
            }
        }
    } else {
        // Text and other geometries aren't supported in boolean ops
        path.delete();
        return null;
    }

    // Transform into world space (row-major 3x3 from the engine)
    const t = scene.getTransform(id);
    path.transform(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8]);
    return path;
}

/** Parse a CanvasKit path back into engine subpaths via toCmds(). */
function pathToSubpaths(ck: CanvasKit, path: Path): Subpath[] {
    const cmds = path.toCmds();

    const ckAny = ck as unknown as Record<string, number>;
    const MOVE = ckAny.MOVE_VERB ?? 0;
    const LINE = ckAny.LINE_VERB ?? 1;
    const QUAD = ckAny.QUAD_VERB ?? 2;
    const CONIC = ckAny.CONIC_VERB ?? 3;
    const CUBIC = ckAny.CUBIC_VERB ?? 4;
    const CLOSE = ckAny.CLOSE_VERB ?? 5;
    const ARG_COUNT: Record<number, number> = {
        [MOVE]: 2, [LINE]: 2, [QUAD]: 4, [CONIC]: 5, [CUBIC]: 6, [CLOSE]: 0,
    };

    const subpaths: Subpath[] = [];
    let current: PathPoint[] = [];
    let closed = false;

    const flush = () => {
        if (current.length >= 2) {
            subpaths.push({ points: current, closed });
        }
        current = [];
        closed = false;
    };
    const pt = (x: number, y: number): PathPoint => ({ x, y, cp1: [x, y], cp2: [x, y] });

    let i = 0;
    const n = cmds.length;
    while (i < n) {
        const verb = cmds[i++];
        const argc = ARG_COUNT[verb];
        if (argc === undefined) break; // unknown verb — stop parsing defensively
        const args: number[] = [];
        for (let a = 0; a < argc; a++) args.push(cmds[i++]);

        if (verb === MOVE) {
            flush();
            current.push(pt(args[0], args[1]));
        } else if (verb === LINE) {
            current.push(pt(args[0], args[1]));
        } else if (verb === CUBIC) {
            const prev = current[current.length - 1];
            if (prev) prev.cp2 = [args[0], args[1]];
            const p = pt(args[4], args[5]);
            p.cp1 = [args[2], args[3]];
            current.push(p);
        } else if (verb === QUAD || verb === CONIC) {
            // Elevate quad (or approximate conic) to cubic
            const prev = current[current.length - 1];
            const p0x = prev ? prev.x : args[0];
            const p0y = prev ? prev.y : args[1];
            const qx = args[0], qy = args[1];
            const ex = args[2], ey = args[3];
            const c1x = p0x + (2 / 3) * (qx - p0x);
            const c1y = p0y + (2 / 3) * (qy - p0y);
            const c2x = ex + (2 / 3) * (qx - ex);
            const c2y = ey + (2 / 3) * (qy - ey);
            if (prev) prev.cp2 = [c1x, c1y];
            const p = pt(ex, ey);
            p.cp1 = [c2x, c2y];
            current.push(p);
        } else if (verb === CLOSE) {
            // Drop an explicit closing point that duplicates the start
            if (current.length >= 2) {
                const first = current[0];
                const last = current[current.length - 1];
                if (Math.abs(first.x - last.x) < 1e-3 && Math.abs(first.y - last.y) < 1e-3) {
                    first.cp1 = last.cp1;
                    current.pop();
                }
            }
            closed = true;
            flush();
        }
    }
    flush();
    return subpaths;
}
