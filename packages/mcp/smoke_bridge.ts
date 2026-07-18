/**
 * End-to-end test for BRIDGE mode — the agent driving an editor tab it does
 * not own.
 *
 * Bridge mode is the one arrangement the headless smoke test cannot cover: the
 * MCP server launches no browser, and correctness means a tool call lands in
 * SOMEBODY ELSE'S already-open page. So this stands in for the human: it opens
 * an editor itself, attaches it with the bridge URL, drives it over MCP, and
 * then reads the page back DIRECTLY (not through MCP) to prove the edits
 * really landed in that tab rather than in some other instance.
 *
 *   pnpm build
 *   node --experimental-strip-types packages/mcp/smoke_bridge.ts
 */

import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import puppeteer from 'puppeteer';
import { APP_DIST, serveStatic } from './src/transport_puppeteer.ts';

const SERVER = new URL('./src/index.ts', import.meta.url).pathname;
const TOKEN = 'smoke-test-token';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (ok) console.log(`  ok  ${label}`);
    else {
        failures++;
        console.error(`FAIL  ${label}`, detail ?? '');
    }
}

/** Grab a free loopback port; the bridge needs a known one to build its URL. */
async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as { port: number }).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
}

const port = await freePort();
const served = await serveStatic(APP_DIST);
const browser = await puppeteer.launch({
    headless: true,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const client = new Client({ name: 'dadaki-bridge-smoke', version: '1.0.0' });

type Content = Array<{ type: string; text?: string; data?: string }>;
async function call(name: string, args: Record<string, unknown> = {}) {
    const r = await client.callTool({ name, arguments: args });
    const first = (r.content as Content)[0];
    if (r.isError) throw new Error(`${name} failed: ${first?.text}`);
    return first?.text ? JSON.parse(first.text) : first;
}

try {
    // The MCP server owns no browser in this mode — it only listens.
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            args: [
                '--experimental-strip-types',
                SERVER,
                '--mode',
                'bridge',
                '--port',
                String(port),
                '--token',
                TOKEN,
            ],
        }),
    );
    check('server starts in bridge mode without launching a browser', true);

    // Stand in for the human opening their editor with the bridge URL.
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e: unknown) => console.error('[page]', (e as Error)?.message));
    await page.goto(`${served.origin}/index.html?agentBridge=${port}&token=${TOKEN}`, {
        waitUntil: 'load',
    });
    await page.waitForFunction('Boolean(window.app && window.app.agent)', { timeout: 60_000 });

    // The token must not be left sitting in the address bar / history.
    const url = await page.evaluate('window.location.search');
    check('bridge credentials are stripped from the URL', !String(url).includes(TOKEN), url);

    // Give the socket a moment to attach, then drive the page over MCP.
    await new Promise((r) => setTimeout(r, 1500));

    const rect = await call('create_rect', {
        x: 100,
        y: 100,
        width: 200,
        height: 150,
        style: { fill: '#2563eb' },
    });
    check('a tool call reaches the attached editor', typeof rect.id === 'number', rect);

    // The real proof: read the page back directly, NOT through MCP. If the
    // edit had gone to any other editor instance, this would come back empty.
    const inPage = (await page.evaluate('window.app.agent.describe()')) as {
        nodes: Array<{ id: number; fill: string }>;
    };
    check(
        'the edit landed in THIS page, not another instance',
        inPage.nodes.some((n) => n.id === rect.id && n.fill === '#2563eb'),
        inPage.nodes,
    );

    // Undo must be the user's undo — same history, same granularity.
    const beforeUndo = inPage.nodes.length;
    await call('undo');
    const afterUndo = (await page.evaluate('window.app.agent.describe()')) as { nodes: unknown[] };
    check(
        'agent edits land in the page’s own undo history',
        afterUndo.nodes.length === beforeUndo - 1,
        { beforeUndo, after: afterUndo.nodes.length },
    );

    // Rendering must work without puppeteer: the page rasterizes itself.
    await call('create_ellipse', {
        cx: 300,
        cy: 300,
        rx: 120,
        ry: 120,
        style: { fill: '#f59e0b' },
    });
    const img = await client.callTool({ name: 'render_png_image', arguments: {} });
    const image = (img.content as Content)[0];
    check(
        'render works with no browser of our own',
        image?.type === 'image' && (image.data?.length ?? 0) > 1000,
        image?.data?.length,
    );

    const svg = await call('export_svg');
    check('export works over the bridge', svg.svg.startsWith('<svg'), svg.svg.slice(0, 30));

    // A second editor must be refused, or a call would be ambiguous about
    // which document it edited.
    const second = await browser.newPage();
    await second.goto(`${served.origin}/index.html?agentBridge=${port}&token=${TOKEN}`, {
        waitUntil: 'load',
    });
    await second.waitForFunction('Boolean(window.app && window.app.agent)', { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 1500));
    const stillFirst = (await page.evaluate('window.app.agent.describe()')) as { nodes: unknown[] };
    const secondScene = (await second.evaluate('window.app.agent.describe()')) as {
        nodes: unknown[];
    };
    check(
        'a second editor cannot hijack the session',
        stillFirst.nodes.length > 0 && secondScene.nodes.length === 0,
        { first: stillFirst.nodes.length, second: secondScene.nodes.length },
    );

    // A wrong token must be refused outright.
    const intruder = await browser.newPage();
    await intruder.goto(`${served.origin}/index.html?agentBridge=${port}&token=wrong-token`, {
        waitUntil: 'load',
    });
    await intruder.waitForFunction('Boolean(window.app && window.app.agent)', { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 1500));
    await call('create_rect', { x: 500, y: 500, width: 50, height: 50 });
    const intruderScene = (await intruder.evaluate('window.app.agent.describe()')) as {
        nodes: unknown[];
    };
    check('an editor with a bad token receives nothing', intruderScene.nodes.length === 0, {
        nodes: intruderScene.nodes.length,
    });
} catch (err) {
    failures++;
    console.error('FAIL  unexpected error:', (err as Error).message);
} finally {
    await client.close().catch(() => {});
    await browser.close().catch(() => {});
    served.server.close();
}

console.log(failures === 0 ? '\nall bridge checks passed' : `\n${failures} bridge check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
