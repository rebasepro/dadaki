/**
 * Relay behaviour, without a deployment.
 *
 * `smoke_relay.mjs` proves the real thing works against a real backend. This
 * proves what a real backend cannot show you: how MANY requests a call costs,
 * what the server does when the relay is unreachable, and that a stale pairing
 * code produces a sentence a human can act on. A stand-in backend is the only
 * way to count requests and to fail on demand.
 *
 *   node --experimental-strip-types packages/mcp/smoke_relay_offline.ts
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SERVER_ARGV } from './harness.ts';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (ok) console.log(`  ok  ${label}`);
    else {
        failures++;
        console.error(`FAIL  ${label}`, detail ?? '');
    }
}

/** A stand-in for the app's agent-bridge function, recording every request. */
async function fakeRelay(opts: { claimable?: boolean } = {}) {
    const seen: Array<{ method: string; url: string }> = [];
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        seen.push({ method: req.method ?? '', url: req.url ?? '' });
        const send = (code: number, obj: unknown) =>
            res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
        const path = (req.url ?? '').split('?')[0];
        if (path.endsWith('/status')) return send(200, { attached: true });
        if (path.endsWith('/claim'))
            return opts.claimable === false
                ? send(404, { error: 'no such code' })
                : send(200, { token: 'a'.repeat(48) });
        if (path.endsWith('/call')) {
            const method = (body as { method?: string })?.method;
            if (method === 'describe')
                return send(200, {
                    ok: true,
                    value: { canvas: { x: 0, y: 0, width: 800, height: 600 }, nodes: [] },
                });
            if (method === 'createRect') return send(200, { ok: true, value: 7 });
            if (method === 'describeNode')
                return send(200, { ok: true, value: { id: 7, name: 'Rect 7', type: 'Rect' } });
            return send(200, { ok: true, value: null });
        }
        send(404, { error: 'unknown' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return { seen, origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function connected(origin: string, extra: string[] = []) {
    const client = new Client({ name: 'relay-offline', version: '1.0.0' });
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            args: [...SERVER_ARGV, '--mode', 'relay', '--url', origin, ...extra],
        }),
    );
    return client;
}

const textOf = (r: unknown) =>
    ((r as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? '';

// ─── request economy ────────────────────────────────────────────────────
// Every call used to ask /status first, doubling the requests — and against a
// deployment that round-trip IS the cost of a drawing loop. The relay answers
// 409 the moment nothing is attached, so the call already carries that answer.
{
    // A trailing slash, because that is what the editor's setup line hands out.
    const relay = await fakeRelay();
    const client = await connected(`${relay.origin}/`, ['--token', 'b'.repeat(48)]);
    try {
        await client.callTool({
            name: 'create_rect',
            arguments: { x: 1, y: 2, width: 3, height: 4 },
        });
        relay.seen.length = 0;
        for (let i = 0; i < 5; i++)
            await client.callTool({ name: 'describe_scene', arguments: {} });
        const statuses = relay.seen.filter((r) => r.url.includes('/status')).length;
        const calls = relay.seen.filter((r) => r.url.includes('/call')).length;
        check('five tool calls cost five requests, not ten', statuses === 0 && calls === 5, {
            statuses,
            calls,
        });
        check(
            'a trailing slash in --url never doubles into //api',
            !relay.seen.some((r) => r.url.includes('//api')),
            relay.seen.map((r) => r.url).slice(0, 4),
        );
    } finally {
        await client.close().catch(() => {});
        relay.close();
    }
}

// ─── an unreachable deployment ──────────────────────────────────────────
// The failure has to name the relay. Reporting "no editor is attached" when
// the whole backend is down sends the human to the wrong button entirely.
{
    const client = await connected('http://127.0.0.1:9/');
    try {
        const started = Date.now();
        const r = await client.callTool({ name: 'describe_scene', arguments: {} });
        const secs = (Date.now() - started) / 1000;
        check('an unreachable relay fails fast', Boolean(r.isError) && secs < 20, {
            secs,
            text: textOf(r),
        });
        check(
            'and says it could not reach the relay',
            /could not reach the relay/.test(textOf(r)),
            textOf(r),
        );
    } finally {
        await client.close().catch(() => {});
    }
}

// ─── a code that is not good any more ───────────────────────────────────
{
    const relay = await fakeRelay({ claimable: false });
    const client = await connected(relay.origin);
    try {
        const r = await client.callTool({ name: 'connect', arguments: { code: 'AAAA-BBBB' } });
        check(
            'a dead code explains itself and points at the button',
            Boolean(r.isError) &&
                /expired|not valid/i.test(textOf(r)) &&
                /Connect agent/.test(textOf(r)),
            textOf(r),
        );
    } finally {
        await client.close().catch(() => {});
        relay.close();
    }
}

console.log(failures === 0 ? '\nall relay checks passed' : `\n${failures} relay check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
