/**
 * Pure utility functions for SVG parsing and color conversion.
 * Extracted from UIEngine for testability and reuse.
 */
import type { Color } from './types';

/** Convert a hex color string to RGBA color object (0-1 range). */
export function hexToRgb(hex: string): Color {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return { r, g, b, a: 1.0 };
}

/** Convert an RGB color object (0-1 range) to hex string. */
export function rgbToHex(color: { r: number; g: number; b: number }): string {
    const r = Math.round((color.r || 0) * 255).toString(16).padStart(2, '0');
    const g = Math.round((color.g || 0) * 255).toString(16).padStart(2, '0');
    const b = Math.round((color.b || 0) * 255).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
}

/** Tokenize an SVG number string, handling negatives, decimals, and scientific notation. */
export function tokenizeSVGNumbers(numStr: string): number[] {
    const results: number[] = [];
    const regex = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
    let m;
    while ((m = regex.exec(numStr)) !== null) {
        const n = parseFloat(m[0]);
        if (!isNaN(n)) results.push(n);
    }
    return results;
}

/** An arc-to-cubic-bezier segment. */
export interface ArcSegment {
    c1x: number; c1y: number;
    c2x: number; c2y: number;
    ex: number; ey: number;
}

/**
 * Convert an SVG arc to a series of cubic Bézier curves.
 * Based on the W3C algorithm for endpoint-to-center arc conversion.
 */
export function arcToCubicBeziers(
    x1: number, y1: number,
    rx: number, ry: number,
    phi: number,
    largeArc: boolean, sweep: boolean,
    x2: number, y2: number
): ArcSegment[] {
    const result: ArcSegment[] = [];

    if (rx === 0 || ry === 0) {
        return [{ c1x: x1, c1y: y1, c2x: x2, c2y: y2, ex: x2, ey: y2 }];
    }

    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);

    const dx = (x1 - x2) / 2;
    const dy = (y1 - y2) / 2;
    const x1p = cosPhi * dx + sinPhi * dy;
    const y1p = -sinPhi * dx + cosPhi * dy;

    let rxSq = rx * rx, rySq = ry * ry;
    const x1pSq = x1p * x1p, y1pSq = y1p * y1p;
    const lambda = x1pSq / rxSq + y1pSq / rySq;
    if (lambda > 1) {
        const sqrtLambda = Math.sqrt(lambda);
        rx *= sqrtLambda;
        ry *= sqrtLambda;
        rxSq = rx * rx;
        rySq = ry * ry;
    }

    let sq = Math.max(0, (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / (rxSq * y1pSq + rySq * x1pSq));
    sq = Math.sqrt(sq);
    if (largeArc === sweep) sq = -sq;

    const cxp = sq * rx * y1p / ry;
    const cyp = -sq * ry * x1p / rx;

    const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
    const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

    const angle = (ux: number, uy: number, vx: number, vy: number) => {
        const dot = ux * vx + uy * vy;
        const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
        let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
        if (ux * vy - uy * vx < 0) a = -a;
        return a;
    };

    const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);

    if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
    if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

    const numSegs = Math.ceil(Math.abs(dTheta) / (Math.PI / 2));
    const segAngle = dTheta / numSegs;

    for (let i = 0; i < numSegs; i++) {
        const t1 = theta1 + i * segAngle;
        const t2 = theta1 + (i + 1) * segAngle;
        const alpha = 4 / 3 * Math.tan(segAngle / 4);

        const cos1 = Math.cos(t1), sin1 = Math.sin(t1);
        const cos2 = Math.cos(t2), sin2 = Math.sin(t2);

        const p1x = rx * cos1, p1y = ry * sin1;
        const p2x = rx * cos2, p2y = ry * sin2;

        const cp1x = p1x - alpha * rx * sin1;
        const cp1y = p1y + alpha * ry * cos1;
        const cp2x = p2x + alpha * rx * sin2;
        const cp2y = p2y - alpha * ry * cos2;

        result.push({
            c1x: cosPhi * cp1x - sinPhi * cp1y + cx,
            c1y: sinPhi * cp1x + cosPhi * cp1y + cy,
            c2x: cosPhi * cp2x - sinPhi * cp2y + cx,
            c2y: sinPhi * cp2x + cosPhi * cp2y + cy,
            ex: cosPhi * p2x - sinPhi * p2y + cx,
            ey: sinPhi * p2x + cosPhi * p2y + cy,
        });
    }

    return result;
}

