/**
 * Pure SVG export module.
 * Converts scene data to an SVG document string without requiring WasmScene or UIEngine.
 * This separation enables testing without WASM and reuse in other contexts.
 */
import type { SceneNode, NodeStyle, Paint } from './types';
import { isGradient } from './types';
import { rgbToHex, escapeXml, matrixToSVGTransform } from './svg_utils';

// ─── Lookup Tables ──────────────────────────────────────────────────────────

const CAP_MAP = ['butt', 'round', 'square'] as const;
const JOIN_MAP = ['miter', 'round', 'bevel'] as const;
const FILL_RULE_MAP = ['nonzero', 'evenodd'] as const;

export const BLEND_MODE_MAP = [
    'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
    'color-dodge', 'color-burn', 'hard-light', 'soft-light',
    'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
] as const;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Filled face data from the engine's vector network. */
export interface FilledFace {
    id: number;
    boundary: [number, number][];
    fill: { r: number; g: number; b: number; a: number };
}

/** Input data for the pure SVG export function. */
export interface SVGExportInput {
    /** Document width in pixels. */
    docWidth: number;
    /** Document height in pixels. */
    docHeight: number;
    /** All scene nodes, keyed by ID. */
    nodes: Record<number, SceneNode>;
    /** Ordered root node IDs. */
    rootNodeIds: number[];
    /**
     * Local transform per node ID as column-major [f32; 9].
     * If missing for a node, identity is assumed.
     */
    localTransforms: Record<number, number[]>;
    /** Optional filled faces from the vector network. */
    filledFaces?: FilledFace[];
    /** Optional data-URI per image id (for exporting Image nodes as <image>). */
    imageDataUris?: Record<number, string>;
}

// ─── SVG Generation ─────────────────────────────────────────────────────────

/**
 * Build a complete SVG document string from scene data.
 * Gradient defs are collected during rendering and prepended into a <defs> block.
 */
