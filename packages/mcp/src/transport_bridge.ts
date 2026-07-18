/**
 * Bridge transport — the agent drives the editor tab the USER already has open.
 *
 * Here the MCP server owns no browser. It listens on loopback, and a live
 * editor page connects to it; calls then travel page-ward over that socket.
 * The human watches the work happen in their own window and can take over at
 * any point, because the agent's edits are ordinary edits (one undo step each,
 * same history, same autosave).
 *
 * Security. The socket is a remote-control channel into a document, so:
 *   - it binds 127.0.0.1 only, never a routable interface;
 *   - every connection must present a token, generated per run;
 *   - only ONE editor may be attached at a time, so a call can never be
 *     ambiguous about which document it landed in.
 * The token is compared with a timing-safe equality check, and the page is
 * given the token by the human (via the connect URL), never by discovery — a
 * random page cannot find its way in by guessing the port.
 */

import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import { AgentCallError, type EditorTransport, type InvokeResult, unwrap } from './transport.ts';

export interface BridgeTransportOptions {
    /** Loopback port to listen on. 0 picks a free one. */
    port?: number;
    /** Shared secret an editor must present to attach. */
    token: string;
    /** How long a tool call may wait for the page to answer. */
    callTimeoutMs?: number;
    /** How long `call` waits for an editor to attach before giving up. */
    attachTimeoutMs?: number;
}

interface Pending {
    resolve: (value: InvokeResult) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

/** Constant-time token comparison; plain `===` leaks length and prefix timing. */
function tokensMatch(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

export class BridgeTransport implements EditorTransport {
    readonly mode = 'bridge';
    private wss: WebSocketServer | null = null;
    private socket: WebSocket | null = null;
    private starting: Promise<void> | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private readonly opts: BridgeTransportOptions;
    /** Resolves when an editor attaches; replaced after each disconnect. */
    private attached!: Promise<void>;
    private markAttached!: () => void;

    constructor(opts: BridgeTransportOptions) {
        this.opts = opts;
        this.resetAttached();
    }

    private resetAttached() {
        this.attached = new Promise<void>((resolve) => {
            this.markAttached = resolve;
        });
    }

    /** The port actually bound; only meaningful once `listen()` has resolved. */
    get port(): number {
        const addr = this.wss?.address() as AddressInfo | undefined;
        return addr?.port ?? 0;
    }

    /** Start listening. Resolves as soon as the port is bound, NOT when an
     *  editor attaches — the server must be reachable before we can be told
     *  which URL to open. */
    async listen(): Promise<number> {
        if (!this.starting) this.starting = this.start();
        await this.starting;
        return this.port;
    }

    /** Bind `port`, resolving false if it is already taken. */
    private async bind(port: number): Promise<boolean> {
        const wss = new WebSocketServer({ host: '127.0.0.1', port });
        const ok = await new Promise<boolean>((resolve, reject) => {
            wss.once('listening', () => resolve(true));
            wss.once('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') resolve(false);
                else reject(err);
            });
        });
        if (ok) this.wss = wss;
        return ok;
    }

    private async start(): Promise<void> {
        const preferred = this.opts.port ?? 0;
        if (!(await this.bind(preferred))) {
            // The fixed default keeps the connect URL stable across restarts,
            // but a second server (or a stale one) must not take the whole
            // process down. Fall back to an ephemeral port; the caller builds
            // the URL from the port we actually bound.
            console.error(
                `[dadaki-mcp] port ${preferred} is in use — another server may already be ` +
                    'running. Falling back to a free port; the connect URL below is the one ' +
                    'to use, and an already-attached tab will need re-attaching.',
            );
            if (!(await this.bind(0))) throw new Error('[dadaki-mcp] could not bind a port');
        }
        const wss = this.wss;
        if (!wss) throw new Error('[dadaki-mcp] bridge failed to start');

        wss.on('connection', (ws, req) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const token = url.searchParams.get('token') ?? '';
            if (!tokensMatch(token, this.opts.token)) {
                ws.close(4401, 'bad token');
                return;
            }
            // One editor at a time: a second attachment would make it
            // ambiguous which document a call edited.
            if (this.socket && this.socket.readyState === this.socket.OPEN) {
                ws.close(4409, 'another editor is already attached');
                return;
            }

            this.socket = ws;
            this.markAttached();
            console.error('[dadaki-mcp] editor attached');

            ws.on('message', (raw) => {
                let msg: { id?: number } & InvokeResult;
                try {
                    msg = JSON.parse(String(raw));
                } catch {
                    return;
                }
                if (typeof msg.id !== 'number') return;
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                clearTimeout(p.timer);
                p.resolve(msg);
            });

            const drop = (why: string) => {
                if (this.socket !== ws) return;
                this.socket = null;
                this.resetAttached();
                console.error(`[dadaki-mcp] editor detached (${why})`);
                // Fail anything still in flight rather than hanging the agent.
                for (const [id, p] of this.pending) {
                    clearTimeout(p.timer);
                    p.reject(new AgentCallError(`editor disconnected before answering (${why})`));
                    this.pending.delete(id);
                }
            };
            ws.on('close', () => drop('closed'));
            ws.on('error', () => drop('error'));
        });
    }

    async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
        await this.listen();
        if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
            const wait = this.opts.attachTimeoutMs ?? 120_000;
            const timedOut = Symbol('timeout');
            // Hold the handle so the loser can be cancelled: without this, a
            // burst of calls issued right after attaching each leaves a live
            // two-minute timer (and its closure) pending on the event loop.
            let timer: NodeJS.Timeout | undefined;
            const race = await Promise.race([
                this.attached,
                new Promise((r) => {
                    timer = setTimeout(() => r(timedOut), wait);
                }),
            ]).finally(() => clearTimeout(timer));
            if (race === timedOut) {
                throw new AgentCallError(
                    'no editor is attached. Open the editor with the bridge URL printed at ' +
                        'startup, then retry.',
                );
            }
        }
        const ws = this.socket;
        if (!ws) throw new AgentCallError('no editor is attached');

        const id = this.nextId++;
        const result = await new Promise<InvokeResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new AgentCallError(`editor did not answer ${method} in time`));
            }, this.opts.callTimeoutMs ?? 30_000);
            this.pending.set(id, { resolve, reject, timer });
            ws.send(JSON.stringify({ id, method, args }));
        });
        return unwrap<T>(result);
    }

    async close(): Promise<void> {
        for (const [, p] of this.pending) clearTimeout(p.timer);
        this.pending.clear();
        this.socket?.close();
        await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
        this.wss = null;
        this.socket = null;
        this.starting = null;
    }
}
