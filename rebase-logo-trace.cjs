// Vectorise the reference cube into flat regions.
//
// The cube is three skewed rectangles. For each one we invert the skew (sample
// the parallelogram on a square u,v grid), quantise to the palette, and trace.
//
// WHY A BOUNDARY NETWORK RATHER THAN PER-COLOUR CONTOURS.
// The obvious approach traces each colour's regions separately. That fits every
// shared boundary TWICE — once from each side — from different point sets, with
// corners landing in different places. The two copies disagree by a fraction of
// a cell, which shows up as hairline gaps and as a straight edge that kinks
// where one region's fit ends and its neighbour's begins. No amount of base
// fills or seam strokes fixes that; it only hides it.
//
// So: extract the boundary network ONCE. Every crack between two differently
// labelled cells is an edge; chains of them between junctions are arcs; each arc
// is fitted to a straight polyline a single time. Regions are then assembled
// from those shared arcs, so two regions meeting along an arc use identical
// vertices — coincident by construction, not by tolerance. Junction corners are
// kept exactly, so arcs meeting there agree to the last decimal.
const fs = require('node:fs');
const sharp = require('/Users/francesco/rebase/node_modules/.pnpm/sharp@0.35.3_@types+node@26.1.2/node_modules/sharp');

const N = Number(process.env.GRID || 512); // samples per face edge
const EPS = Number(process.env.EPS || 9); // corner tolerance, grid cells
const PASSES = Number(process.env.PASSES || 4); // majority-filter passes
const VOTE = Number(process.env.VOTE || 5); // of 9 neighbours needed to flip
const MIN_COMP = Number(process.env.MINCOMP || 900); // absorb regions under this (cells)
const MIN_AREA = Number(process.env.MINAREA || 300); // and drop these (output units²)
const OUT_SIZE = 1024;

const PALETTE = [
    '#24c4db', '#2b0ad9', '#8763eb', '#289fdb',
    '#fa9298', '#fb4a64', '#0d39ef', '#fcc703',
].map((h) => [h, [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))]);

// ─── geometry, recovered from the reference by fitting its six edges ────────
const V = {
    T: [1222.8, 0.8], UL: [164, 611.3], UR: [2282, 611.1],
    LL: [164, 1834.3], LR: [2282, 1834.3], B: [1223, 2445.3],
};
V.C = [V.UL[0] + V.UR[0] - V.T[0], V.UL[1] + V.UR[1] - V.T[1]];
const TRIM = 197; // how far the rounding cuts back from each sharp vertex

const face = (O, a, b) => ({ O, U: [a[0] - O[0], a[1] - O[1]], Vv: [b[0] - O[0], b[1] - O[1]] });
const P = 0.03;
// Sample past the two edges of each face that lie on the silhouette, so traced
// regions overshoot it and the clip cuts a clean edge. The other two edges are
// interior seams — overshooting there would bleed one face onto the next.
const FACES = {
    top: { ...face(V.UL, V.T, V.C), dom: [0, 1 + P, -P, 1] },
    left: { ...face(V.UL, V.C, V.LL), dom: [-P, 1, 0, 1 + P] },
    right: { ...face(V.C, V.UR, V.B), dom: [0, 1 + P, 0, 1 + P] },
};
const at = (f, u, v) => [f.O[0] + u * f.U[0] + v * f.Vv[0], f.O[1] + u * f.U[1] + v * f.Vv[1]];

// ─── line fitting ──────────────────────────────────────────────────────────
/** Total-least-squares line through points: a point and a unit direction. */
function fitLine(pts) {
    let cx = 0, cy = 0;
    for (const [x, y] of pts) { cx += x; cy += y; }
    cx /= pts.length; cy /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of pts) {
        const dx = x - cx, dy = y - cy;
        sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    return { p: [cx, cy], d: [Math.cos(0.5 * Math.atan2(2 * sxy, sxx - syy)), Math.sin(0.5 * Math.atan2(2 * sxy, sxx - syy))] };
}

function meetLines(a, b) {
    const den = a.d[0] * b.d[1] - a.d[1] * b.d[0];
    if (Math.abs(den) < 1e-9) return null;
    const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1];
    const t = (dx * b.d[1] - dy * b.d[0]) / den;
    return [a.p[0] + a.d[0] * t, a.p[1] + a.d[1] * t];
}

