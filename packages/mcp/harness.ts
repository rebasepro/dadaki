/**
 * Test-side browser harness.
 *
 * The server owns no browser: every mode drives a tab a *person* already has
 * open (`bridge` on localhost, `relay` in the hosted app). A test has no
 * person, so it plays that part — serve the built app, open it with puppeteer,
 * hand the tab the bridge URL — and from there drives it over MCP exactly as
 * an agent would.
 *
 * This lives outside `src/` on purpose. Puppeteer is a repo devDependency used
 * by tests and tooling; nothing the published package ships may import it, or
 * installing the server would pull down a browser it never launches.
 */

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import puppeteer, { type Browser, type Page } from 'puppeteer';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The app's built output — `pnpm build` at the repo root produces this. */
export const APP_DIST = resolve(HERE, '../app/dist');

/**
 * The server under test: the TypeScript sources by default, or the bundle npm
 * actually ships when DADAKI_MCP_TEST_BUNDLE is set.
 *
 * The published artifact is not the sources — it is one esbuild output with a
 * `createRequire` shim and every dependency inlined. Nothing that only tests
 * `src/` can see a bundling failure, and a bundling failure would reach users
 * as a broken install.
 */
export const TEST_BUNDLE = Boolean(process.env.DADAKI_MCP_TEST_BUNDLE);
export const SERVER = TEST_BUNDLE ? resolve(HERE, 'dist/index.js') : resolve(HERE, 'src/index.ts');

/** How to spawn the server under test — the bundle needs no type stripping. */
export const SERVER_ARGV = TEST_BUNDLE ? [SERVER] : ['--experimental-strip-types', SERVER];

const MIME: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.json': 'application/json',
    '.png': 'image/png',
};

/** Serve `root` read-only on an ephemeral loopback port. */
export async function serveStatic(root: string): Promise<{ server: Server; origin: string }> {
    const server = createServer(async (req, res) => {
        try {
            const rawPath = (req.url ?? '/').split('?')[0];
            const rel = normalize(decodeURIComponent(rawPath)).replace(/^(\.\.[/\\])+/, '');
            const file = rel === '/' || rel === '\\' ? 'index.html' : rel.replace(/^[/\\]/, '');
            const full = join(root, file);
            // Defence in depth: never serve outside the build directory.
            if (!full.startsWith(root)) {
                res.writeHead(403).end('forbidden');
                return;
            }
            const body = await readFile(full);
            res.writeHead(200, {
                'Content-Type': MIME[extname(full)] ?? 'application/octet-stream',
                // CanvasKit's threaded build wants cross-origin isolation.
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
            }).end(body);
        } catch {
            res.writeHead(404).end('not found');
        }
    });
    await new Promise<void>((ok, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', ok);
    });
    const { port } = server.address() as AddressInfo;
    return { server, origin: `http://127.0.0.1:${port}` };
}

/** Grab a free loopback port; the bridge needs a known one to build its URL. */
export async function freePort(): Promise<number> {
    const s = createNetServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
}

/** Chrome flags every test needs: CanvasKit wants a GL surface that exists. */
export const CHROME_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'];

export interface BridgedSession {
    /** An MCP client connected to a server in bridge mode. */
    client: Client;
    /** The editor tab that server is driving — readable directly, for proof. */
    page: Page;
    browser: Browser;
    close(): Promise<void>;
}

/**
 * The standard arrangement: an editor open in a browser, an MCP server
 * bridged to it, ready for tool calls.
 *
 * Both browser-driving smoke tests need this, and it is fiddly enough —
 * ephemeral port, static server, the credentials in the connect URL, waiting
 * for CanvasKit to boot — that two copies would drift.
 */
export async function startBridgedSession(
    opts: { token?: string; name?: string; chromeArgs?: string[] } = {},
): Promise<BridgedSession> {
    const token = opts.token ?? 'smoke-test-token';
    const port = await freePort();
    const served = await serveStatic(APP_DIST);
    const browser = await puppeteer.launch({
        headless: true,
        args: [...CHROME_ARGS, ...(opts.chromeArgs ?? [])],
    });

    const client = new Client({ name: opts.name ?? 'dadaki-smoke', version: '1.0.0' });
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            args: [...SERVER_ARGV, '--mode', 'bridge', '--port', String(port), '--token', token],
        }),
    );

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e: unknown) => console.error('[page]', (e as Error)?.message));
    await page.goto(`${served.origin}/index.html?agentBridge=${port}&token=${token}`, {
        waitUntil: 'load',
    });
    await page.waitForFunction('Boolean(window.app && window.app.agent)', { timeout: 60_000 });
    // The socket attaches a moment after the page settles; a call sent before
    // that lands nowhere and reads as a mysterious tool failure.
    await new Promise((r) => setTimeout(r, 1500));

    return {
        client,
        page,
        browser,
        close: async () => {
            await client.close().catch(() => {});
            await browser.close().catch(() => {});
            await new Promise<void>((r) => served.server.close(() => r()));
        },
    };
}
