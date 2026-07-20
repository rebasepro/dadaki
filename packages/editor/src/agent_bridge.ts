/**
 * Agent bridge — lets an out-of-process agent drive THIS editor tab.
 *
 * An MCP server (packages/mcp) sends calls; this services them against
 * `EditorHandle.agent`. The human keeps working in the same window: an agent's
 * edits are ordinary edits, so they land in the same undo history and can be
 * undone, corrected, or taken over at any point.
 *
 * TWO TRANSPORTS, because one cannot cover both cases:
 *
 *   local — the page opens a socket straight to `ws://127.0.0.1:<port>`.
 *           Direct and dependency-free, and only usable when the page itself is
 *           served from localhost.
 *   relay — the page holds an SSE stream from its OWN origin and posts results
 *           back. Required for the hosted app: Chrome's Local Network Access
 *           checks block a public origin from reaching loopback at all
 *           (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS), so both sides have to
 *           connect outward and the backend pairs them.
 *
 * Opt-in only, and never by discovery. The page connects when it is given a
 * token — as `?agentBridge=<port|cloud>&token=…` or from a previous session.
 * Nothing connects on its own.
 *
 * The channel is deliberately narrow: it carries a method name and JSON args,
 * and will only ever invoke a function that exists on the agent API. It cannot
 * evaluate arbitrary code in the page.
 */

import type { AgentApi } from './agent';

/**
 * Where a bridge lives. `local` targets a loopback port; `relay` targets this
 * page's own origin, which proxies to an agent connected from elsewhere.
 */
export type BridgeCredentials =
    | { kind: 'local'; port: number; token: string }
    | { kind: 'relay'; token: string };

const STORAGE_KEY = 'dadaki.agentBridge';

/** Parse whatever was stored or supplied into credentials, or null. */
function toCredentials(raw: {
    kind?: string;
    port?: number;
    token?: string;
}): BridgeCredentials | null {
    if (!raw?.token) return null;
    if (raw.kind === 'relay') return { kind: 'relay', token: raw.token };
    // Older stored values predate `kind` and were always local.
    if (typeof raw.port === 'number' && raw.port > 0) {
        return { kind: 'local', port: raw.port, token: raw.token };
    }
    return null;
}

/**
 * Read bridge credentials from the URL, falling back to a previous session.
 *
 * `?agentBridge=cloud` selects the relay; a number selects that loopback port.
 * Credentials found in the URL are persisted so a reload stays attached (the
 * editor reloads often, and re-pasting a URL each time would make the mode
 * unusable), and stripped from the address bar so the token isn't left sitting
 * in browser history or copied into a shared link.
 */
export function readBridgeCredentials(): BridgeCredentials | null {
    try {
        const params = new URLSearchParams(window.location.search);
        const target = params.get('agentBridge');
        const token = params.get('token');
        if (target && token) {
            const creds: BridgeCredentials | null =
                target === 'cloud' || target === 'relay'
                    ? { kind: 'relay', token }
                    : toCredentials({ kind: 'local', port: Number(target), token });
            if (creds) {
                try {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
                } catch {
                    // Private mode / storage disabled: still connect for this load.
                }
                params.delete('agentBridge');
                params.delete('token');
                const qs = params.toString();
                window.history.replaceState(
                    {},
                    '',
                    window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
                );
                return creds;
            }
        }
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved ? toCredentials(JSON.parse(saved)) : null;
    } catch {
        return null;
    }
}

/** Forget any stored bridge, so the tab stops attaching on reload. */
export function clearBridgeCredentials() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // Nothing to do — the caller only wants it gone if it can be.
    }
}

export interface BridgeHandle {
    /** Close the channel and stop reconnecting. */
    disconnect(): void;
    /** True while a live channel is attached. */
    readonly connected: boolean;
}

export interface BridgeOptions {
    /** Called on connect/disconnect so a host can show status. */
    onStatus?: (connected: boolean) => void;
    /** Reconnect backoff ceiling. */
    maxRetryMs?: number;
    /**
     * Where the relay lives, for `relay` credentials. Defaults to this page's
     * origin, which is right in production (the backend serves the SPA). A host
     * whose API is on a different origin — a dev server proxying nothing, for
     * instance — must say so, or the editor would post calls at itself.
     */
    relayOrigin?: string;
}

/** One incoming call, from either transport. */
interface CallFrame {
    id?: number;
    method?: string;
    args?: unknown[];
}

/**
 * Run one call against the agent API and produce the reply body.
 *
 * Shared by both transports so they cannot drift on the part that matters: only
 * a real function on the agent API is ever dispatched to, which is what keeps
 * this from becoming a way to evaluate arbitrary code in the page.
 */