/** Douglas-Peucker on an OPEN polyline, returning kept indices. */
function dpIndices(pts, eps) {
    if (pts.length < 3) return pts.map((_, i) => i);
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
        const [i, j] = stack.pop();
        if (j <= i + 1) continue;
        const [ax, ay] = pts[i], [bx, by] = pts[j];
        const dx = bx - ax, dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        let best = -1, bd = eps;
        for (let k = i + 1; k < j; k++) {
            const d = Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / len;
            if (d > bd) { bd = d; best = k; }
        }
        if (best > 0) { keep[best] = true; stack.push([i, best], [best, j]); }
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
    return out;
}

/**
 * Give every corner ON an arc a single canonical straightened position.
 *
 * This is the trick that makes shared edges exact without any polygon surgery.
 * Each interior corner belongs to exactly ONE arc (a corner shared by two arcs
 * is by definition a junction, i.e. an endpoint), so projecting it onto that
 * arc's fitted line gives it one position that every region touching the arc
 * will use. Regions can then be traced independently, the ordinary way, and
 * still come out sharing their common edges to the last decimal.
 *
 * Junction endpoints are left exactly where they are, so the arcs meeting there
 * continue to agree.
 */
function straightenArc(arc, eps, cornerPos) {
    const pts = arc.pts;
    const put = (p, xy) => cornerPos.set(`${p[0]},${p[1]}`, xy);
    if (pts.length < 3) return;
    const idx = dpIndices(pts, eps);
    if (idx.length < 3) {
        // A single straight run: project everything onto one fitted line.
        const L = fitLine(pts);
        for (let k = 1; k < pts.length - 1; k++) put(pts[k], project(pts[k], L));
        return;
    }
    const lines = [];
    for (let i = 0; i < idx.length - 1; i++) lines.push(fitLine(pts.slice(idx[i], idx[i + 1] + 1)));

    // Corner vertices: where consecutive fitted lines meet.
    const vertexAt = new Map();
    for (let i = 0; i < lines.length - 1; i++) {
        const p = meetLines(lines[i], lines[i + 1]);
        const fb = pts[idx[i + 1]];
        const ok = p && Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
            Math.hypot(p[0] - fb[0], p[1] - fb[1]) < 1.5 * eps;
        vertexAt.set(idx[i + 1], ok ? p : fb);
    }
    for (let i = 0; i < lines.length; i++) {
        for (let k = idx[i]; k <= idx[i + 1]; k++) {
            if (k === 0 || k === pts.length - 1) continue; // junctions stay put
            if (vertexAt.has(k)) put(pts[k], vertexAt.get(k));
            else put(pts[k], project(pts[k], lines[i]));
        }
    }
}

/** Foot of the perpendicular from p onto a fitted line. */
function project(p, L) {
    const t = (p[0] - L.p[0]) * L.d[0] + (p[1] - L.p[1]) * L.d[1];
    return [L.p[0] + L.d[0] * t, L.p[1] + L.d[1] * t];
}

/** Drop repeats and points that sit on the line between their neighbours. */
function tidy(poly, tol = 0.02) {
    const out = [];
    for (const p of poly) {
        const q = out[out.length - 1];
        if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-7) out.push(p);
    }
    while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-7) {
        out.pop();
    }
    if (out.length < 4) return out;
    const keep = [];
    for (let i = 0; i < out.length; i++) {
        const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
        const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
        if (Math.abs(cross) / len > tol) keep.push(b);
    }
    return keep.length >= 3 ? keep : out;
}

// ─── polygon helpers ───────────────────────────────────────────────────────
function clipConvex(poly, clip) {
    let s2 = 0;
    for (let i = 0; i < clip.length; i++) {
        const q = clip[(i + 1) % clip.length];
        s2 += clip[i][0] * q[1] - q[0] * clip[i][1];
    }
    const sgn = s2 > 0 ? -1 : 1;
    let out = poly;
    for (let i = 0; i < clip.length && out.length; i++) {
        const a = clip[i], b = clip[(i + 1) % clip.length];
        const side = (p) => sgn * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
        const input = out;
        out = [];
        for (let k = 0; k < input.length; k++) {
            const A = input[k], B = input[(k + 1) % input.length];
            const sa = side(A), sb = side(B);
            if (sa <= 0) out.push(A);
            if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
                const t = sa / (sa - sb);
                out.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]);
            }
        }
    }
    return out;
}

const area = (p) => {
    let s = 0;
    for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; s += p[i][0] * q[1] - q[0] * p[i][1]; }
    return Math.abs(s) / 2;
};

