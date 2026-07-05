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
}

// ─── SVG Generation ─────────────────────────────────────────────────────────

/**
 * Build a complete SVG document string from scene data.
 * Gradient defs are collected during rendering and prepended into a <defs> block.
 */
export function buildSVGFromData(input: SVGExportInput): string {
    const { docWidth, docHeight, nodes, rootNodeIds, localTransforms, filledFaces } = input;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${docWidth}" height="${docHeight}" viewBox="0 0 ${docWidth} ${docHeight}">`;

    // Collect gradient <defs> during rendering
    const gradientDefs: string[] = [];
    let gradientIdCounter = 0;

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

    /** Build SVG style attributes string for a shape node. */
    const buildStyleAttrs = (style: NodeStyle): string => {
        const fill = paintToSvgValue(style.fill);
        const stroke = paintToSvgValue(style.stroke);
        const sw = style.stroke_width;
        const op = style.opacity ?? 1.0;

        let attrs = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"`;
        attrs += ` stroke-linecap="${CAP_MAP[style.stroke_cap || 0]}"`;
        attrs += ` stroke-linejoin="${JOIN_MAP[style.stroke_join || 0]}"`;

        // Dash array and offset
        if (style.dash_array && style.dash_array.length > 0) {
            attrs += ` stroke-dasharray="${style.dash_array.join(',')}"`;
            if (style.dash_offset) attrs += ` stroke-dashoffset="${style.dash_offset}"`;
        }

        // Miter limit
        if (style.miter_limit !== undefined && style.miter_limit !== 4) {
            attrs += ` stroke-miterlimit="${style.miter_limit}"`;
        }

        // Fill opacity
        if (style.fill_opacity !== undefined && style.fill_opacity !== 1) {
            attrs += ` fill-opacity="${style.fill_opacity}"`;
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

        // Stroke opacity — extract from stroke color alpha
        if (style.stroke && !isGradient(style.stroke) && style.stroke.a < 1) {
            attrs += ` stroke-opacity="${style.stroke.a}"`;
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

            // Render children
            const children = node.children || [];
            for (const childId of children) {
                nodeSvg += renderNodeToSVG(childId);
            }
        } else {
            const attrs = buildStyleAttrs(node.style);
            const geo = node.geometry;
            if (geo.Rect) {
                const cr = node.style.corner_radius;
                const rxAttr = cr ? ` rx="${cr}" ry="${cr}"` : '';
                nodeSvg += `<rect x="0" y="0" width="${geo.Rect.width}" height="${geo.Rect.height}"${rxAttr} ${attrs} />`;
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
                const content = geo.Text.content;
                const lines = content.split('\n');
                if (lines.length <= 1) {
                    nodeSvg += `<text x="0" y="0" font-size="${geo.Text.font_size}"${fontFamily}${textAnchor}${lineHeightAttr} ${attrs}>${escapeXml(content)}</text>`;
                } else {
                    const lh = geo.Text.line_height || 1.2;
                    nodeSvg += `<text x="0" y="0" font-size="${geo.Text.font_size}"${fontFamily}${textAnchor}${lineHeightAttr} ${attrs}>`;
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

    // Insert gradient <defs> if any were collected during rendering
    if (gradientDefs.length > 0) {
        const defsBlock = `<defs>${gradientDefs.join('')}</defs>`;
        // Insert after the opening <svg ...> tag
        const insertIdx = svg.indexOf('>') + 1;
        svg = svg.slice(0, insertIdx) + defsBlock + svg.slice(insertIdx);
    }

    svg += `</svg>`;
    return svg;
}
