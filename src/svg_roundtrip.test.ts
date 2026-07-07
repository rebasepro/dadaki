/**
 * SVG Export + Round-Trip Test Suite
 *
 * Tests the pure SVG export (buildSVGFromData) and validates round-trip
 * fidelity by exporting scene data → parsing the SVG DOM → asserting
 * element/attribute equivalence.
 *
 * Does NOT require WASM — works entirely with the pure export module
 * and jsdom's DOMParser.
 */
import { describe, it, expect } from 'vitest';
import { buildSVGFromData, BLEND_MODE_MAP } from './svg_export';
import type { SVGExportInput, FilledFace } from './svg_export';
import type { SceneNode, NodeStyle } from './types';
import { StrokeAlignment } from './types';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a default NodeStyle with sane zero/default values. */
function defaultStyle(overrides: Partial<NodeStyle> = {}): NodeStyle {
    return {
        fill: { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
        stroke: null,
        stroke_width: 1,
        opacity: 1.0,
        stroke_cap: 0,
        stroke_join: 0,
        dash_array: [],
        dash_offset: 0,
        corner_radius: 0,
        blend_mode: 0,
        fill_rule: 0,
        miter_limit: 4,
        fill_opacity: 1.0,
        fills: [],
        strokes: [],
        ...overrides,
    };
}

/** Build a minimal SceneNode. */
function makeNode(overrides: Partial<SceneNode>): SceneNode {
    return {
        name: 'Node',
        node_type: 'Shape',
        geometry: {},
        style: defaultStyle(),
        visible: true,
        locked: false,
        transform: [1, 0, 0, 0, 1, 0, 0, 0, 1],

        ...overrides,
    };
}

/** Identity matrix (column-major [f32; 9]). */
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Parse an SVG string and return the document. */
function parseSVG(svgString: string): Document {
    const parser = new DOMParser();
    return parser.parseFromString(svgString, 'image/svg+xml');
}

/** Get the first element matching a tag inside the SVG. */
function queryTag(doc: Document, tag: string): Element | null {
    return doc.querySelector(tag);
}

/** Get all elements matching a tag. */
function queryAllTags(doc: Document, tag: string): NodeListOf<Element> {
    return doc.querySelectorAll(tag);
}

// ─── Export: Basic Shapes ───────────────────────────────────────────────────

describe('SVG Export — Basic Shapes', () => {
    it('exports a rect with correct dimensions', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 200, height: 100 } },
                    style: defaultStyle({ fill: { r: 1, g: 0, b: 0, a: 1 } }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const rect = queryTag(doc, 'rect');
        expect(rect).toBeTruthy();
        expect(rect!.getAttribute('width')).toBe('200');
        expect(rect!.getAttribute('height')).toBe('100');
        expect(rect!.getAttribute('fill')).toBe('#ff0000');
    });

    it('exports an ellipse', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Ellipse: { radius_x: 50, radius_y: 30 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const el = queryTag(doc, 'ellipse');
        expect(el).toBeTruthy();
        expect(el!.getAttribute('rx')).toBe('50');
        expect(el!.getAttribute('ry')).toBe('30');
    });

    it('exports a path with cubic beziers', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: {
                        Path: {
                            subpaths: [{
                                points: [
                                    { x: 0, y: 0, cp1: [0, 0], cp2: [50, 0] },
                                    { x: 100, y: 100, cp1: [50, 100], cp2: [100, 100] },
                                ],
                                closed: false,
                            }],
                        },
                    },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const path = queryTag(doc, 'path');
        expect(path).toBeTruthy();
        const d = path!.getAttribute('d')!;
        expect(d).toContain('M');
        expect(d).toContain('C');
    });

    it('exports text with escaped content', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Text: { content: 'Hello <World> & "Friends"', font_size: 24, font_family: 'sans-serif', text_align: 0, line_height: 1.2 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const text = queryTag(doc, 'text');
        expect(text).toBeTruthy();
        expect(text!.getAttribute('font-size')).toBe('24');
        // The text content should be properly escaped in the SVG string
        expect(svg).toContain('&amp;');
        expect(svg).toContain('&lt;World&gt;');
    });
});

