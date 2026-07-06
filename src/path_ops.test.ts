import { describe, it, expect } from 'vitest';
import { mergeSelectedAnchors } from './path_ops';
import type { PathPoint, Subpath } from './types';

/** Corner-style anchor (retracted handles) at (x, y). */
function pt(x: number, y: number, extra: Partial<PathPoint> = {}): PathPoint {
    return { x, y, cp1: [x, y], cp2: [x, y], ...extra };
}

function open(...points: PathPoint[]): Subpath {
    return { points, closed: false };
}

function closed(...points: PathPoint[]): Subpath {
    return { points, closed: true };
}

describe('mergeSelectedAnchors', () => {
    it('returns null for fewer than 2 selected points', () => {
        const sp = [open(pt(0, 0), pt(10, 0))];
        expect(mergeSelectedAnchors(sp, [{ subpathIdx: 0, pointIdx: 0 }])).toBeNull();
    });

    it('welds the endpoints of two open subpaths into one subpath', () => {
        const sp = [
            open(pt(0, 0), pt(10, 0)),   // A: tail at (10, 0)
            open(pt(20, 0), pt(30, 0)),  // B: head at (20, 0)
        ];
        const result = mergeSelectedAnchors(sp, [
            { subpathIdx: 0, pointIdx: 1 }, // A end
            { subpathIdx: 1, pointIdx: 0 }, // B start
        ]);
        expect(result).not.toBeNull();
        expect(result!.length).toBe(1);
        const merged = result![0];
        expect(merged.closed).toBe(false);
        expect(merged.points.length).toBe(3);
        // Welded anchor at midpoint of (10,0) and (20,0)
        expect(merged.points[1].x).toBe(15);
        expect(merged.points[1].y).toBe(0);
        expect(merged.points[0].x).toBe(0);
        expect(merged.points[2].x).toBe(30);
    });

    it('reverses subpaths as needed to weld start-to-start', () => {
        const sp = [
            open(pt(10, 0), pt(0, 0)),   // A: start at (10, 0)
            open(pt(20, 0), pt(30, 0)),  // B: start at (20, 0)
        ];
        const result = mergeSelectedAnchors(sp, [
            { subpathIdx: 0, pointIdx: 0 },
            { subpathIdx: 1, pointIdx: 0 },
        ]);
        expect(result).not.toBeNull();
        expect(result!.length).toBe(1);
        const xs = result![0].points.map(p => p.x);
        expect(xs).toEqual([0, 15, 30]);
    });

    it('does not weld across subpaths when a point is interior', () => {
        const sp = [
            open(pt(0, 0), pt(5, 5), pt(10, 0)),
            open(pt(20, 0), pt(30, 0)),
        ];
        const result = mergeSelectedAnchors(sp, [
            { subpathIdx: 0, pointIdx: 1 }, // interior
            { subpathIdx: 1, pointIdx: 0 },
        ]);
        expect(result).toBeNull();
    });

    it('closes an open subpath when its two endpoints are merged', () => {
        const sp = [open(pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 2))];
        const result = mergeSelectedAnchors(sp, [
            { subpathIdx: 0, pointIdx: 0 },
            { subpathIdx: 0, pointIdx: 3 },
        ]);
        expect(result).not.toBeNull();
        const merged = result![0];
        expect(merged.closed).toBe(true);
        expect(merged.points.length).toBe(3);
        // Welded anchor at midpoint of (0,0) and (0,2)
        expect(merged.points[0].x).toBe(0);
        expect(merged.points[0].y).toBe(1);
    });

    it('collapses adjacent selected anchors into their average', () => {
        const sp = [open(pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0))];
        const result = mergeSelectedAnchors(sp, [
            { subpathIdx: 0, pointIdx: 1 },
            { subpathIdx: 0, pointIdx: 2 },
        ]);
        expect(result).not.toBeNull();
        const xs = result![0].points.map(p => p.x);
        expect(xs).toEqual([0, 15, 30]);
    });

    it('keeps the incoming handle of the first and outgoing handle of the last merged point', () => {
        const a = pt(10, 0, { cp1: [8, -2] });
        const b = pt(20, 0, { cp2: [22, 2] });
        const sp = [open(pt(0, 0), a, b, pt(30, 0))];
        const result = mergeSelectedAnchors(sp, [
            { subpathIdx: 0, pointIdx: 1 },
            { subpathIdx: 0, pointIdx: 2 },
        ]);
        const merged = result![0].points[1];
        expect(merged.cp1).toEqual([8, -2]);
        expect(merged.cp2).toEqual([22, 2]);
    });

    it('collapses a wraparound run on a closed subpath', () => {
        const sp = [closed(pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10))];
        // Select last and first points — adjacent across the wrap
        const result = mergeSelectedAnchors(sp, [
            { subpathIdx: 0, pointIdx: 3 },
            { subpathIdx: 0, pointIdx: 0 },
        ]);
        expect(result).not.toBeNull();
        const merged = result![0];
        expect(merged.points.length).toBe(3);
        expect(merged.closed).toBe(true);
        // The welded point averages (0,10) and (0,0)
        expect(merged.points.some(p => p.x === 0 && p.y === 5)).toBe(true);
    });

    it('does not weld the ends of an open subpath through the gap', () => {
        // First and last points of an open path are NOT adjacent — selecting
        // them plus nothing else with 3+ points triggers the close case, but a
        // 2-point open path must refuse (would collapse to a single point).
        const sp = [open(pt(0, 0), pt(10, 0))];
        const result = mergeSelectedAnchors(sp, [
            { subpathIdx: 0, pointIdx: 0 },
            { subpathIdx: 0, pointIdx: 1 },
        ]);
        expect(result).toBeNull();
    });

    it('refuses to collapse an entire closed subpath', () => {
        const sp = [closed(pt(0, 0), pt(10, 0), pt(5, 10))];
        const result = mergeSelectedAnchors(sp, [
            { subpathIdx: 0, pointIdx: 0 },
            { subpathIdx: 0, pointIdx: 1 },
            { subpathIdx: 0, pointIdx: 2 },
        ]);
        expect(result).toBeNull();
    });

    it('preserves the max corner radius of merged points', () => {
        const sp = [open(
            pt(0, 0),
            pt(10, 0, { corner_radius: 4 }),
            pt(20, 0, { corner_radius: 2 }),
            pt(30, 0),
        )];
        const result = mergeSelectedAnchors(sp, [
            { subpathIdx: 0, pointIdx: 1 },
            { subpathIdx: 0, pointIdx: 2 },
        ]);
        expect(result![0].points[1].corner_radius).toBe(4);
    });

    it('merges multiple runs across multiple subpaths in one call', () => {
        const sp = [
            open(pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0)),
            open(pt(0, 50), pt(10, 50), pt(20, 50)),
        ];
        const result = mergeSelectedAnchors(sp, [
            { subpathIdx: 0, pointIdx: 0 },
            { subpathIdx: 0, pointIdx: 1 },
            { subpathIdx: 1, pointIdx: 1 },
            { subpathIdx: 1, pointIdx: 2 },
        ]);
        expect(result).not.toBeNull();
        expect(result![0].points.map(p => p.x)).toEqual([5, 20, 30]);
        expect(result![1].points.map(p => p.x)).toEqual([0, 15]);
    });

    it('does not mutate the input subpaths', () => {
        const sp = [open(pt(0, 0), pt(10, 0), pt(20, 0))];
        const snapshot = JSON.stringify(sp);
        mergeSelectedAnchors(sp, [
            { subpathIdx: 0, pointIdx: 0 },
            { subpathIdx: 0, pointIdx: 1 },
        ]);
        expect(JSON.stringify(sp)).toBe(snapshot);
    });
});
