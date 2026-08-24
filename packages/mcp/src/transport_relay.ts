/**
 * Relay transport — drives an editor tab in a HOSTED app.
 *
 * The local bridge has the browser dial `ws://127.0.0.1`. That is impossible
 * from a public origin: Chrome's Local Network Access checks refuse the
 * connection outright (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS), so a
 * deployed editor cannot reach a server on someone's laptop no matter how the
 * socket is framed. Both sides therefore connect OUTWARD to the app's backend,
 * which pairs them by token (see cloud/backend/src/agent_bridge.ts).
 *
 * This side is deliberately the simpler half: one POST per call, held open by
 * the relay until the editor answers. No socket to keep alive, no reconnect
 * logic, and it works through any proxy that passes ordinary HTTP.
 */

import { AgentCallError, type EditorTransport, unwrap } from './transport.ts';

export interface RelayTransportOptions {
    /** Base URL of the hosted app, e.g. https://dadaki.com */
    origin: string;
    /** Shared token identifying this agent session. */
    token: string;
    /** How long to wait for a single call. Slightly under the relay's own. */
    callTimeoutMs?: number;
    /** How long `call` waits for an editor to attach before giving up. */
    attachTimeoutMs?: number;
}

export class RelayTransport implements EditorTransport {
    readonly mode = 'relay';
    private opts: RelayTransportOptions;
    private readonly base: string;
    /** Has an editor ever held this session? Decides how patient `call` is. */
    private seenEditor = false;

    /** The token currently in use, so a caller can persist it. */
    get token(): string {
        return this.opts.token;
    }

    /**
     * Redeem a pairing code shown by the editor's "Connect agent" button.
     *
     * This is what lets an agent attach knowing nothing but a short code the
     * human read to it — no URL, no 48-hex token, nothing to paste into a
     * config. The code is single-use, so a successful claim is also the last
     * time that code works.
     */
    async claim(code: string): Promise<string> {
        const cleaned = code.toUpperCase().replace(/[^0-9A-Z]/g, '');
        let res: Response;
        try {
            res = await fetch(`${this.base}/claim`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: cleaned }),
                signal: AbortSignal.timeout(10_000),
            });
        } catch (err) {
            throw new AgentCallError(
                `could not reach the relay at ${this.base} (${(err as Error).message})`,
            );
        }
        if (res.status === 404) {
            throw new AgentCallError(
                'that code is not valid (it may have expired, or already been used). Ask for a ' +
                    'fresh one from "Connect agent" in the editor.',
            );
        }
        if (res.status === 429) {
            throw new AgentCallError('too many attempts — wait a minute and try again.');
        }
        if (!res.ok) throw new AgentCallError(`relay returned ${res.status} for claim`);
        const { token } = (await res.json()) as { token?: string };
        if (!token) throw new AgentCallError('relay returned no token for that code');
        this.opts = { ...this.opts, token };
        return token;
    }

    constructor(opts: RelayTransportOptions) {
        this.opts = opts;
        // /api/functions/… because the relay ships as a Rebase custom function
        // — the only backend code the managed runtime's bundle carries.
        this.base = `${opts.origin.replace(/\/+$/, '')}/api/functions/agent-bridge`;
    }

    /** Is an editor currently holding this token? */
    async attached(): Promise<boolean> {
        try {
            const res = await fetch(
                `${this.base}/status?token=${encodeURIComponent(this.opts.token)}`,
                {
                    signal: AbortSignal.timeout(8_000),
                },
            );
            if (!res.ok) return false;
            const ok = Boolean(((await res.json()) as { attached?: boolean })?.attached);
            if (ok) this.seenEditor = true;
            return ok;
        } catch {
            return false;
        }
    }

    /**
     * Wait until an editor attaches. A drawing session usually starts before
     * the human has opened the tab, so failing the first call immediately would
     * make the tool look broken rather than merely early.
     */
    private async waitForEditor(): Promise<void> {
        // Fail FAST when we have never seen this editor: the agent's next move
        // is to ask a human for a pairing code, and it cannot do that while
        // blocked. Waiting two minutes here just meant the MCP client's own
        // timeout fired first and the agent got "Request timed out" instead of
        // the instructions. Once a tab HAS been attached, a drop is usually a
        // reload, so wait long enough for it to come back.
        const deadline =
            Date.now() + (this.opts.attachTimeoutMs ?? (this.seenEditor ? 45_000 : 4_000));
        for (;;) {
            if (await this.attached()) return;
            if (Date.now() > deadline) {
                throw new AgentCallError(
                    'no editor is attached. Ask the person you are working with to open their ' +
                        'dadaki document, click "Connect agent" in the header, and read you the ' +
                        '8-character code — then call `connect` with it. (They do not need to ' +
                        'paste a URL or a token; the code is all you need.)',
                );
            }
            await new Promise((r) => setTimeout(r, 1_000));
        }
    }

    async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
        if (!(await this.attached())) await this.waitForEditor();

        let res: Response;
        try {
            res = await fetch(`${this.base}/call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: this.opts.token, method, args }),
                signal: AbortSignal.timeout(this.opts.callTimeoutMs ?? 55_000),
            });
        } catch (err) {
            throw new AgentCallError(
                `could not reach the relay at ${this.base} (${(err as Error).message})`,
            );
        }

        if (res.status === 409) {
            throw new AgentCallError('no editor is attached to this session');
        }
        if (!res.ok) {
            throw new AgentCallError(`relay returned ${res.status} for ${method}`);
        }
        return unwrap<T>((await res.json()) as { ok: boolean; value?: unknown; error?: string });
    }

    async close(): Promise<void> {
        // Nothing to tear down: every call is a self-contained request, which is
        // most of the reason this transport is the simple one.
    }
}