// ─── Export: Masks ──────────────────────────────────────────────────────────

describe('SVG Export — Masks', () => {
    it('a group with an is_mask child exports a <mask> def and a masked <g>', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({ node_type: 'Group', children: [2, 3] }),
                // mask (bottom child) — an ellipse
                2: makeNode({ node_type: 'Shape', is_mask: true,
                    geometry: { Ellipse: { radius_x: 60, radius_y: 60 } } }),
                // content (above) — a red rect
                3: makeNode({ node_type: 'Shape',
                    geometry: { Rect: { width: 200, height: 200 } },
                    style: defaultStyle({ fill: { r: 1, g: 0, b: 0, a: 1 } }) }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY, 2: IDENTITY, 3: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const mask = queryTag(doc, 'mask');
        expect(mask, 'a <mask> def must be emitted').toBeTruthy();
        expect(mask!.getAttribute('mask-type')).toBe('alpha');
        // The mask def contains the ellipse (the mask shape).
        expect(mask!.querySelector('ellipse'), 'mask shape inside def').toBeTruthy();

        // The content is wrapped in a <g mask="url(#...)">.
        const maskId = mask!.getAttribute('id')!;
        const maskedG = Array.from(doc.querySelectorAll('g')).find(
            g => g.getAttribute('mask') === `url(#${maskId})`);
        expect(maskedG, 'content wrapped in a masked group').toBeTruthy();
        expect(maskedG!.querySelector('rect'), 'content rect inside masked group').toBeTruthy();
        // The mask shape must NOT also be painted as normal content.
        expect(maskedG!.querySelector('ellipse')).toBeFalsy();
    });

    it('a ROOT-level mask brackets the root siblings above it (no group required)', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                // roots: [mask (bottom), content (above)] — no wrapping group
                1: makeNode({ node_type: 'Shape', is_mask: true,
                    geometry: { Ellipse: { radius_x: 50, radius_y: 50 } } }),
                2: makeNode({ node_type: 'Shape',
                    geometry: { Rect: { width: 300, height: 300 } } }),
            },
            rootNodeIds: [1, 2],
            localTransforms: { 1: IDENTITY, 2: IDENTITY },
        };
        const doc = parseSVG(buildSVGFromData(input));
        const mask = queryTag(doc, 'mask');
        expect(mask, 'root-level mask must emit a <mask> def').toBeTruthy();
        const maskId = mask!.getAttribute('id')!;
        const maskedG = Array.from(doc.querySelectorAll('g')).find(
            g => g.getAttribute('mask') === `url(#${maskId})`);
        expect(maskedG, 'root content wrapped in a masked group').toBeTruthy();
        expect(maskedG!.querySelector('rect')).toBeTruthy();
    });

    it('a node with a drop-shadow effect exports a <filter> with feDropShadow', () => {
        const input: SVGExportInput = {
            docWidth: 400, docHeight: 400,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 100 } },
                    style: defaultStyle({
                        effects: [{ DropShadow: { dx: 5, dy: 6, blur: 4, color: { r: 0, g: 0, b: 0, a: 0.5 } } }],
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };
        const doc = parseSVG(buildSVGFromData(input));
        const filter = queryTag(doc, 'filter');
        expect(filter, 'a <filter> def is emitted').toBeTruthy();
        const shadow = doc.querySelector('feDropShadow');
        expect(shadow).toBeTruthy();
        expect(shadow!.getAttribute('dx')).toBe('5');
        expect(shadow!.getAttribute('stdDeviation')).toBe('4');
        // The node's group references the filter.
        const fid = filter!.getAttribute('id')!;
        const g = Array.from(doc.querySelectorAll('g')).find(x => x.getAttribute('filter') === `url(#${fid})`);
        expect(g, 'node group references the filter').toBeTruthy();
    });

    it('a node with a blur effect exports feGaussianBlur', () => {
        const input: SVGExportInput = {
            docWidth: 400, docHeight: 400,
            nodes: {
                1: makeNode({
                    geometry: { Ellipse: { radius_x: 40, radius_y: 40 } },
                    style: defaultStyle({ effects: [{ Blur: { radius: 7 } }] }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };
        const doc = parseSVG(buildSVGFromData(input));
        const blur = doc.querySelector('feGaussianBlur');
        expect(blur).toBeTruthy();
        expect(blur!.getAttribute('stdDeviation')).toBe('7');
    });

    it('a mask with no content above it renders normally (not wrapped)', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({ node_type: 'Group', children: [2, 3] }),
                2: makeNode({ node_type: 'Shape',
                    geometry: { Rect: { width: 100, height: 100 } } }),
                // mask is the TOP child → nothing above to mask
                3: makeNode({ node_type: 'Shape', is_mask: true,
                    geometry: { Ellipse: { radius_x: 40, radius_y: 40 } } }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY, 2: IDENTITY, 3: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        expect(queryTag(doc, 'mask'), 'no mask def when nothing to mask').toBeFalsy();
        // Both shapes are drawn plainly.
        expect(queryTag(doc, 'rect')).toBeTruthy();
        expect(queryTag(doc, 'ellipse')).toBeTruthy();
    });
});

// ─── Export: Corner Radius ──────────────────────────────────────────────────

describe('SVG Export — Corner Radius', () => {
    it('exports rx/ry on rect when corner_radius > 0', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 80 } },
                    style: defaultStyle({ corner_radius: 12 }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('rx')).toBe('12');
        expect(rect!.getAttribute('ry')).toBe('12');
    });

    it('omits rx/ry when corner_radius is 0', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 80 } },
                    style: defaultStyle({ corner_radius: 0 }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('rx')).toBeNull();
        expect(rect!.getAttribute('ry')).toBeNull();
    });
});

