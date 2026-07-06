/**
 * outline_stroke.ts — Convert a path's stroke into a filled outline shape.
 *
 * Leverages CanvasKit's Path.stroke() to compute the offset outline, then
 * replaces the node's geometry with the outlined path and swaps the style:
 * fill = old stroke color, stroke = none.
 */

import type { CanvasKit } from 'canvaskit-wasm';
import type { WasmScene } from './wasm_scene';
import type { Subpath, PathPoint } from './types';

/** Bézier circle constant: 4·(√2−1)/3 */
const KAPPA = 0.5522847498;

/**
 * Convert a path node's stroke into a filled outline shape.
 *
 * The outline is computed using CanvasKit's `Path.stroke()`, which handles all
 * the complex offset geometry (miter joins, round caps, etc.).  The resulting
 * outline replaces the node's geometry and the style is updated so that
 * fill = old stroke color and stroke = none.
 *
 * @param ck     CanvasKit instance.
 * @param scene  The WASM scene wrapper.
 * @param nodeId ID of the path node to outline.
 */
export function outlineStroke(ck: CanvasKit, scene: WasmScene, nodeId: number): void {
    const geometry = scene.getNodeGeometry(nodeId);
    const style = scene.getNodeStyle(nodeId);
    if (!style || style.strokes.length === 0 || style.strokes[0].width <= 0) return;
    const stroke = style.strokes[0];

    // Build a CanvasKit path from the node's geometry (world space is not needed
    // here — we work in local space and keep the node's transform as-is).
    const ckPath = new ck.Path();
    if (!ckPath) return;

    if (geometry.Path) {
        buildCkPathFromSubpaths(ck, ckPath, geometry.Path.subpaths);
    } else if (geometry.Rect) {
        ckPath.addRect(ck.LTRBRect(0, 0, geometry.Rect.width, geometry.Rect.height));
    } else if (geometry.Ellipse) {
        const rx = geometry.Ellipse.radius_x;
        const ry = geometry.Ellipse.radius_y;
        ckPath.addOval(ck.LTRBRect(-rx, -ry, rx, ry));
    } else {
        ckPath.delete();
        return; // text or unsupported geometry
    }

    // Map stroke cap: 0 = Butt, 1 = Round, 2 = Square
    const capMap: Record<number, any> = {
        0: ck.StrokeCap.Butt,
        1: ck.StrokeCap.Round,
        2: ck.StrokeCap.Square,
    };
    // Map stroke join: 0 = Miter, 1 = Round, 2 = Bevel
    const joinMap: Record<number, any> = {
        0: ck.StrokeJoin.Miter,
        1: ck.StrokeJoin.Round,
        2: ck.StrokeJoin.Bevel,
    };

    const outlined = ckPath.stroke({
        width: stroke.width,
        miter_limit: stroke.miter_limit || 4,
        cap: capMap[stroke.cap] ?? ck.StrokeCap.Butt,
        join: joinMap[stroke.join] ?? ck.StrokeJoin.Miter,
    });

    ckPath.delete();
    if (!outlined) return;

    // Parse the outlined path back to subpaths
    const subpaths = parseCkPathToSubpaths(ck, outlined);
    outlined.delete();
    if (subpaths.length === 0) return;
    
    // Update the node: geometry = outlined path, fill = old stroke, stroke = none
    scene.updatePathPoints(nodeId, JSON.stringify(subpaths));

    const newStyle = { 
        ...style,
        fills: [stroke.paint],
        strokes: []
    };
    scene.setNodeStyleNoHistory(nodeId, JSON.stringify(newStyle));
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function buildCkPathFromSubpaths(ck: CanvasKit, ckPath: InstanceType<typeof ck.Path extends never ? never : { prototype: ReturnType<typeof ck.Path.Make> }> & { moveTo: Function; cubicTo: Function; close: Function }, subpaths: Subpath[]): void {
    for (const sp of subpaths) {
        if (sp.points.length < 2) continue;
        const first = sp.points[0];
        (ckPath as ReturnType<typeof ck.Path.Make>).moveTo(first.x, first.y);

        for (let i = 1; i < sp.points.length; i++) {
            const prev = sp.points[i - 1];
            const pt = sp.points[i];
            (ckPath as ReturnType<typeof ck.Path.Make>).cubicTo(
                prev.cp2[0], prev.cp2[1],
                pt.cp1[0], pt.cp1[1],
                pt.x, pt.y,
            );
        }

        if (sp.closed) {
            const last = sp.points[sp.points.length - 1];
            const first = sp.points[0];
            (ckPath as ReturnType<typeof ck.Path.Make>).cubicTo(
                last.cp2[0], last.cp2[1],
                first.cp1[0], first.cp1[1],
                first.x, first.y,
            );
            (ckPath as ReturnType<typeof ck.Path.Make>).close();
        }
    }
}

/** Parse a CanvasKit path back into engine subpaths via toCmds(). */
function parseCkPathToSubpaths(ck: CanvasKit, path: ReturnType<typeof ck.Path.Make>): Subpath[] {
    const cmds = (path as { toCmds: () => number[] }).toCmds();

    const ckVerbs = ck as unknown as Record<string, number>;
    const MOVE = ckVerbs.MOVE_VERB ?? 0;
    const LINE = ckVerbs.LINE_VERB ?? 1;
    const QUAD = ckVerbs.QUAD_VERB ?? 2;
    const CONIC = ckVerbs.CONIC_VERB ?? 3;
    const CUBIC = ckVerbs.CUBIC_VERB ?? 4;
    const CLOSE = ckVerbs.CLOSE_VERB ?? 5;
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
        if (argc === undefined) break;
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
