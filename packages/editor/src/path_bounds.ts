/**
 * Exact bounds for cubic Bézier geometry.
 *
 * Split out of the renderer because these numbers are not just drawn — the
 * selection frame, the resize handles and the gesture that sizes against them
 * all come from here, so a test that stubs this out (as every input test did)
 * cannot see a frame that has come off its artwork.
 */

/**
 * Report a cubic Bézier's exact extremes: the endpoints, plus wherever the
 * curve turns on an axis (the roots of B'(t)). This used to subdivide the
 * curve and report the sampled points, which can only ever land *inside* the
 * true extreme — so every curved shape's box sat a fraction within its own
 * outline, and the selection frame drawn from it never quite reached the
 * artwork. Solving is both exact and cheaper than subdividing.
 */
export function cubicBounds(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    grow: (x: number, y: number) => void,
) {
    grow(x0, y0);
    grow(x3, y3);
    const at = (t: number, a: number, b: number, c: number, d: number) => {
        const u = 1 - t;
        return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
    };
    for (const [c0, c1, c2, c3] of [
        [x0, x1, x2, x3],
        [y0, y1, y2, y3],
    ] as const) {
        // B'(t)/3 = a·t² + b·t + c
        const a = -c0 + 3 * c1 - 3 * c2 + c3;
        const b = 2 * (c0 - 2 * c1 + c2);
        const c = c1 - c0;
        const roots: number[] = [];
        if (Math.abs(a) < 1e-9) {
            if (Math.abs(b) > 1e-9) roots.push(-c / b);
        } else {
            const disc = b * b - 4 * a * c;
            if (disc >= 0) {
                const s = Math.sqrt(disc);
                roots.push((-b + s) / (2 * a), (-b - s) / (2 * a));
            }
        }
        // Only the solved axis is extreme at t, but the other coordinate there
        // is a real point on the curve, so growing by both is still tight.
        for (const t of roots) {
            if (t > 0 && t < 1) grow(at(t, x0, x1, x2, x3), at(t, y0, y1, y2, y3));
        }
    }
}

/** Bounds of a path's subpaths, in the space its points are given in. */
export function pathBounds(
    subpaths: Array<{
        points: Array<{ x: number; y: number; cp1: [number, number]; cp2: [number, number] }>;
        closed: boolean;
    }>,
) {
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    let hasPoints = false;
    const grow = (x: number, y: number) => {
        hasPoints = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    };
    for (const sp of subpaths) {
        const pts = sp.points;
        const n = pts.length;
        if (n === 0) continue;
        grow(pts[0].x, pts[0].y);
        const seg = (a: (typeof pts)[number], b: (typeof pts)[number]) =>
            cubicBounds(a.x, a.y, a.cp2[0], a.cp2[1], b.cp1[0], b.cp1[1], b.x, b.y, grow);
        for (let i = 1; i < n; i++) seg(pts[i - 1], pts[i]);
        if (sp.closed && n >= 2) seg(pts[n - 1], pts[0]);
    }
    return hasPoints ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}