/** Merge components smaller than `min` into their most common neighbour. */
function absorbSmall(lab, n, min) {
    for (;;) {
        const comp = new Int32Array(n * n).fill(-1);
        let next = 0;
        let changed = false;
        for (let s = 0; s < n * n; s++) {
            if (comp[s] !== -1) continue;
            const id = next++;
            const want = lab[s];
            const stack = [s];
            const cells = [];
            comp[s] = id;
            while (stack.length) {
                const k = stack.pop();
                cells.push(k);
                const x = k % n, y = (k / n) | 0;
                for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
                    const nk = ny * n + nx;
                    if (comp[nk] === -1 && lab[nk] === want) { comp[nk] = id; stack.push(nk); }
                }
            }
            if (cells.length >= min) continue;
            const tally = {};
            for (const k of cells) {
                const x = k % n, y = (k / n) | 0;
                for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
                    const v = lab[ny * n + nx];
                    if (v !== want) tally[v] = (tally[v] || 0) + 1;
                }
            }
            let bk = null, bn = 0;
            for (const k of Object.keys(tally)) if (tally[k] > bn) { bn = tally[k]; bk = Number(k); }
            if (bk === null) continue;
            for (const k of cells) lab[k] = bk;
            changed = true;
        }
        if (!changed) return;
    }
}

// ─── the boundary network ──────────────────────────────────────────────────
/**
 * Build arcs: maximal chains of cracks running between junctions, where a
 * junction is any grid corner at which more or fewer than two cracks meet.
 * Every arc is fitted once and shared by the two regions either side of it.
 */
function buildArcs(lab, n) {
    const cell = (x, y) => (x < 0 || y < 0 || x >= n || y >= n ? -1 : lab[y * n + x]);
    const adj = new Map(); // "x,y" -> [{to:[x,y], key}]
    const link = (a, b, key) => {
        const k = `${a[0]},${a[1]}`;
        if (!adj.has(k)) adj.set(k, []);
        adj.get(k).push({ to: b, key });
    };
    const allCracks = [];
    for (let y = 0; y <= n; y++) {
        for (let x = 0; x < n; x++) {
            if (cell(x, y - 1) !== cell(x, y)) {
                const key = `h${x},${y}`;
                allCracks.push(key);
                link([x, y], [x + 1, y], key);
                link([x + 1, y], [x, y], key);
            }
        }
    }
    for (let y = 0; y < n; y++) {
        for (let x = 0; x <= n; x++) {
            if (cell(x - 1, y) !== cell(x, y)) {
                const key = `v${x},${y}`;
                allCracks.push(key);
                link([x, y], [x, y + 1], key);
                link([x, y + 1], [x, y], key);
            }
        }
    }

    const arcs = [];
    const crackArc = new Map();
    const used = new Set();

    const walk = (from, first) => {
        const pts = [from.slice()];
        let cur = first.to, key = first.key;
        used.add(key);
        crackArc.set(key, arcs.length);
        pts.push(cur.slice());
        for (;;) {
            const nb = adj.get(`${cur[0]},${cur[1]}`) ?? [];
            if (nb.length !== 2) break; // a junction ends the arc
            const nxt = nb.find((e) => e.key !== key);
            if (!nxt || used.has(nxt.key)) break;
            used.add(nxt.key);
            crackArc.set(nxt.key, arcs.length);
            key = nxt.key;
            cur = nxt.to;
            pts.push(cur.slice());
        }
        arcs.push({ pts, a: pts[0], b: pts[pts.length - 1] });
    };

    for (const [ck, list] of adj) {
        if (list.length === 2) continue;
        const from = ck.split(',').map(Number);
        for (const e of list) if (!used.has(e.key)) walk(from, e);
    }
    // Anything left is a closed loop with no junction at all (an island).
    for (const key of allCracks) {
        if (used.has(key)) continue;
        const [ax, ay] = key.slice(1).split(',').map(Number);
        const start = [ax, ay];
        const e = (adj.get(`${start[0]},${start[1]}`) ?? []).find((x) => x.key === key);
        if (e) walk(start, e);
    }
    return { arcs, crackArc, adj };
}

