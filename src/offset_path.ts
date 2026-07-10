/**
 * offset_path.ts — Illustrator "Object › Path › Offset Path".
 *
 * Creates a NEW path parallel to a selected path at `distance` world units
 * (positive = outset/grow, negative = inset/shrink). Non-destructive: the
 * offset is a new node above the original, carrying its style and transform.
 *
 * Implementation reuses the CanvasKit path-op machinery. Stroking the outline
 * yields a band of width 2·|d| centred on the path; unioning that band with the
 * filled shape grows it, subtracting shrinks it — CanvasKit resolves the joins
 * and any self-intersections. For an OPEN path the band itself is the closed
 * offset outline (matching Illustrator's behaviour).
 */
import type { CanvasKit, Path } from 'canvaskit-wasm';
import { appendSubpathsToPath, pathToSubpaths } from './boolean_ops';
import type { WasmScene } from './wasm_scene';

/** Offset the given path node by `distance`. Returns the new node id, or null. */
export function offsetPath(
    ck: CanvasKit,
    scene: WasmScene,
    nodeId: number,
    distance: number,
): number | null {
    if (!distance || !Number.isFinite(distance)) return null;
    const geom = scene.getNodeGeometry(nodeId);
    const subpaths = geom?.Path?.subpaths;
    if (!subpaths || subpaths.length === 0) return null;

    const base = new ck.Path();
    appendSubpathsToPath(base, subpaths);

    // Stroke a copy of the outline into a band of width 2·|d|. stroke() mutates
    // the path in place and returns it (null on failure).
    const band = base.copy();
    if (
        !band.stroke({
            width: Math.abs(distance) * 2,
            join: ck.StrokeJoin.Round,
            cap: ck.StrokeCap.Round,
        })
    ) {
        base.delete();
        band.delete();
        return null;
    }

    const anyClosed = subpaths.some((s) => s.closed);
    let result: Path | null;
    if (!anyClosed) {
        // Open path: the band is already the closed offset outline.
        base.delete();
        result = band; // ownership transfers to `result`
    } else {
        const op = distance > 0 ? ck.PathOp.Union : ck.PathOp.Difference;
        result = ck.Path.MakeFromOp(base, band, op);
        base.delete();
        band.delete();
        if (!result) return null;
    }

    const offsetSubpaths = pathToSubpaths(ck, result);
    const fillRule = result.getFillType() === ck.FillType.EvenOdd ? 1 : 0;
    result.delete();
    if (offsetSubpaths.length === 0) return null;

    // Non-destructive: duplicate (keeps style + transform), swap in the geometry.
    // One undo step via transaction().
    let newId = -1;
    scene.transaction(() => {
        newId = scene.duplicateNode(nodeId);
        scene.replaceGeometryWithPath(newId, offsetSubpaths);
        const style = scene.getNodeStyle(newId);
        scene.setNodeStyleNoHistory(newId, JSON.stringify({ ...style, fill_rule: fillRule }));
    });
    return newId >= 0 ? newId : null;
}
