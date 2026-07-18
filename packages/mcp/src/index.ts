#!/usr/bin/env node
/**
 * Dadaki MCP server — lets an agent author vector artwork the way a designer
 * would: place shapes, style them, align and combine them, then LOOK at the
 * result and correct it.
 *
 * The tools are intent-level verbs, not mouse events. Pixel-driving the real
 * toolbar would be slow, brittle against UI changes, and agents are bad at
 * precise dragging. What carries over from "a human in front of the tool" is
 * the feedback loop, which `describe_scene` and `render_png` provide: every
 * mutating tool returns the affected node so the agent can immediately verify
 * placement without a round-trip.
 *
 * Usage (stdio):
 *   pnpm build            # produce packages/app/dist, which the server serves
 *   node --experimental-strip-types packages/mcp/src/index.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EditorSession } from './session.ts';

const session = new EditorSession({
    headful: process.env.DADAKI_MCP_HEADFUL === '1',
});

const server = new McpServer({ name: 'dadaki', version: '1.0.0' });

/** Colours are CSS hex — the format agents produce most reliably. */
const hex = z
    .string()
    .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'expected CSS hex, e.g. #ff0000');

const style = z
    .object({
        fill: hex.nullable().optional().describe('Fill colour, or null for no fill'),
        stroke: hex.nullable().optional().describe('Stroke colour, or null for no stroke'),
        strokeWidth: z.number().positive().optional(),
        opacity: z.number().min(0).max(1).optional(),
        cornerRadius: z.number().min(0).optional(),
    })
    .optional();

/** One id or several — every styling/arranging verb accepts both. */
const ids = z.union([z.number(), z.array(z.number())]);

const asText = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

/**
 * Register a tool whose result is JSON. Errors are returned as tool errors
 * (rather than thrown) so the agent can read the message and retry.
 */
function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: S,
    run: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
) {
    server.registerTool(name, { description, inputSchema: schema }, async (args) => {
        try {
            return asText(await run(args as z.objectOutputType<S, z.ZodTypeAny>));
        } catch (err) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: (err as Error).message }],
            };
        }
    });
}

/** Create a node, then report it back so the agent can verify placement. */
async function created(method: string, args: unknown[]) {
    const id = await session.call<number>(method, args);
    return { id, node: await session.call('describeNode', [id]) };
}

// ─── Seeing ─────────────────────────────────────────────────────────────

tool(
    'describe_scene',
    'List every object on the canvas with its id, type, world-space bounds [x,y,w,h], fill, stroke and opacity. Call this before editing so you know what ids to target, and after editing to confirm the result.',
    {},
    () => session.call('describe'),
);

tool(
    'render_png',
    'Render the canvas to a PNG image so you can SEE the artwork. Use this to check composition, spacing and colour after making changes — bounds alone will not tell you whether a drawing looks right.',
    {},
    async () => {
        const data = await session.screenshot();
        return { image: data };
    },
);

server.registerTool(
    'render_png_image',
    {
        description:
            'Render the canvas and return it as an inline image (preferred over render_png when your client can display images).',
        inputSchema: {},
    },
    async () => ({
        content: [
            { type: 'image' as const, data: await session.screenshot(), mimeType: 'image/png' },
        ],
    }),
);

tool(
    'export_svg',
    'Export the finished artwork as an SVG string. This is the deliverable — real vector output, not a raster approximation.',
    {},
    async () => ({ svg: await session.call<string>('toSVG') }),
);

// ─── Creating ───────────────────────────────────────────────────────────

tool(
    'create_rect',
    'Draw a rectangle. x,y is the top-left corner in world units; y grows downward.',
    {
        x: z.number(),
        y: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
        style,
    },
    (a) => created('createRect', [a.x, a.y, a.width, a.height, a.style]),
);

tool(
    'create_ellipse',
    'Draw an ellipse from its centre and radii. For a circle, pass equal rx and ry.',
    { cx: z.number(), cy: z.number(), rx: z.number().positive(), ry: z.number().positive(), style },
    (a) => created('createEllipse', [a.cx, a.cy, a.rx, a.ry, a.style]),
);

tool(
    'create_polygon',
    'Draw a regular polygon (triangle = 3 sides, hexagon = 6, …) from its centre.',
    {
        cx: z.number(),
        cy: z.number(),
        radius: z.number().positive(),
        sides: z.number().int().min(3),
        style,
    },
    (a) => created('createPolygon', [a.cx, a.cy, a.radius, a.sides, a.style]),
);

tool(
    'create_star',
    'Draw a star from its centre, with an outer and inner radius.',
    {
        cx: z.number(),
        cy: z.number(),
        outerRadius: z.number().positive(),
        innerRadius: z.number().positive(),
        points: z.number().int().min(3),
        style,
    },
    (a) => created('createStar', [a.cx, a.cy, a.outerRadius, a.innerRadius, a.points, a.style]),
);

tool(
    'create_path',
    'Draw an arbitrary path through a list of points. Omit the control points for straight segments; supply cp1/cp2 (absolute coordinates) for curves.',
    {
        points: z
            .array(
                z.object({
                    x: z.number(),
                    y: z.number(),
                    cp1x: z.number().optional(),
                    cp1y: z.number().optional(),
                    cp2x: z.number().optional(),
                    cp2y: z.number().optional(),
                }),
            )
            .min(2),
        closed: z.boolean().optional().describe('Close the path back to the first point'),
        style,
    },
    (a) => created('createPath', [a.points, a.closed ?? false, a.style]),
);