(async () => {
    const src = process.argv[2];
    const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    const nearest = (r, g, b) => {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < PALETTE.length; i++) {
            const c = PALETTE[i][1];
            const dd = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
            if (dd < bd) { bd = dd; bi = i; }
        }
        return bi;
    };

    const regions = [];
    const bases = [];
    for (const [name, f] of Object.entries(FACES)) {
        const [u0, u1, v0, v1] = f.dom;
        const gu = (i) => u0 + (u1 - u0) * (i / N);
        const gv = (j) => v0 + (v1 - v0) * (j / N);

        const lab = new Int16Array(N * N);
        for (let j = 0; j < N; j++) {
            for (let i = 0; i < N; i++) {
                const [x, y] = at(f, gu(i + 0.5), gv(j + 0.5));
                const xi = Math.min(W - 1, Math.max(0, Math.round(x)));
                const yi = Math.min(H - 1, Math.max(0, Math.round(y)));
                const p = (yi * W + xi) << 2;
                lab[j * N + i] = data[p + 3] < 128 ? -1 : nearest(data[p], data[p + 1], data[p + 2]);
            }
        }
        // Grow colours into the transparent margin, far enough to out-reach the
        // padded domain, or the outermost ring stays unlabelled and the base
        // shows as a hairline along the silhouette.
        for (let pass = 0; pass < Math.ceil(P * N) + 12; pass++) {
            let changed = 0;
            const next = Int16Array.from(lab);
            for (let j = 0; j < N; j++) {
                for (let i = 0; i < N; i++) {
                    if (lab[j * N + i] !== -1) continue;
                    const c = {};
                    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                        const x = i + dx, y = j + dy;
                        if (x < 0 || y < 0 || x >= N || y >= N) continue;
                        const v = lab[y * N + x];
                        if (v >= 0) c[v] = (c[v] || 0) + 1;
                    }
                    let bK = null, bN = 0;
                    for (const k of Object.keys(c)) if (c[k] > bN) { bN = c[k]; bK = Number(k); }
                    if (bK !== null) { next[j * N + i] = bK; changed++; }
                }
            }
            lab.set(next);
            if (!changed) break;
        }
        // Majority vote settles the ragged boundaries a blurred source produces.
        let sm = lab;
        for (let pass = 0; pass < PASSES; pass++) {
            const next = Int16Array.from(sm);
            for (let j = 1; j < N - 1; j++) {
                for (let i = 1; i < N - 1; i++) {
                    const c = {};
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            const v = sm[(j + dy) * N + i + dx];
                            c[v] = (c[v] || 0) + 1;
                        }
                    }
                    let bK = null, bN = 0;
                    for (const k of Object.keys(c)) if (c[k] > bN) { bN = c[k]; bK = Number(k); }
                    if (bN >= VOTE) next[j * N + i] = bK;
                }
            }
            sm = next;
        }
        absorbSmall(sm, N, MIN_COMP);

        // A base in this face's own dominant colour: any hairline that survives
        // then shows a colour already surrounding it, not one from another face.
        const tally = new Array(PALETTE.length).fill(0);
        for (let k = 0; k < N * N; k++) if (sm[k] >= 0) tally[sm[k]]++;
        let bi = 0;
        for (let i = 1; i < tally.length; i++) if (tally[i] > tally[bi]) bi = i;
        bases.push({
            hex: PALETTE[bi][0],
            poly: [at(f, gu(0), gv(0)), at(f, gu(N), gv(0)), at(f, gu(N), gv(N)), at(f, gu(0), gv(N))],
        });

        // One network for the whole face. Each arc is straightened once and
        // every corner on it gets a single canonical position, so two regions
        // meeting along that arc land on identical vertices.
        const { arcs } = buildArcs(sm, N);
        const cornerPos = new Map();
        for (const arc of arcs) straightenArc(arc, EPS, cornerPos);
        const snap = ([x, y]) => cornerPos.get(`${x},${y}`) ?? [x, y];

        // Now trace each region the ordinary way and snap its corners.
        const seen = new Uint8Array(N * N);
        for (let s0 = 0; s0 < N * N; s0++) {
            if (seen[s0] || sm[s0] < 0) continue;
            const want = sm[s0];
            const cells = [];
            const stack = [s0];
            seen[s0] = 1;
            while (stack.length) {
                const k = stack.pop();
                cells.push(k);
                const x = k % N, y = (k / N) | 0;
                for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
                    const nk = ny * N + nx;
                    if (!seen[nk] && sm[nk] === want) { seen[nk] = 1; stack.push(nk); }
                }
            }
            const inside = new Set(cells);
            const has = (x, y) => x >= 0 && y >= 0 && x < N && y < N && inside.has(y * N + x);

            // Directed cracks around the region, chained into closed loops.
            const edges = new Map();
            const push = (a, b) => {
                const k = `${a[0]},${a[1]}`;
                if (!edges.has(k)) edges.set(k, []);
                edges.get(k).push(b);
            };
            for (const k of cells) {
                const x = k % N, y = (k / N) | 0;
                if (!has(x, y - 1)) push([x, y], [x + 1, y]);
                if (!has(x + 1, y)) push([x + 1, y], [x + 1, y + 1]);
                if (!has(x, y + 1)) push([x + 1, y + 1], [x, y + 1]);
                if (!has(x - 1, y)) push([x, y + 1], [x, y]);
            }
            for (const startKey of [...edges.keys()]) {
                while (edges.get(startKey)?.length) {
                    const start = startKey.split(',').map(Number);
                    const loop = [];
                    let cur = start;
                    for (let guard = 0; guard < 8 * N; guard++) {
                        const nb = edges.get(`${cur[0]},${cur[1]}`);
                        if (!nb || !nb.length) break;
                        loop.push(cur);
                        cur = nb.pop();
                        if (cur[0] === start[0] && cur[1] === start[1]) break;
                    }
                    if (loop.length < 4) continue;
                    const poly = tidy(loop.map(snap));
                    if (poly.length < 3) continue;
                    const world = poly.map(([gx, gy]) => at(f, gu(gx), gv(gy)));
                    if (area(world) > 40) regions.push({ face: name, hex: PALETTE[want][0], poly: world });
                }
            }
        }
    }

    // Rounded-hexagon silhouette, as a convex polygon to clip against.
    const order = [V.T, V.UR, V.LR, V.B, V.LL, V.UL];
    const lerp = (a, b, d) => {
        const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
        return [a[0] + (dx / L) * d, a[1] + (dy / L) * d];
    };
    const clipPoly = [];
    for (let i = 0; i < 6; i++) {
        const prev = order[(i + 5) % 6], cur = order[i], next = order[(i + 1) % 6];
        const a = lerp(cur, prev, TRIM), b = lerp(cur, next, TRIM);
        const STEPS = 16;
        for (let s = 0; s <= STEPS; s++) {
            const t = s / STEPS, mt = 1 - t;
            clipPoly.push([
                mt * mt * a[0] + 2 * mt * t * cur[0] + t * t * b[0],
                mt * mt * a[1] + 2 * mt * t * cur[1] + t * t * b[1],
            ]);
        }
    }

    const S = OUT_SIZE / W;
    const shaped = [];
    for (const r of regions) {
        const c = clipConvex(r.poly, clipPoly);
        if (c.length < 3) continue;
        const a = area(c) * S * S;
        if (a < MIN_AREA) continue;
        shaped.push({ ...r, poly: c.map(([x, y]) => [x * S, y * S]), a });
    }
    shaped.sort((p, q) => q.a - p.a);

    const n = (v) => (Math.round(v * 100) / 100).toString();
    const dOf = (poly) => `M${poly.map(([x, y]) => `${n(x)} ${n(y)}`).join('L')}Z`;
    const base = bases
        .map((b) => {
            const c = clipConvex(b.poly, clipPoly);
            return c.length < 3 ? '' : `<path fill="${b.hex}" d="${dOf(c.map(([x, y]) => [x * S, y * S]))}"/>`;
        })
        .filter(Boolean)
        .join('\n');
    // No seam stroke: shared arcs mean neighbouring regions already agree on
    // their common edge to the last decimal, so there is nothing to cover.
    const body = shaped.map((r) => `<path fill="${r.hex}" d="${dOf(r.poly)}"/>`).join('\n');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_SIZE}" height="${OUT_SIZE}" viewBox="0 0 ${OUT_SIZE} ${OUT_SIZE}">
<clipPath id="cube"><path d="${dOf(clipPoly.map(([x, y]) => [x * S, y * S]))}"/></clipPath>
<g clip-path="url(#cube)">
${base}
${body}
</g>
</svg>
`;
    fs.writeFileSync(process.argv[3], svg);
    const verts = shaped.map((r) => r.poly.length).sort((a, b) => a - b);
    console.log(JSON.stringify({
        paths: shaped.length,
        kb: +(svg.length / 1024).toFixed(1),
        medianVerts: verts[verts.length >> 1],
        maxVerts: verts[verts.length - 1],
    }, null, 1));
})();
