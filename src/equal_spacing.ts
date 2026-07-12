/**
 * equal_spacing.ts — Figma-style equal-spacing detection during a move drag.
 *
 * While dragging an object, Figma snaps it to positions where spacing is equal and
 * draws the matching gaps. It covers two situations, both handled here:
 *   (a) the object sits BETWEEN two neighbours with equal gaps on each side, and
 *   (b) the object's gap to a neighbour MATCHES an existing gap in the same row
 *       (i.e. it continues an even distribution).
 * For each axis we gather candidate snap positions, pick the one nearest the
 * object's current position, and report the delta to snap there plus the two gap
 * segments to draw (each labelled with the same distance).
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
    /** The two equal gap segments (at the snapped position) to draw. */
    segs: [GapSeg, GapSeg];
}

/** A bounds projected onto a main axis: `lo`/`hi` along it, `clo`/`chi` across it. */
interface Proj {
    lo: number;
    hi: number;
    clo: number;
    chi: number;
}
function project(b: Bounds, axis: 'x' | 'y'): Proj {
    return axis === 'x'
        ? { lo: b[0], hi: b[2], clo: b[1], chi: b[3] }
        : { lo: b[1], hi: b[3], clo: b[0], chi: b[2] };
}
/** Overlap length of two ranges on the cross axis (>0.5 ⇒ "same row/column"). */
function crossOverlap(a: Proj, b: Proj): number {
    return Math.min(a.chi, b.chi) - Math.max(a.clo, b.clo);
}
/** Cross-axis center of the band where two objects overlap — where to draw a gap. */
function crossMid(a: Proj, b: Proj): number {
    return (Math.max(a.clo, b.clo) + Math.min(a.chi, b.chi)) / 2;
}

interface Candidate {
    center: number; // target main-axis center for the moving object
    gap: number;
    segs: [GapSeg, GapSeg];
}

/** Best equal-spacing match for one axis, or null. */
function axisMatch(S: Bounds, others: Bounds[], axis: 'x' | 'y'): EqualMatch | null {
    const s = project(S, axis);
    const size = s.hi - s.lo;
    const center = (s.lo + s.hi) / 2;

    // Objects that share a row/column with the moving object.
    const row = others.map((b) => project(b, axis)).filter((p) => crossOverlap(p, s) > 0.5);
    const left = row.filter((p) => p.hi <= s.lo).sort((a, b) => b.hi - a.hi); // nearest first
    const right = row.filter((p) => p.lo >= s.hi).sort((a, b) => a.lo - b.lo);
    const L = left[0];
    const R = right[0];

    const seg = (a: number, b: number, pos: number): GapSeg => ({ a, b, pos });
    const cands: Candidate[] = [];

    // (a) Centred between the immediate left and right neighbours (equal both sides).
    if (L && R) {
        const gap = (R.lo - L.hi - size) / 2;
        if (gap > 0.5) {
            const c = (L.hi + R.lo) / 2;
            cands.push({
                center: c,
                gap,
                segs: [
                    seg(L.hi, c - size / 2, crossMid(L, s)),
                    seg(c + size / 2, R.lo, crossMid(R, s)),
                ],
            });
        }
    }
    // (b) Match the gap that already exists to the LEFT of the left neighbour.
    if (L) {
        const L2 = left.find((p) => p.hi <= L.lo && crossOverlap(p, L) > 0.5);
        const g = L2 ? L.lo - L2.hi : -1;
        if (L2 && g > 0.5) {
            const nlo = L.hi + g;
            cands.push({
                center: nlo + size / 2,
                gap: g,
                segs: [seg(L2.hi, L.lo, crossMid(L2, L)), seg(L.hi, nlo, crossMid(L, s))],
            });
        }
    }
    // (c) Match the gap that already exists to the RIGHT of the right neighbour.
    if (R) {
        const R2 = right.find((p) => p.lo >= R.hi && crossOverlap(p, R) > 0.5);
        const g = R2 ? R2.lo - R.hi : -1;
        if (R2 && g > 0.5) {
            const nhi = R.lo - g;
            cands.push({
                center: nhi - size / 2,
                gap: g,
                segs: [seg(R.hi, R2.lo, crossMid(R, R2)), seg(nhi, R.lo, crossMid(R, s))],
            });
        }
    }

    if (cands.length === 0) return null;
    cands.sort((a, b) => Math.abs(a.center - center) - Math.abs(b.center - center));
    const best = cands[0];
    return { axis, delta: best.center - center, gap: best.gap, segs: best.segs };
}

/** A live gap to draw while dragging, tagged with its orientation. */
export interface DragGap extends GapSeg {
    axis: 'h' | 'v';
}

/** The current gaps from the moving selection `S` to its immediate neighbours on
 *  each side (that share a row/column) — the live readout Figma shows throughout a
 *  drag, equal or not. */
export function neighborGaps(scene: WasmScene, movingIds: number[], S: Bounds): DragGap[] {
    const moving = new Set(movingIds);
    const others: Bounds[] = [];
    for (const id of scene.getRootNodes()) {
        if (moving.has(id)) continue;
        const b = scene.getNodeBounds(id);
        if (b && b.length >= 4) others.push([b[0], b[1], b[2], b[3]]);
    }

    const out: DragGap[] = [];
    for (const axis of ['x', 'y'] as const) {
        const s = project(S, axis);
        const draw = axis === 'x' ? 'h' : 'v';
        let L: Proj | undefined;
        let R: Proj | undefined;
        for (const b of others) {
            const p = project(b, axis);
            if (crossOverlap(p, s) <= 0.5) continue;
            if (p.hi <= s.lo) {
                if (!L || p.hi > L.hi) L = p; // nearest on the low side
            } else if (p.lo >= s.hi) {
                if (!R || p.lo < R.lo) R = p; // nearest on the high side
            }
        }
        if (L && s.lo - L.hi > 0.5) out.push({ a: L.hi, b: s.lo, pos: crossMid(L, s), axis: draw });
        if (R && R.lo - s.hi > 0.5) out.push({ a: s.hi, b: R.lo, pos: crossMid(R, s), axis: draw });
    }
    return out;
}

/** Detect the best horizontal and vertical equal-spacing match for the moving
 *  selection `S` (each may be null). The caller snaps when the delta is small. */
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
    return { x: axisMatch(S, others, 'x'), y: axisMatch(S, others, 'y') };
}