// ─── Export: Dash Patterns ──────────────────────────────────────────────────

describe('SVG Export — Dash Patterns', () => {
    it('exports stroke-dasharray and stroke-dashoffset', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({
                        stroke: { r: 0, g: 0, b: 0, a: 1 },
                        dash_array: [10, 5, 2, 5],
                        dash_offset: 3,
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('stroke-dasharray')).toBe('10,5,2,5');
        expect(rect!.getAttribute('stroke-dashoffset')).toBe('3');
    });

    it('omits dash attributes when dash_array is empty', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ dash_array: [] }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('stroke-dasharray')).toBeNull();
    });
});

// ─── Export: Stroke Properties ──────────────────────────────────────────────

describe('SVG Export — Stroke Properties', () => {
    it('exports stroke-linecap and stroke-linejoin', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({
                        stroke: { r: 0, g: 0, b: 0, a: 1 },
                        stroke_cap: 1, // round
                        stroke_join: 2, // bevel
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('stroke-linecap')).toBe('round');
        expect(rect!.getAttribute('stroke-linejoin')).toBe('bevel');
    });

    it('exports non-default miter limit', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ strokes: [{
                        paint: { r: 0, g: 0, b: 0, a: 1 },
                        width: 1, cap: 0, join: 0,
                        dash_array: [], dash_offset: 0,
                        miter_limit: 8, alignment: StrokeAlignment.Center,
                    }] }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('stroke-miterlimit')).toBe('8');
    });

    it('omits miter limit when it is the default (4)', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ miter_limit: 4 }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('stroke-miterlimit')).toBeNull();
    });
});

// ─── Export: Fill Rule and Opacity ───────────────────────────────────────────

describe('SVG Export — Fill Rule & Opacity', () => {
    it('exports fill-rule="evenodd" when set', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ fill_rule: 1 }), // evenodd
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('fill-rule')).toBe('evenodd');
    });

    it('omits fill-rule when nonzero (default)', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ fill_rule: 0 }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('fill-rule')).toBeNull();
    });

    it('exports fill-opacity when not 1', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ fills: [{ r: 0.5, g: 0.5, b: 0.5, a: 0.5 }] }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('fill-opacity')).toBe('0.5');
    });

    it('exports element opacity', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ opacity: 0.7 }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect');

        expect(rect!.getAttribute('opacity')).toBe('0.7');
    });
});

