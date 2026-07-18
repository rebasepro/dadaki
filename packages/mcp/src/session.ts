/**
 * The editor session the MCP server drives.
 *
 * The editor is a browser application: CanvasKit, the Rust/WASM engine and the
 * whole tool layer assume a DOM and a GPU canvas. Rather than maintain a second,
 * inevitably-divergent Node implementation, this runs the REAL editor build in
 * headless Chrome and calls into it over CDP. An agent's edits therefore go
 * through exactly the same engine, history and export paths as a human's.
 *
 * The page is served from the app's production build (`packages/app/dist`) by a
 * small static server on an ephemeral port — no dev server, no network access.
 */

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';

const HERE = fileURLToPath(new URL('.', import.meta.url));
/** The app's built output — `pnpm build` at the repo root produces this. */
export const APP_DIST = resolve(HERE, '../../app/dist');

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

/** Serve `root` read-only on an ephemeral port. */
async function serveStatic(root: string): Promise<{ server: Server; origin: string }> {
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

export interface SessionOptions {
    /** Show the browser window — useful when watching an agent work. */
    headful?: boolean;
    /** Canvas viewport, which also bounds the default artboard. */
    width?: number;
    height?: number;
}

export class EditorSession {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private server: Server | null = null;
    private starting: Promise<void> | null = null;
    // A plain field, not a constructor parameter property: this file runs under
    // Node's strip-only type stripping, which rejects parameter properties.
    private readonly opts: SessionOptions;

    constructor(opts: SessionOptions = {}) {
        this.opts = opts;
    }

    /** Boot the browser + editor on first use; subsequent calls reuse it. */
    async ready(): Promise<Page> {
        if (!this.starting) this.starting = this.start();
        await this.starting;
        if (!this.page) throw new Error('[dadaki-mcp] editor session failed to start');
        return this.page;
    }

    private async start(): Promise<void> {
        const { width = 1280, height = 800, headful = false } = this.opts;

        const served = await serveStatic(APP_DIST).catch((err) => {
            throw new Error(
                `[dadaki-mcp] could not serve the editor build from ${APP_DIST}. ` +
                    `Run \`pnpm build\` at the repo root first. (${(err as Error).message})`,
            );
        });
        this.server = served.server;

        this.browser = await puppeteer.launch({
            headless: !headful,
            args: [
                // CanvasKit needs a working GL surface; headless Chrome's
                // software path (SwiftShader) provides one deterministically.
                '--use-gl=swiftshader',
                '--enable-unsafe-swiftshader',
                '--no-sandbox',
            ],
        });
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width, height });

        // Surface page errors as server-side diagnostics — a silent WASM failure
        // would otherwise look like an unexplained tool timeout.
        this.page.on('pageerror', (err) => console.error('[editor page error]', err.message));

        await this.page.goto(`${served.origin}/index.html`, { waitUntil: 'load' });
        // The editor boots asynchronously (CanvasKit + WASM init), so wait for
        // the handle rather than racing it.
        await this.page.waitForFunction(() => Boolean((window as any).app?.agent), {
            timeout: 60_000,
        });
    }

    /**
     * Invoke a method on the in-page agent API and return its result.
     * `args` must be JSON-serializable (it crosses the CDP boundary).
     */
    async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
        const page = await this.ready();
        const { ok, value, error } = await page.evaluate(
            (m: string, a: unknown[]) => {
                const agent = (window as any).app?.agent;
                if (!agent) return { ok: false, error: 'editor agent API is not available' };
                if (typeof agent[m] !== 'function')
                    return { ok: false, error: `unknown method ${m}` };
                try {
                    return { ok: true, value: agent[m](...a) ?? null };
                } catch (err) {
                    return { ok: false, error: (err as Error).message };
                }
            },
            method,
            args,
        );
        if (!ok) throw new Error(String(error));
        return value as T;
    }

    /** PNG of the current canvas — how the agent sees what it has drawn. */
    async screenshot(): Promise<string> {
        const page = await this.ready();
        // Drop the selection first: its handles and bounding box are editor
        // chrome, and an agent reading the render can't tell them apart from
        // artwork it actually drew (it reads as a stray outlined rectangle).
        // Selection is view state, not document state, so clearing costs
        // nothing — every verb targets explicit ids, never "the selection".
        await this.call('select', [[]]).catch(() => {});
        // Let any pending render land before capturing.
        await page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const canvas = await page.$('#editor-canvas');
        const target = canvas ?? page;
        return (await target.screenshot({ encoding: 'base64', type: 'png' })) as string;
    }

    async close(): Promise<void> {
        await this.browser?.close().catch(() => {});
        this.server?.close();
        this.browser = null;
        this.page = null;
        this.server = null;
        this.starting = null;
    }
}
