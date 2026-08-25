/**
 * Mode-coverage test: every mode must reach an editor, and every tool must
 * behave the same once it gets there.
 *
 * The bridged arrangement has its own smoke tests. This covers what those
 * don't:
 *
 *   - config resolution for each mode (flags and environment variables),
 *     including the removed browser-owning modes, which must fail loudly
 *     rather than quietly running as something else;
 *   - `--url`, which is how a mode points at a dev server or a deployment
 *     instead of the default address;
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
import { extname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import puppeteer, { type Browser } from 'puppeteer';
import { APP_DIST, CHROME_ARGS, freePort, SERVER_ARGV, serveStatic } from './harness.ts';
import { readConfig } from './src/config.ts';

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

// ─── Config resolution ──────────────────────────────────────────────────

check('defaults to relay', readConfig([]).mode === 'relay');
check('--mode bridge is honoured', readConfig(['--mode', 'bridge']).mode === 'bridge');
check('--mode relay is honoured', readConfig(['--mode', 'relay']).mode === 'relay');
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

// The browser-owning modes are gone. A config that still asks for one must be
// told, not silently given a different mode: the artwork would land somewhere
// the user isn't looking, which is the confusing failure worth a hard error.
for (const gone of ['headless', 'headful']) {
    let message = '';
    try {
        readConfig(['--mode', gone]);
    } catch (err) {
        message = (err as Error).message;
    }
    check(
        `--mode ${gone} fails with a way forward`,
        /has been removed/.test(message) && /--mode relay/.test(message),
        message.slice(0, 120),
    );
}
process.env.DADAKI_MCP_HEADFUL = '1';
{
    let message = '';
    try {
        readConfig([]);
    } catch (err) {
        message = (err as Error).message;
    }
    check(
        'DADAKI_MCP_HEADFUL=1 fails with a way forward',
        /has been removed/.test(message),
        message,
    );
}
process.env.DADAKI_MCP_HEADFUL = '';
process.env.DADAKI_MCP_MODE = 'bridge';
check('DADAKI_MCP_MODE is honoured', readConfig([]).mode === 'bridge');
process.env.DADAKI_MCP_MODE = '';

let browser: Browser | null = null;
const httpServed = await serveStatic(APP_DIST);

// ─── shutting the server down ───────────────────────────────────────────
// An MCP client stops a server by closing its stdin. Nothing else would stop
// bridge mode: it holds a listening socket, which keeps the event loop alive
// on its own. Every client restart used to leave an orphan behind, each still
// holding the fixed port — so the next server could not have 7331, and the
// connect URL that is supposed to be stable quietly changed.
{
    const exitedWithin = (ms: number, kill: (c: ReturnType<typeof spawn>) => void) =>
        new Promise<boolean>((resolve) => {
            const child = spawn(process.execPath, [
                ...SERVER_ARGV,
                '--mode',
                'bridge',
                '--port',
                '0',
            ]);
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                resolve(false);
            }, ms);
            child.on('exit', () => {
                clearTimeout(timer);
                resolve(true);
            });
            // Give it a moment to finish starting before asking it to stop.
            setTimeout(() => kill(child), 1_500);
        });

    check(
        'bridge mode exits when its client closes stdin',
        await exitedWithin(12_000, (c) => c.stdin?.end()),
    );
    check('bridge mode exits on SIGTERM', await exitedWithin(12_000, (c) => c.kill('SIGTERM')));
}

// ─── a call with nothing attached ───────────────────────────────────────
// This has to come back with instructions, and come back SOON. It used to wait
// two minutes, so the MCP client's own timeout fired first and the agent was
// told "request timed out" — the one message it cannot act on.
{
    const client = new Client({ name: 'modes-unattached', version: '1.0.0' });
    const started = Date.now();
    try {
        await client.connect(
            new StdioClientTransport({
                command: process.execPath,
                args: [...SERVER_ARGV, '--mode', 'bridge', '--port', '0'],
            }),
        );
        const r = await client.callTool({ name: 'describe_scene', arguments: {} });
        const secs = (Date.now() - started) / 1000;
        const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
        check(
            'an unattached bridge answers in seconds, not minutes',
            Boolean(r.isError) && secs < 20,
            {
                secs,
                text,
            },
        );
        check('and says which URL to open', /bridge URL/.test(text), text);
    } catch (err) {
        check(
            'an unattached bridge answers in seconds, not minutes',
            false,
            (err as Error).message,
        );
    } finally {
        await client.close().catch(() => {});
    }
}

// ─── a stale config, at the CLI ─────────────────────────────────────────
// readConfig throwing is only half of it. An MCP client shows the user the
// server's stderr and nothing else, so the message has to ARRIVE as a message:
// this used to surface as an unhandled exception, with the one line saying
// what to change buried under a stack trace from inside the bundle.
{
    const { out, code } = await new Promise<{ out: string; code: number | null }>((resolve) => {
        const child = spawn(process.execPath, [...SERVER_ARGV, '--mode', 'headless']);
        let buf = '';
        child.stderr.on('data', (d) => {
            buf += String(d);
        });
        child.on('exit', (c) => resolve({ out: buf, code: c }));
    });
    check(
        'a removed mode is reported as a message, not a crash',
        /has been removed/.test(out) && !/\n\s+at /.test(out) && !/throw new Error/.test(out),
        out.slice(0, 240),
    );
    check('a removed mode exits non-zero', code === 1, code);
}

// ─── relay --url ────────────────────────────────────────────────────────
// Relay defaults to the hosted app, and `--url` is how it is pointed at a
// staging deployment or a dev backend instead. Getting that wrong is invisible
// — the server starts fine and pairs against the WRONG deployment — so the
// address it settled on has to appear in what it prints.
{
    const notice = await new Promise<string>((resolve) => {
        const child = spawn(process.execPath, [
            ...SERVER_ARGV,
            '--mode',
            'relay',
            '--url',
            httpServed.origin,
        ]);
        let buf = '';
        child.stderr.on('data', (d) => {
            buf += String(d);
        });
        setTimeout(() => {
            child.kill('SIGKILL');
            resolve(buf);
        }, 6_000);
    });
    check(
        'relay reports the deployment it was pointed at',
        notice.includes(`relay mode — ${httpServed.origin}`),
        notice.slice(0, 200),
    );
    check(
        'relay names the button that attaches an editor',
        /Connect agent/.test(notice) && /8-character code/.test(notice),
        notice.slice(0, 400),
    );
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
            const child = spawn(process.execPath, [...SERVER_ARGV, '--mode', 'bridge']);
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

    /** Start the server and return everything it printed before dying. */
    const startAndCapture = (extra: string[] = []) =>
        new Promise<string>((resolve) => {
            const child = spawn(process.execPath, [...SERVER_ARGV, '--mode', 'bridge', ...extra]);
            let buf = '';
            child.stderr.on('data', (d) => {
                buf += String(d);
            });
            setTimeout(() => {
                child.kill('SIGKILL');
                resolve(buf);
            }, 6_000);
        });

    // The bridge listening says nothing about whether there is an editor to
    // attach to. Printing a URL to a dev server that isn't running is a dead
    // link with no clue why — which is exactly how this bit someone.
    const deadBase = await startAndCapture(['--port', '0', '--url', 'http://localhost:9/']);
    check(
        'a base URL with nothing serving it is called out',
        /nothing is serving/.test(deadBase),
        deadBase.slice(-200),
    );

    const first = await startAndRead();
    const second = await startAndRead();
    check('bridge prints a connect URL', /agentBridge=\d+&token=[0-9a-f]{48}/.test(first), first);
    check('the connect URL is identical after a restart', first !== '' && first === second, {
        first,
        second,
    });
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
                        ...SERVER_ARGV,
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
                args: [...CHROME_ARGS, '--ignore-certificate-errors'],
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