// ─── Export: Visibility ─────────────────────────────────────────────────────

describe('SVG Export — Visibility', () => {
    it('emits display="none" for invisible nodes', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    visible: false,
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const groups = queryAllTags(doc, 'g');
        // The wrapping <g> should have display="none"
        let found = false;
        for (const g of groups) {
            if (g.getAttribute('display') === 'none') {
                found = true;
                break;
            }
        }
        expect(found).toBe(true);
        // The rect should still be present (not skipped)
        expect(queryTag(doc, 'rect')).toBeTruthy();
    });

    it('visible nodes do not have display="none"', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    visible: true,
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        expect(svg).not.toContain('display="none"');
    });
});

// ─── Export: Blend Mode ─────────────────────────────────────────────────────

describe('SVG Export — Blend Mode', () => {
    it('exports mix-blend-mode for non-normal blend mode on shapes', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ blend_mode: 1 }), // multiply
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        expect(svg).toContain('mix-blend-mode:multiply');
    });

    it('omits mix-blend-mode for normal blend mode', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 50 } },
                    style: defaultStyle({ blend_mode: 0 }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        expect(svg).not.toContain('mix-blend-mode');
    });

    it('exports mix-blend-mode on group nodes', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    style: defaultStyle({ blend_mode: 2 }), // screen
                    children: [2],
                }),
                2: makeNode({
                    geometry: { Rect: { width: 50, height: 30 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY, 2: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        expect(svg).toContain('mix-blend-mode:screen');
    });

    it('BLEND_MODE_MAP covers all 16 modes', () => {
        expect(BLEND_MODE_MAP).toHaveLength(16);
        expect(BLEND_MODE_MAP[0]).toBe('normal');
        expect(BLEND_MODE_MAP[15]).toBe('luminosity');
    });
});

// ─── Export: Transforms ─────────────────────────────────────────────────────

describe('SVG Export — Transforms', () => {
    it('exports local transform as matrix()', () => {
        // Column-major: translate(100, 200) = [1,0,0, 0,1,0, 100,200,1]
        const translateMat = [1, 0, 0, 0, 1, 0, 100, 200, 1];
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 50, height: 50 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: translateMat },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const g = queryTag(doc, 'g');
        const transform = g!.getAttribute('transform')!;

        // matrixToSVGTransform([1,0,0, 0,1,0, 100,200,1]) → matrix(1,0,0,1,100,200)
        expect(transform).toContain('matrix(');
        expect(transform).toContain('100');
        expect(transform).toContain('200');
    });

    it('exports rotation transform correctly', () => {
        // 90° rotation column-major: [cos, sin, 0, -sin, cos, 0, 0, 0, 1]
        // cos(90°) ≈ 0, sin(90°) = 1
        const angle = Math.PI / 2;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const rotMat = [c, s, 0, -s, c, 0, 0, 0, 1];

        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 50, height: 50 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: rotMat },
        };

        const svg = buildSVGFromData(input);
        expect(svg).toContain('matrix(');
    });

    it('uses identity when no transform provided', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 50, height: 50 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: {},  // No transform provided
        };

        const svg = buildSVGFromData(input);
        // Should fall back to identity → matrix(1,0,0,1,0,0)
        expect(svg).toContain('matrix(1,0,0,1,0,0)');
    });
});

// ─── Export: Nested Groups ──────────────────────────────────────────────────

