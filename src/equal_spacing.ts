/**
 * equal_spacing.ts — Figma-style equal-spacing detection during a move drag.
 *
 * When the dragged object sits between a neighbor on each side (that overlaps it
 * on the perpendicular axis), and the two gaps are (nearly) equal, we report a
 * match: the exact delta that makes them equal (so the drag can SNAP to it) plus
 * the two gap segments to draw as pink measurements. This is the useful half of
 * Figma's smart measurements — "these gaps are now equal" — not a raw readout.
 */
import type { WasmScene } from './wasm_scene';

type Bounds = [number, number, number, number]; // x0, y0, x1, y1

/** One gap to draw: a line along the axis from `a` to `b` at cross-position `pos`. */
export interface GapSeg {
    a: number;
    b: number;
    pos: number;
}

export interface EqualMatch {
    axis: 'x' | 'y';
    /** Add to the selection's position on this axis to make the gaps exactly equal. */
    delta: number;
    /** The equal gap value (world units). */
    gap: number;
    /** The two gap segments (already at the snapped position) to draw. */
    segs: [GapSeg, GapSeg];
}

/** Do the 1-D ranges [a0,a1] and [b0,b1] overlap (with a hair of margin)? */
function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
    return Math.min(a1, b1) - Math.max(a0, b0) > 0.5;
}

/**
 * Detect equal-spacing candidates for the moving selection `S`. Returns the best
 * horizontal and vertical match (or null each). The caller decides whether to
 * snap, based on each match's `delta` vs a pixel threshold.
 */
export function computeEqualSpacing(
    scene: WasmScene,
    movingIds: number[],
    S: Bounds,
): { x: EqualMatch | null; y: EqualMatch | null } {
    const moving = new Set(movingIds);
    const others: Bounds[] = [];
    for (const id of scene.getRootNodes()) {
        if (moving.has(id)) continue;
        const b = scene.getNodeBounds(id);
        if (b && b.length >= 4) others.push([b[0], b[1], b[2], b[3]]);
    }

    const [sx0, sy0, sx1, sy1] = S;
    const scx = (sx0 + sx1) / 2;
    const scy = (sy0 + sy1) / 2;
    const sw = sx1 - sx0;
    const sh = sy1 - sy0;

    // ── Horizontal: nearest neighbor left + right that overlap S vertically ──
    let x: EqualMatch | null = null;
    {
        let L: Bounds | null = null;
        let R: Bounds | null = null;
        for (const o of others) {
            if (!overlaps(sy0, sy1, o[1], o[3])) continue;
            if (o[2] <= sx0) {
                if (!L || o[2] > L[2]) L = o; // closest left (largest right edge)
            } else if (o[0] >= sx1) {
                if (!R || o[0] < R[0]) R = o; // closest right (smallest left edge)
            }
        }
        if (L && R) {
            const gap = (R[0] - L[2] - sw) / 2;
            if (gap > 0.5) {
                const targetCx = (L[2] + R[0]) / 2;
                const ns0 = targetCx - sw / 2;
                const ns1 = targetCx + sw / 2;
                x = {
                    axis: 'x',
                    delta: targetCx - scx,
                    gap,
                    segs: [
                        { a: L[2], b: ns0, pos: scy },
                        { a: ns1, b: R[0], pos: scy },
                    ],
                };
            }
        }
    }

    // ── Vertical: nearest neighbor above + below that overlap S horizontally ──
    let y: EqualMatch | null = null;
    {
        let T: Bounds | null = null;
        let B: Bounds | null = null;
        for (const o of others) {
            if (!overlaps(sx0, sx1, o[0], o[2])) continue;
            if (o[3] <= sy0) {
                if (!T || o[3] > T[3]) T = o;
            } else if (o[1] >= sy1) {
                if (!B || o[1] < B[1]) B = o;
            }
        }
        if (T && B) {
            const gap = (B[1] - T[3] - sh) / 2;
            if (gap > 0.5) {
                const targetCy = (T[3] + B[1]) / 2;
                const ns0 = targetCy - sh / 2;
                const ns1 = targetCy + sh / 2;
                y = {
                    axis: 'y',
                    delta: targetCy - scy,
                    gap,
                    segs: [
                        { a: T[3], b: ns0, pos: scx },
                        { a: ns1, b: B[1], pos: scx },
                    ],
                };
            }
        }
    }

    return { x, y };
}
