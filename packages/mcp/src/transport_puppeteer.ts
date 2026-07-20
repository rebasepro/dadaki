/**
 * Puppeteer transport — the MCP server owns the browser.
 *
 * Covers three of the four modes, which differ only in what gets loaded and
 * whether a window is shown:
 *
 *   headless  — a throwaway browser serving the local build. The default, and
 *               the only one that works unattended (CI, scripts).
 *   headful   — the same, with a visible window so a human can watch.
 *   cloud/url — point at any running editor (a dev server, a staging deploy,
 *               the deployed app) instead of the bundled build.
 *
 * When no URL is given it serves `packages/app/dist` itself on an ephemeral
 * loopback port, so the default mode needs no dev server and no network.
 */

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { type EditorTransport, IN_PAGE_INVOKE, type InvokeResult, unwrap } from './transport.ts';

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

export interface PuppeteerTransportOptions {
    /** Show the browser window — useful when watching an agent work. */
    headful?: boolean;
    /** Load this URL instead of serving the local build (dev server, cloud). */
    url?: string;
    /** Viewport, which also bounds the default artboard. */
    width?: number;
    height?: number;
    /** How long to wait for the editor to boot (CanvasKit + WASM). */
    bootTimeoutMs?: number;
}

export class PuppeteerTransport implements EditorTransport {
    readonly mode: string;
    private browser: Browser | null = null;
    private page: Page | null = null;
    private server: Server | null = null;
    private starting: Promise<void> | null = null;
    private readonly opts: PuppeteerTransportOptions;

    constructor(opts: PuppeteerTransportOptions = {}) {
        this.opts = opts;
        this.mode = opts.url ? `url(${opts.url})` : opts.headful ? 'headful' : 'headless';
    }

    private async start(): Promise<void> {
        const { width = 1280, height = 800, headful = false, bootTimeoutMs = 60_000 } = this.opts;

        let target = this.opts.url;
        if (!target) {
            const served = await serveStatic(APP_DIST).catch((err) => {
                throw new Error(
                    `[dadaki-mcp] could not serve the editor build from ${APP_DIST}. ` +
                        `Run \`pnpm build\` at the repo root first. (${(err as Error).message})`,
                );
            });
            this.server = served.server;
            target = `${served.origin}/index.html`;
        }

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
        // Surface page errors as diagnostics — a silent WASM failure would
        // otherwise look like an unexplained tool timeout.
        this.page.on('pageerror', (err: unknown) =>
            console.error('[editor page error]', (err as Error)?.message ?? String(err)),
        );

        await this.page.goto(target, { waitUntil: 'load' });
        await this.page
            // Passed as a source string: this runs in the page, where `window`
            // exists, and this file is typechecked for Node where it does not.
            .waitForFunction('Boolean(window.app && window.app.agent)', {
                timeout: bootTimeoutMs,
            })
            .catch(() => {
                throw new Error(
                    `[dadaki-mcp] ${target} did not expose an editor agent API within ` +
                        `${bootTimeoutMs}ms. Is that URL running Dadaki, and is it signed in?`,
                );
            });
    }

    private async ready(): Promise<Page> {
        if (!this.starting) this.starting = this.start();
        await this.starting;
        if (!this.page) throw new Error('[dadaki-mcp] editor session failed to start');
        return this.page;
    }

    async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
        const page = await this.ready();
        const result = (await page.evaluate(
            // The snippet is shared with the bridge transport so the two paths
            // cannot drift; puppeteer accepts it as a function expression.
            `(${IN_PAGE_INVOKE})(${JSON.stringify(method)}, ${JSON.stringify(args)})`,
        )) as InvokeResult;
        return unwrap<T>(result);
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