/** A single point in a parsed SVG path. */
export interface SVGPathPoint {
    x: number; y: number;
    cp1: number[]; cp2: number[];
}

/** A subpath: an array of points plus whether it was closed with Z. */
export interface SVGSubpath {
    points: SVGPathPoint[];
    closed: boolean;
}

/** Parse an SVG path `d` attribute into subpath arrays. */
export function parseSVGPathD(
    d: string, tx: number, ty: number
): SVGSubpath[] {
    const result: SVGSubpath[] = [];
    let currentSubpathPts: SVGPathPoint[] = [];
    let currentClosed = false;

    const segments = d.match(/[MmLlCcSsQqTtHhVvAaZz][^MmLlCcSsQqTtHhVvAaZz]*/g) || [];
    let cx = 0, cy = 0;
    let startX = 0, startY = 0;
    let lastCmd = '';
    let lastCp2x = 0, lastCp2y = 0;
    let lastQx = 0, lastQy = 0;

    for (const seg of segments) {
        const cmd = seg[0];
        const nums = tokenizeSVGNumbers(seg.slice(1));

        switch (cmd) {
            case 'M': {
                if (currentSubpathPts.length > 0) {
                    result.push({ points: currentSubpathPts, closed: currentClosed });
                    currentSubpathPts = [];
                    currentClosed = false;
                }
                for (let i = 0; i < nums.length - 1; i += 2) {
                    cx = nums[i] + tx; cy = nums[i + 1] + ty;
                    if (i === 0) { startX = cx; startY = cy; }
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'm': {
                if (currentSubpathPts.length > 0) {
                    result.push({ points: currentSubpathPts, closed: currentClosed });
                    currentSubpathPts = [];
                    currentClosed = false;
                }
                for (let i = 0; i < nums.length - 1; i += 2) {
                    cx += nums[i]; cy += nums[i + 1];
                    if (i === 0) { startX = cx; startY = cy; }
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'L': {
                for (let i = 0; i < nums.length - 1; i += 2) {
                    cx = nums[i] + tx; cy = nums[i + 1] + ty;
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'l': {
                for (let i = 0; i < nums.length - 1; i += 2) {
                    cx += nums[i]; cy += nums[i + 1];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'H': {
                for (let i = 0; i < nums.length; i++) {
                    cx = nums[i] + tx;
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'h': {
                for (let i = 0; i < nums.length; i++) {
                    cx += nums[i];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'V': {
                for (let i = 0; i < nums.length; i++) {
                    cy = nums[i] + ty;
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'v': {
                for (let i = 0; i < nums.length; i++) {
                    cy += nums[i];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'C': {
                for (let i = 0; i < nums.length - 5; i += 6) {
                    const c1x = nums[i] + tx, c1y = nums[i + 1] + ty;
                    const c2x = nums[i + 2] + tx, c2y = nums[i + 3] + ty;
                    cx = nums[i + 4] + tx; cy = nums[i + 5] + ty;
                    if (currentSubpathPts.length > 0) currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastCp2x = c2x; lastCp2y = c2y;
                }
                break;
            }
            case 'c': {
                for (let i = 0; i < nums.length - 5; i += 6) {
                    const c1x = cx + nums[i], c1y = cy + nums[i + 1];
                    const c2x = cx + nums[i + 2], c2y = cy + nums[i + 3];
                    cx += nums[i + 4]; cy += nums[i + 5];
                    if (currentSubpathPts.length > 0) currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastCp2x = c2x; lastCp2y = c2y;
                }
                break;
            }
            case 'S': {
                for (let i = 0; i < nums.length - 3; i += 4) {
                    let c1x: number, c1y: number;
                    if ('CcSs'.includes(lastCmd)) {
                        c1x = 2 * cx - lastCp2x; c1y = 2 * cy - lastCp2y;
                    } else {
                        c1x = cx; c1y = cy;
                    }
                    const c2x = nums[i] + tx, c2y = nums[i + 1] + ty;
                    cx = nums[i + 2] + tx; cy = nums[i + 3] + ty;
                    if (currentSubpathPts.length > 0) currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastCp2x = c2x; lastCp2y = c2y;
                }
                break;
            }
            case 's': {
                for (let i = 0; i < nums.length - 3; i += 4) {
                    let c1x: number, c1y: number;
                    if ('CcSs'.includes(lastCmd)) {
                        c1x = 2 * cx - lastCp2x; c1y = 2 * cy - lastCp2y;
                    } else {
                        c1x = cx; c1y = cy;
                    }
                    const c2x = cx + nums[i], c2y = cy + nums[i + 1];
                    cx += nums[i + 2]; cy += nums[i + 3];
                    if (currentSubpathPts.length > 0) currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastCp2x = c2x; lastCp2y = c2y;
                }
                break;
            }
            case 'Q': {
                for (let i = 0; i < nums.length - 3; i += 4) {
                    const qx = nums[i] + tx, qy = nums[i + 1] + ty;
                    const ex = nums[i + 2] + tx, ey = nums[i + 3] + ty;
                    const c1x = cx + 2 / 3 * (qx - cx);
                    const c1y = cy + 2 / 3 * (qy - cy);
                    const c2x = ex + 2 / 3 * (qx - ex);
                    const c2y = ey + 2 / 3 * (qy - ey);
                    cx = ex; cy = ey;
                    if (currentSubpathPts.length > 0) currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastQx = qx; lastQy = qy;
                }
                break;
            }
            case 'q': {
                for (let i = 0; i < nums.length - 3; i += 4) {
                    const qx = cx + nums[i], qy = cy + nums[i + 1];
                    const ex = cx + nums[i + 2], ey = cy + nums[i + 3];
                    const c1x = cx + 2 / 3 * (qx - cx);
                    const c1y = cy + 2 / 3 * (qy - cy);
                    const c2x = ex + 2 / 3 * (qx - ex);
                    const c2y = ey + 2 / 3 * (qy - ey);
                    cx = ex; cy = ey;
                    if (currentSubpathPts.length > 0) currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastQx = qx; lastQy = qy;
                }
                break;
            }
            case 'T': {
                for (let i = 0; i < nums.length - 1; i += 2) {
                    let qx: number, qy: number;
                    if ('QqTt'.includes(lastCmd)) {
                        qx = 2 * cx - lastQx; qy = 2 * cy - lastQy;
                    } else {
                        qx = cx; qy = cy;
                    }
                    const ex = nums[i] + tx, ey = nums[i + 1] + ty;
                    const c1x = cx + 2 / 3 * (qx - cx);
                    const c1y = cy + 2 / 3 * (qy - cy);
                    const c2x = ex + 2 / 3 * (qx - ex);
                    const c2y = ey + 2 / 3 * (qy - ey);
                    cx = ex; cy = ey;
                    if (currentSubpathPts.length > 0) currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastQx = qx; lastQy = qy;
                }
                break;
            }
            case 't': {
                for (let i = 0; i < nums.length - 1; i += 2) {
                    let qx: number, qy: number;
                    if ('QqTt'.includes(lastCmd)) {
                        qx = 2 * cx - lastQx; qy = 2 * cy - lastQy;
                    } else {
                        qx = cx; qy = cy;
                    }
                    const ex = cx + nums[i], ey = cy + nums[i + 1];
                    const c1x = cx + 2 / 3 * (qx - cx);
                    const c1y = cy + 2 / 3 * (qy - cy);
                    const c2x = ex + 2 / 3 * (qx - ex);
                    const c2y = ey + 2 / 3 * (qy - ey);
                    cx = ex; cy = ey;
                    if (currentSubpathPts.length > 0) currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastQx = qx; lastQy = qy;
                }
                break;
            }
            case 'A': case 'a': {
                const isRelative = cmd === 'a';
                for (let i = 0; i < nums.length - 6; i += 7) {
                    const arcRx = Math.abs(nums[i]);
                    const arcRy = Math.abs(nums[i + 1]);
                    const xAxisRotation = nums[i + 2] * Math.PI / 180;
                    const largeArcFlag = nums[i + 3] !== 0;
                    const sweepFlag = nums[i + 4] !== 0;
                    let ex = nums[i + 5], ey = nums[i + 6];
                    if (!isRelative) { ex += tx; ey += ty; }
                    else { ex += cx; ey += cy; }

                    const arcPts = arcToCubicBeziers(cx, cy, arcRx, arcRy, xAxisRotation, largeArcFlag, sweepFlag, ex, ey);
                    for (const arcSeg of arcPts) {
                        if (currentSubpathPts.length > 0) currentSubpathPts[currentSubpathPts.length - 1].cp2 = [arcSeg.c1x, arcSeg.c1y];
                        currentSubpathPts.push({ x: arcSeg.ex, y: arcSeg.ey, cp1: [arcSeg.c2x, arcSeg.c2y], cp2: [arcSeg.ex, arcSeg.ey] });
                    }
                    cx = ex; cy = ey;
                }
                break;
            }
            case 'Z': case 'z': {
                currentClosed = true;
                cx = startX; cy = startY;
                if (currentSubpathPts.length > 0) {
                    result.push({ points: currentSubpathPts, closed: true });
                }
                currentSubpathPts = [];
                currentClosed = false;
                break;
            }
        }
        lastCmd = cmd;
    }
    if (currentSubpathPts.length > 0) {
        result.push({ points: currentSubpathPts, closed: currentClosed });
    }
    return result;
}

// ─── Matrix & Transform Utilities ──────────────────────────────────────────

/** Identity matrix as column-major [f32; 9]. */
export function identityMatrix(): number[] {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/**
 * Multiply two 3×3 matrices (column-major storage).
 * Column-major: index = col * 3 + row.
 * Result = A * B.
 */
export function composeMatrices(a: number[], b: number[]): number[] {
    // a[col*3+row], b[col*3+row]
    return [
        a[0]*b[0] + a[3]*b[1] + a[6]*b[2],
        a[1]*b[0] + a[4]*b[1] + a[7]*b[2],
        a[2]*b[0] + a[5]*b[1] + a[8]*b[2],

        a[0]*b[3] + a[3]*b[4] + a[6]*b[5],
        a[1]*b[3] + a[4]*b[4] + a[7]*b[5],
        a[2]*b[3] + a[5]*b[4] + a[8]*b[5],

        a[0]*b[6] + a[3]*b[7] + a[6]*b[8],
        a[1]*b[6] + a[4]*b[7] + a[7]*b[8],
        a[2]*b[6] + a[5]*b[7] + a[8]*b[8],
    ];
}

/**
 * Transform a 2D point [x, y] by a column-major 3×3 matrix.
 * Returns [x', y'].
 */
export function transformPoint(m: number[], x: number, y: number): [number, number] {
    return [
        m[0] * x + m[3] * y + m[6],
        m[1] * x + m[4] * y + m[7],
    ];
}

/**
 * Build a column-major 3×3 translation matrix.
 */
function translateMatrix(tx: number, ty: number): number[] {
    return [1, 0, 0, 0, 1, 0, tx, ty, 1];
}

/**
 * Build a column-major 3×3 scale matrix.
 */
function scaleMatrix(sx: number, sy: number): number[] {
    return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
}

/**
 * Build a column-major 3×3 rotation matrix (angle in radians).
 */
function rotationMatrix(angle: number): number[] {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/**
 * Build a column-major 3×3 skewX matrix (angle in radians).
 */
function skewXMatrix(angle: number): number[] {
    return [1, 0, 0, Math.tan(angle), 1, 0, 0, 0, 1];
}

/**
 * Build a column-major 3×3 skewY matrix (angle in radians).
 */
function skewYMatrix(angle: number): number[] {
    return [1, Math.tan(angle), 0, 0, 1, 0, 0, 0, 1];
}

/**
 * Parse a full SVG `transform` attribute into a composed column-major 3×3 matrix.
 * Handles: translate, scale, rotate, matrix, skewX, skewY.
 * Multiple transforms are composed left-to-right (SVG spec: leftmost applied last).
 */
export function parseSVGTransform(attr: string): number[] {
    let result = identityMatrix();

    // Match each transform function in order
    const regex = /(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]+)\)/gi;
    let match;
    while ((match = regex.exec(attr)) !== null) {
        const fn = match[1].toLowerCase();
        const nums = tokenizeSVGNumbers(match[2]);
        let m: number[];

        switch (fn) {
            case 'translate': {
                const tx = nums[0] || 0;
                const ty = nums[1] || 0;
                m = translateMatrix(tx, ty);
                break;
            }
            case 'scale': {
                const sx = nums[0] || 1;
                const sy = nums.length >= 2 ? nums[1] : sx;
                m = scaleMatrix(sx, sy);
                break;
            }
            case 'rotate': {
                const angle = (nums[0] || 0) * Math.PI / 180;
                if (nums.length >= 3) {
                    // rotate(angle, cx, cy) = translate(cx,cy) * rotate(angle) * translate(-cx,-cy)
                    const cx = nums[1], cy = nums[2];
                    m = composeMatrices(
                        translateMatrix(cx, cy),
                        composeMatrices(rotationMatrix(angle), translateMatrix(-cx, -cy))
                    );
                } else {
                    m = rotationMatrix(angle);
                }
                break;
            }
            case 'matrix': {
                if (nums.length >= 6) {
                    // SVG matrix(a,b,c,d,e,f) maps to column-major:
                    // col0=[a,b,0], col1=[c,d,0], col2=[e,f,1]
                    m = [nums[0], nums[1], 0, nums[2], nums[3], 0, nums[4], nums[5], 1];
                } else {
                    m = identityMatrix();
                }
                break;
            }
            case 'skewx': {
                m = skewXMatrix((nums[0] || 0) * Math.PI / 180);
                break;
            }
            case 'skewy': {
                m = skewYMatrix((nums[0] || 0) * Math.PI / 180);
                break;
            }
            default:
                m = identityMatrix();
        }

        // SVG spec: transforms compose left-to-right
        result = composeMatrices(result, m);
    }

    return result;
}

/**
 * Convert a column-major [f32; 9] local transform to SVG matrix() attribute value.
 * Column-major: [a, b, _, c, d, _, tx, ty, _]
 * SVG matrix:   matrix(a, b, c, d, tx, ty)
 */
export function matrixToSVGTransform(m: number[]): string {
    return `matrix(${m[0]},${m[1]},${m[3]},${m[4]},${m[6]},${m[7]})`;
}

// ─── XML / Attribute Escaping ──────────────────────────────────────────────

/** Escape special XML characters for safe use in attributes and text content. */
export function escapeXml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ─── Gradient Resolution ───────────────────────────────────────────────────

/**
 * Resolve a `fill="url(#id)"` reference to the first stop color of the
 * referenced gradient element. Returns a hex color string or null.
 *
 * TODO: Real gradient support — this only approximates with the first stop color.
 */
export function resolveGradientColor(svgDoc: Document, fillUrl: string): string | null {
    const idMatch = fillUrl.match(/url\(\s*#([^)]+)\s*\)/);
    if (!idMatch) return null;

    const el = svgDoc.getElementById(idMatch[1]);
    if (!el) return null;

    const tag = el.tagName.toLowerCase();
    if (tag !== 'lineargradient' && tag !== 'radialgradient') return null;

    // Find first <stop> child
    const stop = el.querySelector('stop');
    if (!stop) return null;

    // Get stop-color from attribute or style
    let color = stop.getAttribute('stop-color');
    if (!color) {
        const styleAttr = stop.getAttribute('style');
        if (styleAttr) {
            const match = styleAttr.match(/stop-color\s*:\s*([^;]+)/);
            if (match) color = match[1].trim();
        }
    }

    if (!color) return null;

    // If it's already hex, return as-is
    if (color.startsWith('#')) return color;

    // Try rgb()
    const rgbMatch = color.match(/rgb\s*\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)\s*\)/);
    if (rgbMatch) {
        const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
        const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
        const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
    }

    // Named colors (basic subset)
    const namedColors: Record<string, string> = {
        black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
        blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
        gray: '#808080', grey: '#808080',
    };
    return namedColors[color.toLowerCase()] || color;
}
