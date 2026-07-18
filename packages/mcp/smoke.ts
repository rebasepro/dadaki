/**
 * End-to-end smoke test for the MCP server.
 *
 * The unit tests in `packages/editor/src/agent.test.ts` cover the agent API
 * against the real engine, but they can't see the parts that only exist once
 * the whole thing is assembled: the MCP handshake and tool schemas, the CDP
 * bridge into the page, CanvasKit actually booting headless, and rendering.
 * Those are exactly where this integration breaks, so drive it as a real
 * client would.
 *
 *   pnpm build                                   # produces packages/app/dist
 *   node --experimental-strip-types packages/mcp/smoke.ts [outDir]
 *
 * Writes logo.svg + logo.png to `outDir` (default: the system temp dir) and
 * exits non-zero on any failed assertion.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const OUT = process.argv[2] ?? tmpdir();
const SERVER = new URL('./src/index.ts', import.meta.url).pathname;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (ok) {
        console.log(`  ok  ${label}`);
    } else {
        failures++;
        console.error(`FAIL  ${label}`, detail ?? '');
    }
}

const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-strip-types', SERVER],
});
const client = new Client({ name: 'dadaki-smoke', version: '1.0.0' });

type Content = Array<{ type: string; text?: string; data?: string }>;

async function call(name: string, args: Record<string, unknown> = {}) {
    const r = await client.callTool({ name, arguments: args });
    const first = (r.content as Content)[0];
    if (r.isError) throw new Error(`${name} failed: ${first?.text}`);
    return first?.text ? JSON.parse(first.text) : first;
}

try {
    await client.connect(transport);

    // Tool descriptions say what each verb does; the server instructions say
    // how to WORK. Without them an agent gets 30 verbs and no sense that it
    // should be looking at renders, which is the whole point of the tool.
    const instructions = client.getInstructions() ?? '';
    check(
        'server ships working instructions, not just tool descriptions',
        instructions.length > 200 && /render_png_image/.test(instructions),
        instructions.slice(0, 80),
    );

    const { tools } = await client.listTools();
    check('server exposes its tool surface', tools.length > 20, `${tools.length} tools`);
    for (const required of ['describe_scene', 'create_rect', 'boolean', 'export_svg']) {
        check(
            `exposes ${required}`,
            tools.some((t) => t.name === required),
        );
    }

    // Compose a ring-and-slash mark the way an agent would.
    const ring = await call('create_ellipse', {
        cx: 400,
        cy: 400,
        rx: 160,
        ry: 160,
        style: { fill: '#2563eb' },
    });
    const hole = await call('create_ellipse', {
        cx: 400,
        cy: 400,
        rx: 90,
        ry: 90,
        style: { fill: '#ffffff' },
    });
    check('create returns an id and the created node', typeof ring.id === 'number' && !!ring.node);
    check('creation adds no unrequested stroke', ring.node.stroke === null, ring.node.stroke);

    const cut = await call('boolean', { ids: [ring.id, hole.id], op: 'subtract' });
    check('boolean subtract produces a path', typeof cut.id === 'number', cut);

    const bar = await call('create_rect', {
        x: 380,
        y: 200,
        width: 40,
        height: 400,
        style: { fill: '#f59e0b' },
    });
    await call('rotate', { id: bar.id, degrees: 45 });
    await call('rename', { id: bar.id, name: 'Slash' });

    const scene = await call('describe_scene');
    check('describe_scene reflects the edits', scene.nodes.length === 2, scene.nodes);
    check(
        'rename is visible to the agent',
        scene.nodes.some((n: { name: string }) => n.name === 'Slash'),
    );

    // A path must have real geometry — the engine silently yields an EMPTY
    // path if the control-point format ever drifts, which renders as nothing.
    const tri = await call('create_path', {
        points: [
            { x: 700, y: 700 },
            { x: 800, y: 600 },
            { x: 900, y: 700 },
        ],
        closed: true,
        style: { fill: '#10b981' },
    });
    check(
        'create_path has non-zero bounds',
        tri.node.bounds[2] > 0 && tri.node.bounds[3] > 0,
        tri.node.bounds,
    );

    // The canvas rect must be reachable — without it an agent cannot centre
    // artwork or reason about margins, and resorts to reading ruler pixels.
    check('describe_scene reports the canvas', scene.canvas?.width > 0, scene.canvas);

    // SVG path data: the notation agents are fluent in. Arcs in particular
    // cannot be expressed through the point form at all.
    const arc = await call('create_path_data', {
        d: 'M 700 700 A 60 60 0 1 1 820 700 Z',
        style: { fill: '#8b5cf6' },
    });
    check('create_path_data renders an arc', arc.node.bounds[2] > 50, arc.node.bounds);

    const grad = await call('create_rect', { x: 120, y: 120, width: 160, height: 160 });
    await call('set_gradient', {
        ids: grad.id,
        type: 'linear',
        angle: 45,
        stops: [
            { offset: 0, color: '#ec4899' },
            { offset: 1, color: '#3b82f6' },
        ],
    });
    const gradNode = await call('describe_scene');
    const gradDesc = gradNode.nodes.find((n: { id: number }) => n.id === grad.id);
    check('gradient fill is reported as a gradient', gradDesc?.fillType === 'gradient', gradDesc);

    // Whole-document import — the fastest route to complex artwork.
    const imported = await call('import_svg', {
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="80" fill="#22c55e"/><rect x="60" y="60" width="80" height="80" fill="#fbbf24"/></svg>',
    });
    check(
        'import_svg creates nodes',
        Array.isArray(imported.ids) && imported.ids.length > 0,
        imported.ids,
    );

    // Typography: a content edit must not silently reset weight/size, or an
    // agent styling text then correcting a typo loses the styling.
    const label = await call('create_text', { x: 140, y: 900, text: 'draft', fontSize: 72 });
    // The engine defaults text to WHITE, which is invisible on the default
    // white artboard — a node that reports fine and draws nothing.
    check(
        'new text is visible, not white-on-white',
        label.node.fill === '#000000',
        label.node.fill,
    );

    // Text bounds must be MEASURED, not the engine's `bytes * size * 0.6`
    // estimate. Anything positioning text by its reported width — right-
    // aligning, centring, packing columns — lands wrong otherwise, and the
    // estimate errs in both directions (bold caps are wider than 0.6em, body
    // text much narrower), so it can't be corrected with a fudge factor.
    const estimate = 'draft'.length * 72 * 0.6;
    check('text width is measured, not estimated', Math.abs(label.node.bounds[2] - estimate) > 1, {
        reported: label.node.bounds[2],
        estimate,
    });

    await call('set_text', { id: label.id, weight: 700, italic: true });
    await call('set_text', { id: label.id, text: 'DADAKI' });

    // Paint order has to be controllable, or an agent can only ever stack
    // things in creation order.
    await call('send_to_back', { id: label.id });
    const ordered = await call('describe_scene');
    check('send_to_back reorders the scene', ordered.nodes[0].id === label.id, ordered.nodes[0]);
    await call('bring_to_front', { id: label.id });

    const svg = await call('export_svg');
    check('export_svg returns markup', svg.svg.startsWith('<svg'), svg.svg.slice(0, 40));

    // The engine creates text with an EMPTY family, which falls back to a face
    // carrying no bold or italic — so weight and slant silently do nothing and
    // the render contradicts what was asked for.
    const textTag = svg.svg.match(/<text[^>]*>/)?.[0] ?? '';
    check('text carries a real font family', /font-family="Inter"/.test(textTag), textTag);
    check(
        'weight and slant survive to the deliverable',
        /font-weight="700"/.test(textTag) && /font-style="italic"/.test(textTag),
        textTag,
    );
    writeFileSync(join(OUT, 'logo.svg'), svg.svg);

    const img = await client.callTool({ name: 'render_png_image', arguments: {} });
    const image = (img.content as Content)[0];
    check('render_png_image returns an image', image.type === 'image' && !!image.data);
    writeFileSync(join(OUT, 'logo.png'), Buffer.from(image.data ?? '', 'base64'));

    // An unknown id must come back as a readable tool error, not a crash and
    // not a raw JSON.parse failure from deep inside the engine bindings.
    const bad = await client.callTool({ name: 'set_fill', arguments: { ids: 999, color: '#fff' } });
    const msg = (bad.content as Content)[0]?.text ?? '';
    check(
        'unknown id yields an actionable error',
        bad.isError === true && /no object with id 999/.test(msg),
        msg,
    );

    // Fitting the canvas is the last step of any icon/logo job, so it has to
    // produce a frame that actually hugs the artwork.
    const fitted = await call('fit_canvas_to_artwork', { margin: 24 });
    check('fit_canvas_to_artwork tightens the frame', fitted.canvas.width < 1000, fitted.canvas);

    // `clear` is the escape hatch from a botched drawing, and it must be one
    // undo step or the way back is worse than the mess.
    await call('clear');
    const cleared = await call('describe_scene');
    check('clear empties the canvas', cleared.nodes.length === 0, cleared.nodes);
    await call('undo');
    const restored = await call('describe_scene');
    check(
        'one undo restores everything clear removed',
        restored.nodes.length > 0,
        restored.nodes.length,
    );

    console.log(`\nartifacts written to ${OUT}`);
} finally {
    await client.close().catch(() => {});
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
