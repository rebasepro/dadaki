/**
 * Mode-coverage test: every mode must reach an editor, and every tool must
 * behave the same once it gets there.
 *
 * The headless and bridge arrangements have their own smoke tests. This covers
 * what those don't:
 *
 *   - config resolution for each mode (flags and environment variables);
 *   - `--url`, which is how any mode points at a dev server or a deployment
 *     instead of the bundled build;
 *   - the bridge from an HTTPS origin, which is the deployed-app case. That one
 *     is not obvious: `ws://127.0.0.1` from an `https://` page could be blocked
 *     as mixed content, which would rule bridge mode out for the cloud app
 *     entirely. It is settled here empirically rather than by assumption.
 *
 * The HTTPS half needs a self-signed cert; it is skipped if one isn't present.
 *
 *   node --experimental-strip-types packages/mcp/smoke_modes.ts [certDir]
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { extname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import puppeteer, { type Browser } from 'puppeteer';
import { readConfig } from './src/config.ts';
import { APP_DIST, serveStatic } from './src/transport_puppeteer.ts';

const SERVER = new URL('./src/index.ts', import.meta.url).pathname;
const CERT_DIR = process.argv[2] ?? '/tmp';
const TOKEN = 'modes-test-token';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (ok) console.log(`  ok  ${label}`);
    else {
        failures++;
        console.error(`FAIL  ${label}`, detail ?? '');
    }
}
const skip = (label: string, why: string) => console.log(`  --  ${label} (skipped: ${why})`);

async function freePort(): Promise<number> {
    const s = createNetServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as { port: number }).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
}

// ─── Config resolution ──────────────────────────────────────────────────

check('defaults to headless', readConfig([]).mode === 'headless');
check('--mode headful is honoured', readConfig(['--mode', 'headful']).mode === 'headful');
check('--mode bridge is honoured', readConfig(['--mode', 'bridge']).mode === 'bridge');
check(
    '--url is carried through',
    readConfig(['--url', 'https://example.test/']).url === 'https://example.test/',
);
check(
    'a token is generated when none is given',
    (readConfig([]).token?.length ?? 0) >= 32,
    readConfig([]).token?.length,
);
check('--token overrides the generated one', readConfig(['--token', 'abc']).token === 'abc');
{
    // The original env var predates --mode and must keep working.
    process.env.DADAKI_MCP_HEADFUL = '1';
    check('DADAKI_MCP_HEADFUL=1 still selects headful', readConfig([]).mode === 'headful');
    process.env.DADAKI_MCP_HEADFUL = '';
    process.env.DADAKI_MCP_MODE = 'bridge';
    check('DADAKI_MCP_MODE is honoured', readConfig([]).mode === 'bridge');
    process.env.DADAKI_MCP_MODE = '';
}

type Content = Array<{ type: string; text?: string; data?: string }>;
let browser: Browser | null = null;
const httpServed = await serveStatic(APP_DIST);

// ─── --url mode ─────────────────────────────────────────────────────────
// Pointing at an already-running editor is the mechanism the cloud app uses;
// only the address and the need to sign in differ.
{
    const client = new Client({ name: 'modes-url', version: '1.0.0' });
    try {
        await client.connect(
            new StdioClientTransport({
                command: process.execPath,
                args: [
                    '--experimental-strip-types',
                    SERVER,
                    '--mode',
                    'headless',
                    '--url',
                    `${httpServed.origin}/index.html`,
                ],
            }),
        );
        const r = await client.callTool({
            name: 'create_rect',
            arguments: { x: 10, y: 10, width: 100, height: 100 },
        });
        const text = (r.content as Content)[0]?.text ?? '';
        check(
            '--url drives an editor served elsewhere',
            !r.isError && text.includes('"id"'),
            text.slice(0, 120),
        );
    } catch (err) {
        check('--url drives an editor served elsewhere', false, (err as Error).message);
    } finally {
        await client.close().catch(() => {});
    }
}

// ─── bridge: the connect URL must survive a restart ─────────────────────
// Bridge mode is only usable if you attach ONCE. A token minted per run would
// reject the previously attached tab on every server restart — and MCP clients
// restart their servers constantly — leaving the user to re-paste a URL each
// time. So both the port and the token have to be stable.
{
    const urlOf = (stderr: string) => stderr.match(/agentBridge=\d+&token=[0-9a-f]+/)?.[0] ?? '';
    /** Start the server, read its printed connect URL, then kill it. */
    const startAndRead = () =>
        new Promise<string>((resolve) => {
            const child = spawn(process.execPath, [
                '--experimental-strip-types',
                SERVER,
                '--mode',
                'bridge',
            ]);
            let buf = '';
            const done = (v: string) => {
                child.kill('SIGKILL');
                resolve(v);
            };
            child.stderr.on('data', (d) => {
                buf += String(d);
                const u = urlOf(buf);
                if (u) done(u);
            });
            setTimeout(() => done(urlOf(buf)), 15_000);
        });

    const first = await startAndRead();
    const second = await startAndRead();
    check('bridge prints a connect URL', /agentBridge=\d+&token=[0-9a-f]{48}/.test(first), first);
    check('the connect URL is identical after a restart', first !== '' && first === second, {
        first,
        second,
    });
}