tool(
    'create_text',
    'Place a text object with its baseline starting at x,y.',
    { x: z.number(), y: z.number(), text: z.string(), fontSize: z.number().positive().optional() },
    (a) => created('createText', [a.x, a.y, a.text, a.fontSize ?? 16]),
);

// ─── Styling ────────────────────────────────────────────────────────────

tool(
    'set_fill',
    'Set the fill colour of one or more objects. Pass null to remove the fill.',
    { ids, color: hex.nullable() },
    async (a) => {
        await session.call('setFill', [a.ids, a.color]);
        return { ok: true };
    },
);

tool(
    'set_stroke',
    'Set the stroke colour (and optionally width) of one or more objects. Pass null to remove the stroke.',
    { ids, color: hex.nullable(), width: z.number().positive().optional() },
    async (a) => {
        await session.call('setStroke', [a.ids, a.color, a.width]);
        return { ok: true };
    },
);

tool(
    'set_opacity',
    'Set opacity (0 = transparent, 1 = opaque) on one or more objects.',
    { ids, opacity: z.number().min(0).max(1) },
    async (a) => {
        await session.call('setOpacity', [a.ids, a.opacity]);
        return { ok: true };
    },
);

tool(
    'set_corner_radius',
    'Round the corners of one or more objects.',
    { ids, radius: z.number().min(0) },
    async (a) => {
        await session.call('setCornerRadius', [a.ids, a.radius]);
        return { ok: true };
    },
);

// ─── Arranging ──────────────────────────────────────────────────────────

tool(
    'move',
    'Move one or more objects by a relative offset.',
    { ids, dx: z.number(), dy: z.number() },
    async (a) => {
        await session.call('move', [a.ids, a.dx, a.dy]);
        return { ok: true };
    },
);

tool(
    'set_position',
    'Move a single object so its origin sits at an absolute x,y.',
    { id: z.number(), x: z.number(), y: z.number() },
    async (a) => {
        await session.call('setPosition', [a.id, a.x, a.y]);
        return { node: await session.call('describeNode', [a.id]) };
    },
);

tool(
    'resize',
    'Resize a single object to an absolute width and height.',
    { id: z.number(), width: z.number().positive(), height: z.number().positive() },
    async (a) => {
        await session.call('resize', [a.id, a.width, a.height]);
        return { node: await session.call('describeNode', [a.id]) };
    },
);

tool(
    'rotate',
    'Set a single object’s rotation in degrees (absolute, not relative).',
    { id: z.number(), degrees: z.number() },
    async (a) => {
        await session.call('rotate', [a.id, a.degrees]);
        return { ok: true };
    },
);

tool(
    'align',
    'Align objects to a shared edge or centre line. Prefer this over computing coordinates yourself — it is exact.',
    {
        ids: z.array(z.number()).min(2),
        mode: z.enum(['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom']),
    },
    async (a) => {
        await session.call('align', [a.ids, a.mode]);
        return { ok: true };
    },
);

tool(
    'distribute',
    'Space objects evenly along an axis. Prefer this over computing spacing yourself.',
    { ids: z.array(z.number()).min(3), axis: z.enum(['h', 'v']) },
    async (a) => {
        await session.call('distribute', [a.ids, a.axis]);
        return { ok: true };
    },
);

// ─── Structuring ────────────────────────────────────────────────────────

tool(
    'group',
    'Group objects so they can be moved and styled as one.',
    { ids: z.array(z.number()).min(2) },
    async (a) => ({ id: await session.call<number>('group', [a.ids]) }),
);

tool('ungroup', 'Dissolve a group, keeping its children.', { id: z.number() }, async (a) => {
    await session.call('ungroup', [a.id]);
    return { ok: true };
});

tool('duplicate', 'Copy an object.', { id: z.number() }, async (a) =>
    created('duplicate', [a.id]).then((r) => r),
);

tool('delete', 'Remove one or more objects.', { ids }, async (a) => {
    await session.call('remove', [a.ids]);
    return { ok: true };
});

tool(
    'rename',
    'Give an object a meaningful name (shows in the layers panel and in describe_scene).',
    { id: z.number(), name: z.string() },
    async (a) => {
        await session.call('rename', [a.id, a.name]);
        return { ok: true };
    },
);

tool(
    'boolean',
    'Combine shapes into one path: union (merge), subtract (cut the front shapes out of the back one), intersect (keep the overlap), exclude (keep everything but the overlap).',
    {
        ids: z.array(z.number()).min(2),
        op: z.enum(['union', 'subtract', 'intersect', 'exclude']),
    },
    async (a) => ({ id: await session.call<number | null>('boolean', [a.ids, a.op]) }),
);

// ─── Session ────────────────────────────────────────────────────────────

tool('undo', 'Undo the last change.', {}, async () => {
    await session.call('undo');
    return { ok: true };
});

tool('redo', 'Redo the last undone change.', {}, async () => {
    await session.call('redo');
    return { ok: true };
});

const shutdown = async () => {
    await session.close();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
