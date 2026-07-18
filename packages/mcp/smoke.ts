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

    const svg = await call('export_svg');
    check('export_svg returns markup', svg.svg.startsWith('<svg'), svg.svg.slice(0, 40));
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

    console.log(`\nartifacts written to ${OUT}`);
} finally {
    await client.close().catch(() => {});
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