describe('SVG Export — Nested Groups', () => {
    it('exports groups with children nested correctly', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    children: [2, 3],
                }),
                2: makeNode({
                    geometry: { Rect: { width: 50, height: 50 } },
                }),
                3: makeNode({
                    geometry: { Ellipse: { radius_x: 25, radius_y: 25 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: {
                1: [1, 0, 0, 0, 1, 0, 10, 20, 1], // translate(10, 20)
                2: IDENTITY,
                3: IDENTITY,
            },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        // Should have a rect and ellipse
        expect(queryTag(doc, 'rect')).toBeTruthy();
        expect(queryTag(doc, 'ellipse')).toBeTruthy();
        // Should have multiple <g> elements (one for group, one each for children)
        const groups = queryAllTags(doc, 'g');
        expect(groups.length).toBeGreaterThanOrEqual(3);
    });

    it('exports group opacity', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    style: defaultStyle({ opacity: 0.5 }),
                    children: [2],
                }),
                2: makeNode({
                    geometry: { Rect: { width: 50, height: 50 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY, 2: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        // The outermost group <g> should have opacity="0.5"
        const groups = queryAllTags(doc, 'g');
        let foundGroupOpacity = false;
        for (const g of groups) {
            if (g.getAttribute('opacity') === '0.5') {
                foundGroupOpacity = true;
                break;
            }
        }
        expect(foundGroupOpacity).toBe(true);
    });

    it('nested groups with transforms produce hierarchical SVG', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    children: [2],
                }),
                2: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    children: [3],
                }),
                3: makeNode({
                    geometry: { Rect: { width: 20, height: 20 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: {
                1: [1, 0, 0, 0, 1, 0, 10, 0, 1],  // translate(10, 0)
                2: [1, 0, 0, 0, 1, 0, 0, 20, 1],   // translate(0, 20)
                3: IDENTITY,
            },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        // Should have a rect nested inside groups
        expect(queryTag(doc, 'rect')).toBeTruthy();
        const groups = queryAllTags(doc, 'g');
        // Group 1 > Group 2 > shape wrapper > rect = at least 3 <g>s
        expect(groups.length).toBeGreaterThanOrEqual(3);
    });
});

// ─── Export: Face Fills ─────────────────────────────────────────────────────

describe('SVG Export — Face Fills', () => {
    it('exports filled faces as path elements after scene content', () => {
        const faces: FilledFace[] = [{
            id: 42,
            boundary: [[0, 0], [100, 0], [100, 100], [0, 100]],
            fill: { r: 1, g: 0, b: 0, a: 0.8 },
        }];

        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 200, height: 200 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
            filledFaces: faces,
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        // Should have at least 2 paths (could be rect + face path)
        // The face path has data-face-id attribute
        const paths = queryAllTags(doc, 'path');
        let facePathFound = false;
        for (const p of paths) {
            if (p.getAttribute('data-face-id') === '42') {
                facePathFound = true;
                expect(p.getAttribute('fill')).toBe('#ff0000');
                expect(p.getAttribute('fill-opacity')).toBe('0.8');
                expect(p.getAttribute('stroke')).toBe('none');
            }
        }
        expect(facePathFound).toBe(true);
    });

    it('no face paths when filledFaces is undefined', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 200, height: 200 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        expect(svg).not.toContain('data-face-id');
    });
});

// ─── Export: SVG Document Structure ─────────────────────────────────────────