export function buildSVGFromData(input: SVGExportInput): string {
    const { docWidth, docHeight, nodes, rootNodeIds, localTransforms, filledFaces, imageDataUris } = input;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${docWidth}" height="${docHeight}" viewBox="0 0 ${docWidth} ${docHeight}">`;

    // Collect gradient <defs> during rendering
    const gradientDefs: string[] = [];
    let gradientIdCounter = 0;

    // Collect <mask> defs (Figma-style is_mask children → SVG alpha masks)
    const maskDefs: string[] = [];
    let maskIdCounter = 0;

    // Collect <filter> defs (blur / drop-shadow effects)
    const filterDefs: string[] = [];
    let filterIdCounter = 0;

    /** Build a <filter> def for a node's effects, returning its id (or null). */
    const buildFilterDef = (effects: NonNullable<NodeStyle['effects']>): string | null => {
        if (!effects || effects.length === 0) return null;
        const prims = effects.map(eff => {
            if ('Blur' in eff) {
                return `<feGaussianBlur stdDeviation="${eff.Blur.radius}" />`;
            }
            const d = eff.DropShadow;
            const flood = `#${[d.color.r, d.color.g, d.color.b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
            return `<feDropShadow dx="${d.dx}" dy="${d.dy}" stdDeviation="${d.blur}" flood-color="${flood}" flood-opacity="${d.color.a}" />`;
        }).join('');
        const id = `filter${filterIdCounter++}`;
        // Generous region so shadows/blur aren't clipped.
        filterDefs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">${prims}</filter>`);
        return id;
    };

    /** Convert a Paint to an SVG fill/stroke value. For gradients, adds a def and returns url(#id). */
    const paintToSvgValue = (paint: Paint | null): string => {
        if (!paint) return 'none';
        if (!isGradient(paint)) {
            return escapeXml(rgbToHex(paint));
        }
        // Gradient — create a <defs> entry
        const gradId = `grad${gradientIdCounter++}`;
        const toHex = (c: { r: number; g: number; b: number; a: number }) => {
            const r = Math.round(c.r * 255).toString(16).padStart(2, '0');
            const g = Math.round(c.g * 255).toString(16).padStart(2, '0');
            const b = Math.round(c.b * 255).toString(16).padStart(2, '0');
            return `#${r}${g}${b}`;
        };
        const stops = paint.stops.map(s =>
            `<stop offset="${s.offset}" stop-color="${toHex(s.color)}" stop-opacity="${s.color.a}" />`
        ).join('');

        if (paint.gradient_type === 'Linear') {
            gradientDefs.push(
                `<linearGradient id="${gradId}" x1="${paint.start_x}" y1="${paint.start_y}" ` +
                `x2="${paint.end_x}" y2="${paint.end_y}" gradientUnits="userSpaceOnUse">` +
                `${stops}</linearGradient>`
            );
        } else {
            const radius = Math.hypot(paint.end_x - paint.start_x, paint.end_y - paint.start_y);
            gradientDefs.push(
                `<radialGradient id="${gradId}" cx="${paint.start_x}" cy="${paint.start_y}" ` +
                `r="${radius}" gradientUnits="userSpaceOnUse">` +
                `${stops}</radialGradient>`
            );
        }
        return `url(#${gradId})`;
    };

    /** Build SVG style attributes string for a shape node.
     *  Reads from the canonical `fills[]` / `strokes[]` arrays, with
     *  fallback to legacy scalar fields for older documents. */
    const buildStyleAttrs = (style: NodeStyle): string => {
        // Resolve canonical fill/stroke from arrays, falling back to legacy fields
        const fills = style.fills && style.fills.length > 0 ? style.fills : (style.fill ? [style.fill] : []);
        const strokeEntries = style.strokes && style.strokes.length > 0 ? style.strokes : (style.stroke ? [{
            paint: style.stroke, width: style.stroke_width ?? 0,
            cap: style.stroke_cap ?? 0, join: style.stroke_join ?? 0,
            dash_array: style.dash_array ?? [], dash_offset: style.dash_offset ?? 0,
            miter_limit: style.miter_limit ?? 4
        }] : []);

        const fillPaint = fills.length > 0 ? fills[0] : null;
        const sk = strokeEntries.length > 0 ? strokeEntries[0] : null;

        const fill = paintToSvgValue(fillPaint);
        const stroke = paintToSvgValue(sk?.paint ?? null);
        const sw = sk?.width ?? 0;
        const op = style.opacity ?? 1.0;

        let attrs = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"`;
        attrs += ` stroke-linecap="${CAP_MAP[sk?.cap ?? 0]}"`;
        attrs += ` stroke-linejoin="${JOIN_MAP[sk?.join ?? 0]}"`;

        // Dash array and offset
        if (sk?.dash_array && sk.dash_array.length > 0) {
            attrs += ` stroke-dasharray="${sk.dash_array.join(',')}"`;
            if (sk.dash_offset) attrs += ` stroke-dashoffset="${sk.dash_offset}"`;
        }

        // Miter limit
        if (sk?.miter_limit !== undefined && sk.miter_limit !== 4) {
            attrs += ` stroke-miterlimit="${sk.miter_limit}"`;
        }

        // Fill rule
        const fillRuleIdx = style.fill_rule || 0;
        if (fillRuleIdx > 0) {
            attrs += ` fill-rule="${FILL_RULE_MAP[fillRuleIdx]}"`;
        }

        // Blend mode (on shapes, emitted as inline style)
        const bm = BLEND_MODE_MAP[style.blend_mode || 0];
        if (bm && bm !== 'normal') {
            attrs += ` style="mix-blend-mode:${bm}"`;
        }

        // Fill opacity — extract from fill paint alpha (solid fills only;
        // gradient stops carry their own stop-opacity).
        if (fillPaint && !isGradient(fillPaint) && fillPaint.a < 1) {
            attrs += ` fill-opacity="${fillPaint.a}"`;
        }

        // Stroke opacity — extract from stroke paint alpha
        if (sk?.paint && !isGradient(sk.paint) && sk.paint.a < 1) {
            attrs += ` stroke-opacity="${sk.paint.a}"`;
        }

        return attrs;
    };

    /** Recursively render a node and its children to SVG elements. */
    const renderNodeToSVG = (id: number): string => {
        const node = nodes[id];
        if (!node) return '';

        // Use local (column-major) transform, falling back to identity
        const localTransform = localTransforms[id] || [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const matrix = matrixToSVGTransform(localTransform);

        // Build <g> attributes: transform + visibility
        let gAttrs = `transform="${matrix}"`;
        if (!node.visible) gAttrs += ' display="none"';

        // Effects → a <filter> referenced on the node's group wrapper.
        const filterId = buildFilterDef(node.style?.effects ?? []);
        if (filterId) gAttrs += ` filter="url(#${filterId})"`;

        let nodeSvg = `<g ${gAttrs}>`;

        if (node.node_type === 'Group') {
            // Group-level opacity
            const groupOp = node.style.opacity ?? 1.0;
            if (groupOp < 1) nodeSvg = `<g ${gAttrs} opacity="${groupOp}">`;

            // Group-level blend mode
            const gbm = BLEND_MODE_MAP[node.style.blend_mode || 0];
            if (gbm && gbm !== 'normal') {
                // Re-build opening tag with style
                const styleAttr = `mix-blend-mode:${gbm}`;
                if (groupOp < 1) {
                    nodeSvg = `<g ${gAttrs} opacity="${groupOp}" style="${styleAttr}">`;
                } else {
                    nodeSvg = `<g ${gAttrs} style="${styleAttr}">`;
                }
            }

            // Render children, bracketing any mask spans. A visible child with
            // is_mask=true masks the siblings above it (up to the next mask or
            // the end of the group) — exported as a <mask> def + a <g mask=...>
            // wrapper. mask-type="alpha" matches our alpha-mask semantics.
            const children = node.children || [];
            let ci = 0;
            while (ci < children.length) {
                const childId = children[ci];
                const child = nodes[childId];
                const isMaskChild = !!(child && child.is_mask && child.visible);
                let hasContentAbove = false;
                if (isMaskChild) {
                    for (let j = ci + 1; j < children.length; j++) {
                        const c = nodes[children[j]];
                        if (c && c.visible && !c.is_mask) { hasContentAbove = true; break; }
                    }
                }
                if (isMaskChild && hasContentAbove) {
                    const maskId = `mask${maskIdCounter++}`;
                    maskDefs.push(
                        `<mask id="${maskId}" mask-type="alpha" style="mask-type:alpha">` +
                        `${renderNodeToSVG(childId)}</mask>`);
                    // Gather content siblings up to the next mask.
                    let contentSvg = '';
                    let j = ci + 1;
                    for (; j < children.length; j++) {
                        const c = nodes[children[j]];
                        if (c && c.is_mask && c.visible) break;
                        contentSvg += renderNodeToSVG(children[j]);
                    }
                    nodeSvg += `<g mask="url(#${maskId})">${contentSvg}</g>`;
                    ci = j;
                } else {
                    nodeSvg += renderNodeToSVG(childId);
                    ci++;
                }
            }
        } else {
            const attrs = buildStyleAttrs(node.style);
            const geo = node.geometry;
            if (geo.Rect) {
                const cr = node.style.corner_radius;
                const rxAttr = cr ? ` rx="${cr}" ry="${cr}"` : '';
                nodeSvg += `<rect x="0" y="0" width="${geo.Rect.width}" height="${geo.Rect.height}"${rxAttr} ${attrs} />`;
            } else if (geo.Image) {
                const href = imageDataUris?.[geo.Image.image_id] ?? '';
                const op = node.style.opacity ?? 1.0;
                const opAttr = op < 1 ? ` opacity="${op}"` : '';
                nodeSvg += `<image x="0" y="0" width="${geo.Image.width}" height="${geo.Image.height}" href="${href}"${opAttr} preserveAspectRatio="none" />`;
            } else if (geo.Ellipse) {
                nodeSvg += `<ellipse cx="0" cy="0" rx="${geo.Ellipse.radius_x}" ry="${geo.Ellipse.radius_y}" ${attrs} />`;
            } else if (geo.Path) {
                let d = '';
                for (const sp of geo.Path.subpaths) {
                    if (sp.points.length < 2) continue;
                    d += `M ${sp.points[0].x} ${sp.points[0].y} `;
                    for (let i = 1; i < sp.points.length; i++) {
                        const prev = sp.points[i - 1];
                        const p = sp.points[i];
                        d += `C ${prev.cp2[0]} ${prev.cp2[1]} ${p.cp1[0]} ${p.cp1[1]} ${p.x} ${p.y} `;
                    }
                    if (sp.closed) d += 'Z ';
                }
                nodeSvg += `<path d="${d.trim()}" ${attrs} />`;
            } else if (geo.Text) {
                const textAnchorMap = ['start', 'middle', 'end'];
                const fontFamily = geo.Text.font_family ? ` font-family="${escapeXml(geo.Text.font_family)}"` : '';
                const textAnchor = geo.Text.text_align ? ` text-anchor="${textAnchorMap[geo.Text.text_align] || 'start'}"` : '';
                const lineHeightAttr = geo.Text.line_height && geo.Text.line_height !== 1.2 ? ` line-height="${geo.Text.line_height}"` : '';
                const fw = geo.Text.font_weight ?? 400;
                const weightAttr = fw !== 400 ? ` font-weight="${fw}"` : '';
                const styleAttr = geo.Text.italic ? ` font-style="italic"` : '';
                const ls = geo.Text.letter_spacing ?? 0;
                const lsAttr = ls ? ` letter-spacing="${ls}"` : '';
                const content = geo.Text.content;
                const lines = content.split('\n');
                if (lines.length <= 1) {
                    nodeSvg += `<text x="0" y="0" font-size="${geo.Text.font_size}"${fontFamily}${textAnchor}${lineHeightAttr}${weightAttr}${styleAttr}${lsAttr} ${attrs}>${escapeXml(content)}</text>`;
                } else {
                    const lh = geo.Text.line_height || 1.2;
                    nodeSvg += `<text x="0" y="0" font-size="${geo.Text.font_size}"${fontFamily}${textAnchor}${lineHeightAttr}${weightAttr}${styleAttr}${lsAttr} ${attrs}>`;
                    for (let i = 0; i < lines.length; i++) {
                        const dy = i === 0 ? '0' : `${lh}em`;
                        nodeSvg += `<tspan x="0" dy="${dy}">${escapeXml(lines[i])}</tspan>`;
                    }
                    nodeSvg += '</text>';
                }
            }
        }
        nodeSvg += `</g>`;
        return nodeSvg;
    };

    for (const rootId of rootNodeIds) {
        svg += renderNodeToSVG(rootId);
    }

    // Append live-paint face fills after the scene tree
    if (filledFaces && filledFaces.length > 0) {
        for (const face of filledFaces) {
            const d = face.boundary.map((p: [number, number], i: number) =>
                (i === 0 ? 'M' : 'L') + ` ${p[0]} ${p[1]}`
            ).join(' ') + ' Z';
            const hex = rgbToHex(face.fill);
            svg += `<path d="${d}" fill="${hex}" fill-opacity="${face.fill.a}" stroke="none" data-face-id="${face.id}" />`;
        }
    }

    // Insert <defs> (gradients + masks + filters) if any were collected
    if (gradientDefs.length > 0 || maskDefs.length > 0 || filterDefs.length > 0) {
        const defsBlock = `<defs>${gradientDefs.join('')}${maskDefs.join('')}${filterDefs.join('')}</defs>`;
        // Insert after the opening <svg ...> tag
        const insertIdx = svg.indexOf('>') + 1;
        svg = svg.slice(0, insertIdx) + defsBlock + svg.slice(insertIdx);
    }

    svg += `</svg>`;
    return svg;
}