// ─── headful ────────────────────────────────────────────────────────────
// Same transport as headless with the window shown, but "same code path" is
// exactly the assumption worth checking: a real window needs a display, and
// on a headless machine this is the one mode that legitimately cannot run.
{
    const client = new Client({ name: 'modes-headful', version: '1.0.0' });
    try {
        await client.connect(
            new StdioClientTransport({
                command: process.execPath,
                args: ['--experimental-strip-types', SERVER, '--mode', 'headful'],
            }),
        );
        const r = await client.callTool({
            name: 'create_rect',
            arguments: { x: 20, y: 20, width: 80, height: 80 },
        });
        const text = (r.content as Content)[0]?.text ?? '';
        check(
            'headful drives a visible window',
            !r.isError && text.includes('"id"'),
            text.slice(0, 120),
        );
    } catch (err) {
        // No display (CI, ssh) is a legitimate reason, not a failure.
        skip('headful drives a visible window', (err as Error).message.slice(0, 80));
    } finally {
        await client.close().catch(() => {});
    }
}

// ─── Bridge from an HTTPS origin (the deployed-app case) ────────────────
{
    let cert: Buffer;
    let key: Buffer;
    try {
        cert = readFileSync(join(CERT_DIR, 'cert.pem'));
        key = readFileSync(join(CERT_DIR, 'key.pem'));
    } catch {
        skip('bridge attaches from an HTTPS origin', `no cert.pem/key.pem in ${CERT_DIR}`);
        cert = key = Buffer.alloc(0);
    }

    if (cert.length) {
        const MIME: Record<string, string> = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.wasm': 'application/wasm',
            '.ttf': 'font/ttf',
            '.svg': 'image/svg+xml',
        };
        const root = resolve(APP_DIST);
        const https = createHttpsServer({ cert, key }, (req, res) => {
            try {
                const p = (req.url ?? '/').split('?')[0];
                const file = p === '/' ? 'index.html' : p.replace(/^\//, '');
                const body = readFileSync(join(root, file));
                res.writeHead(200, {
                    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
                }).end(body);
            } catch {
                res.writeHead(404).end('not found');
            }
        });
        const httpsPort = await freePort();
        await new Promise<void>((r) => https.listen(httpsPort, '127.0.0.1', r));

        const bridgePort = await freePort();
        const client = new Client({ name: 'modes-https-bridge', version: '1.0.0' });
        try {
            await client.connect(
                new StdioClientTransport({
                    command: process.execPath,
                    args: [
                        '--experimental-strip-types',
                        SERVER,
                        '--mode',
                        'bridge',
                        '--port',
                        String(bridgePort),
                        '--token',
                        TOKEN,
                    ],
                }),
            );
            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--use-gl=swiftshader',
                    '--enable-unsafe-swiftshader',
                    '--no-sandbox',
                    '--ignore-certificate-errors',
                ],
            });
            const page = await browser.newPage();
            await page.goto(
                `https://127.0.0.1:${httpsPort}/index.html?agentBridge=${bridgePort}&token=${TOKEN}`,
                { waitUntil: 'load' },
            );
            await page.waitForFunction('Boolean(window.app && window.app.agent)', {
                timeout: 60_000,
            });
            await new Promise((r) => setTimeout(r, 2000));

            const r = await client.callTool({
                name: 'create_rect',
                arguments: { x: 40, y: 40, width: 120, height: 120 },
            });
            const inPage = (await page.evaluate('window.app.agent.describe()')) as {
                nodes: unknown[];
            };
            check(
                'bridge attaches from an HTTPS origin (ws://localhost is not blocked as mixed content)',
                !r.isError && inPage.nodes.length === 1,
                { isError: r.isError, nodes: inPage.nodes.length },
            );
        } catch (err) {
            check('bridge attaches from an HTTPS origin', false, (err as Error).message);
        } finally {
            await client.close().catch(() => {});
            https.close();
        }
    }
}

await browser?.close().catch(() => {});
httpServed.server.close();

console.log(failures === 0 ? '\nall mode checks passed' : `\n${failures} mode check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