describe('SVG Export — Document Structure', () => {
    it('produces valid SVG with correct root attributes', () => {
        const input: SVGExportInput = {
            docWidth: 1920, docHeight: 1080,
            nodes: {},
            rootNodeIds: [],
            localTransforms: {},
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const svgEl = queryTag(doc, 'svg');

        expect(svgEl).toBeTruthy();
        expect(svgEl!.getAttribute('width')).toBe('1920');
        expect(svgEl!.getAttribute('height')).toBe('1080');
        expect(svgEl!.getAttribute('viewBox')).toBe('0 0 1920 1080');
        expect(svgEl!.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    });

    it('inserts gradient defs when gradients are used', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 100, height: 100 } },
                    style: defaultStyle({
                        fill: {
                            gradient_type: 'Linear',
                            stops: [
                                { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
                                { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
                            ],
                            start_x: 0, start_y: 0,
                            end_x: 100, end_y: 0,
                        },
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const defs = queryTag(doc, 'defs');
        expect(defs).toBeTruthy();
        const linearGrad = queryTag(doc, 'linearGradient');
        expect(linearGrad).toBeTruthy();
        expect(linearGrad!.getAttribute('gradientUnits')).toBe('userSpaceOnUse');

        // The rect should reference the gradient
        const rect = queryTag(doc, 'rect');
        expect(rect!.getAttribute('fill')).toMatch(/^url\(#grad\d+\)$/);
    });
});

// ─── Round-Trip: Export → Parse → Verify ────────────────────────────────────

describe('SVG Round-Trip — Export then Parse', () => {
    it('round-trips a rect with all style fields', () => {
        const style = defaultStyle({
            fill: { r: 0.2, g: 0.4, b: 0.8, a: 0.75 },
            stroke: { r: 1, g: 0, b: 0, a: 1.0 },
            stroke_width: 3,
            opacity: 0.9,
            stroke_cap: 1,
            stroke_join: 2,
            dash_array: [8, 4],
            dash_offset: 2,
            corner_radius: 10,
            fill_rule: 1,
            miter_limit: 8,
            blend_mode: 3, // overlay
        });

        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 150, height: 100 } },
                    style,
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: [1, 0, 0, 0, 1, 0, 50, 30, 1] },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect')!;

        // Geometry
        expect(rect.getAttribute('width')).toBe('150');
        expect(rect.getAttribute('height')).toBe('100');
        expect(rect.getAttribute('rx')).toBe('10');
        expect(rect.getAttribute('ry')).toBe('10');

        // Fill & stroke
        expect(rect.getAttribute('fill')).toBe('#3366cc');
        expect(rect.getAttribute('stroke')).toBe('#ff0000');
        expect(rect.getAttribute('stroke-width')).toBe('3');

        // Opacity
        expect(rect.getAttribute('opacity')).toBe('0.9');
        expect(rect.getAttribute('fill-opacity')).toBe('0.75');

        // Stroke properties
        expect(rect.getAttribute('stroke-linecap')).toBe('round');
        expect(rect.getAttribute('stroke-linejoin')).toBe('bevel');
        expect(rect.getAttribute('stroke-dasharray')).toBe('8,4');
        expect(rect.getAttribute('stroke-dashoffset')).toBe('2');
        expect(rect.getAttribute('stroke-miterlimit')).toBe('8');

        // Fill rule
        expect(rect.getAttribute('fill-rule')).toBe('evenodd');

        // Blend mode
        expect(rect.getAttribute('style')).toContain('mix-blend-mode:overlay');

        // Transform on parent <g>
        const g = rect.parentElement!;
        const transform = g.getAttribute('transform')!;
        expect(transform).toContain('50');
        expect(transform).toContain('30');
    });

    it('round-trips nested groups with transforms', () => {
        const input: SVGExportInput = {
            docWidth: 400, docHeight: 400,
            nodes: {
                1: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    children: [2, 3],
                }),
                2: makeNode({
                    geometry: { Rect: { width: 40, height: 40 } },
                }),
                3: makeNode({
                    node_type: 'Group',
                    geometry: {},
                    children: [4],
                }),
                4: makeNode({
                    geometry: { Ellipse: { radius_x: 20, radius_y: 15 } },
                }),
            },
            rootNodeIds: [1],
            localTransforms: {
                1: [1, 0, 0, 0, 1, 0, 100, 100, 1],
                2: [2, 0, 0, 0, 2, 0, 0, 0, 1],  // scale(2)
                3: [1, 0, 0, 0, 1, 0, 50, 0, 1],  // translate(50, 0)
                4: IDENTITY,
            },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        // Both shapes should exist
        expect(queryTag(doc, 'rect')).toBeTruthy();
        expect(queryTag(doc, 'ellipse')).toBeTruthy();

        // Count groups
        const groups = queryAllTags(doc, 'g');
        expect(groups.length).toBeGreaterThanOrEqual(4); // outer + child rect wrapper + inner group + ellipse wrapper
    });

    it('round-trips text node', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: { Text: { content: 'Héllo Wörld', font_size: 32, font_family: 'sans-serif', text_align: 0, line_height: 1.2 } },
                    style: defaultStyle({ fill: { r: 0, g: 0, b: 0, a: 1 } }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: [1, 0, 0, 0, 1, 0, 20, 50, 1] },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const text = queryTag(doc, 'text')!;

        expect(text.getAttribute('font-size')).toBe('32');
        expect(text.textContent).toBe('Héllo Wörld');
        expect(text.getAttribute('fill')).toBe('#000000');
    });

    it('round-trips dashes + rounded rects', () => {
        const input: SVGExportInput = {
            docWidth: 600, docHeight: 400,
            nodes: {
                1: makeNode({
                    geometry: { Rect: { width: 200, height: 120 } },
                    style: defaultStyle({
                        fill: { r: 0.9, g: 0.9, b: 0.9, a: 1 },
                        stroke: { r: 0.2, g: 0.2, b: 0.2, a: 1 },
                        stroke_width: 2,
                        corner_radius: 16,
                        dash_array: [12, 6],
                        dash_offset: 4,
                    }),
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const rect = queryTag(doc, 'rect')!;

        expect(rect.getAttribute('rx')).toBe('16');
        expect(rect.getAttribute('ry')).toBe('16');
        expect(rect.getAttribute('stroke-dasharray')).toBe('12,6');
        expect(rect.getAttribute('stroke-dashoffset')).toBe('4');
        expect(rect.getAttribute('stroke-width')).toBe('2');
    });

    it('round-trips path with closed subpath', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({
                    geometry: {
                        Path: {
                            subpaths: [{
                                points: [
                                    { x: 0, y: 0, cp1: [0, 0], cp2: [0, 0] },
                                    { x: 100, y: 0, cp1: [100, 0], cp2: [100, 0] },
                                    { x: 50, y: 87, cp1: [50, 87], cp2: [50, 87] },
                                ],
                                closed: true,
                            }],
                        },
                    },
                }),
            },
            rootNodeIds: [1],
            localTransforms: { 1: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);
        const path = queryTag(doc, 'path')!;
        const d = path.getAttribute('d')!;

        expect(d).toContain('M');
        expect(d).toContain('Z');
    });
});

// ─── Round-Trip: Multiple Shapes ────────────────────────────────────────────

describe('SVG Round-Trip — Scene with Multiple Shapes', () => {
    it('exports all root-level shapes in order', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({ geometry: { Rect: { width: 100, height: 50 } } }),
                2: makeNode({ geometry: { Ellipse: { radius_x: 40, radius_y: 40 } } }),
                3: makeNode({
                    geometry: {
                        Path: {
                            subpaths: [{
                                points: [
                                    { x: 0, y: 0, cp1: [0, 0], cp2: [0, 0] },
                                    { x: 50, y: 50, cp1: [50, 50], cp2: [50, 50] },
                                ],
                                closed: false,
                            }],
                        },
                    },
                }),
            },
            rootNodeIds: [1, 2, 3],
            localTransforms: { 1: IDENTITY, 2: IDENTITY, 3: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        expect(queryTag(doc, 'rect')).toBeTruthy();
        expect(queryTag(doc, 'ellipse')).toBeTruthy();
        expect(queryTag(doc, 'path')).toBeTruthy();

        // The SVG should have 3 top-level <g> elements under <svg>
        const svgEl = queryTag(doc, 'svg')!;
        const topLevelGs = svgEl.querySelectorAll(':scope > g');
        expect(topLevelGs.length).toBe(3);
    });

    it('mixes visible and invisible shapes', () => {
        const input: SVGExportInput = {
            docWidth: 800, docHeight: 600,
            nodes: {
                1: makeNode({ geometry: { Rect: { width: 100, height: 50 } }, visible: true }),
                2: makeNode({ geometry: { Rect: { width: 80, height: 40 } }, visible: false }),
            },
            rootNodeIds: [1, 2],
            localTransforms: { 1: IDENTITY, 2: IDENTITY },
        };

        const svg = buildSVGFromData(input);
        const doc = parseSVG(svg);

        const rects = queryAllTags(doc, 'rect');
        expect(rects.length).toBe(2); // Both should be present

        // One group should have display="none"
        const groups = queryAllTags(doc, 'g');
        let hiddenCount = 0;
        for (const g of groups) {
            if (g.getAttribute('display') === 'none') hiddenCount++;
        }
        expect(hiddenCount).toBe(1);
    });
});
