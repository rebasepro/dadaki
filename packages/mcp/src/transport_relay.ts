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
    /** Base URL of the hosted app, e.g. https://dadaki.apps.rebase.pro */
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
    private readonly opts: RelayTransportOptions;
    private readonly base: string;

    constructor(opts: RelayTransportOptions) {
        this.opts = opts;
        this.base = `${opts.origin.replace(/\/+$/, '')}/api/agent-bridge`;
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
            return Boolean(((await res.json()) as { attached?: boolean })?.attached);
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
        const deadline = Date.now() + (this.opts.attachTimeoutMs ?? 120_000);
        for (;;) {
            if (await this.attached()) return;
            if (Date.now() > deadline) {
                throw new AgentCallError(
                    'no editor is attached. Open the hosted editor with the URL printed at ' +
                        'startup, then retry.',
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