async function invoke(agent: AgentApi, msg: CallFrame): Promise<Record<string, unknown>> {
    const fn = (agent as unknown as Record<string, unknown>)[msg.method ?? ''];
    if (typeof fn !== 'function') return { ok: false, error: `unknown method ${msg.method}` };
    try {
        const value = await (fn as (...a: unknown[]) => unknown).apply(agent, msg.args ?? []);
        return { ok: true, value: value ?? null };
    } catch (err) {
        return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
}

/** Local transport: a socket straight to the MCP server on loopback. */
function connectLocal(
    agent: AgentApi,
    creds: { port: number; token: string },
    opts: BridgeOptions,
): BridgeHandle {
    const { onStatus, maxRetryMs = 10_000 } = opts;
    let socket: WebSocket | null = null;
    let stopped = false;
    let retry = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
        if (stopped) return;
        const ws = new WebSocket(
            `ws://127.0.0.1:${creds.port}/?token=${encodeURIComponent(creds.token)}`,
        );
        socket = ws;

        ws.onopen = () => {
            retry = 500;
            onStatus?.(true);
            console.info('[dadaki] agent bridge attached (local)');
        };

        ws.onmessage = async (event) => {
            let msg: CallFrame;
            try {
                msg = JSON.parse(String(event.data));
            } catch {
                return;
            }
            if (typeof msg.id !== 'number' || !msg.method) return;
            const body = await invoke(agent, msg);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ id: msg.id, ...body }));
            }
        };

        const closed = (why: string) => {
            if (socket !== ws) return;
            socket = null;
            onStatus?.(false);
            if (stopped) return;
            // A rejected token is permanent; retrying would just spin. Discard
            // the stored credentials too — the usual cause is a restarted MCP
            // server issuing a fresh token, and keeping them would make every
            // future reload of this tab fail the same way.
            if (why === 'rejected') {
                clearBridgeCredentials();
                console.warn(
                    '[dadaki] agent bridge rejected this tab — token invalid, or another editor ' +
                        'is already attached. Stored credentials cleared; re-open with the URL ' +
                        'the server printed to attach again.',
                );
                return;
            }
            timer = setTimeout(open, retry);
            retry = Math.min(retry * 2, maxRetryMs);
        };

        ws.onclose = (e) => closed(e.code === 4401 || e.code === 4409 ? 'rejected' : 'closed');
        ws.onerror = () => {
            // onclose always follows, which is where reconnect is handled.
        };
    };

    open();
    return {
        get connected() {
            return socket?.readyState === WebSocket.OPEN;
        },
        disconnect() {
            stopped = true;
            if (timer) clearTimeout(timer);
            socket?.close();
            socket = null;
            onStatus?.(false);
        },
    };
}

/**
 * Relay transport: hold an SSE stream from this origin, post results back.
 *
 * Reconnection is manual rather than EventSource's built-in retry, because the
 * relay refuses a second editor for the same token (409) and EventSource, which
 * cannot see status codes, would reconnect against that forever. Checking
 * `/status` first turns that into a clear message and a stop.
 */
function connectRelay(
    agent: AgentApi,
    creds: { token: string },
    opts: BridgeOptions,
): BridgeHandle {
    const { onStatus, maxRetryMs = 10_000 } = opts;
    const base = `${(opts.relayOrigin ?? window.location.origin).replace(/\/+$/, '')}/api/agent-bridge`;
    const qs = `token=${encodeURIComponent(creds.token)}`;
    let source: EventSource | null = null;
    let stopped = false;
    let retry = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reconnect = () => {
        if (stopped) return;
        timer = setTimeout(open, retry);
        retry = Math.min(retry * 2, maxRetryMs);
    };

    const open = async () => {
        if (stopped) return;
        // Don't fight an editor that already holds this token.
        try {
            const status = await fetch(`${base}/status?${qs}`, { credentials: 'omit' });
            if (status.ok && (await status.json())?.attached) {
                console.warn(
                    '[dadaki] another editor is already attached to this agent session — ' +
                        'close it, or re-open with a fresh URL.',
                );
                reconnect();
                return;
            }
        } catch {
            // Status is only an optimisation; fall through and try the stream.
        }
        if (stopped) return;

        const es = new EventSource(`${base}/editor?${qs}`);
        source = es;

        es.addEventListener('attached', () => {
            retry = 500;
            onStatus?.(true);
            console.info('[dadaki] agent bridge attached (relay)');
        });

        es.addEventListener('call', async (event) => {
            let msg: CallFrame;
            try {
                msg = JSON.parse((event as MessageEvent).data);
            } catch {
                return;
            }
            if (typeof msg.id !== 'number' || !msg.method) return;
            const body = await invoke(agent, msg);
            // Results go over an ordinary POST; a failure here just means the
            // agent sees its own timeout, which is the right outcome.
            await fetch(`${base}/reply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: creds.token, id: msg.id, ...body }),
                credentials: 'omit',
            }).catch(() => {});
        });

        es.onerror = () => {
            if (source !== es) return;
            es.close();
            source = null;
            onStatus?.(false);
            reconnect();
        };
    };

    void open();
    return {
        get connected() {
            return source?.readyState === EventSource.OPEN;
        },
        disconnect() {
            stopped = true;
            if (timer) clearTimeout(timer);
            source?.close();
            source = null;
            onStatus?.(false);
        },
    };
}

/**
 * Connect this editor to an agent bridge and service calls until disconnected.
 *
 * Reconnects with backoff: the MCP server is restarted often during a session
 * (every client restart spawns a fresh one), and an editor that gave up after
 * the first drop would need a manual reload each time.
 */
export function connectAgentBridge(
    agent: AgentApi,
    creds: BridgeCredentials,
    opts: BridgeOptions = {},
): BridgeHandle {
    return creds.kind === 'relay'
        ? connectRelay(agent, creds, opts)
        : connectLocal(agent, creds, opts);
}
