/**
 * Agent bridge — lets an out-of-process agent drive THIS editor tab.
 *
 * The MCP server (packages/mcp) listens on loopback; this connects to it and
 * services `agent.*` calls as they arrive. The human keeps working in the same
 * window: an agent's edits are ordinary edits, so they land in the same undo
 * history and can be undone, corrected, or taken over at any point.
 *
 * Opt-in only, and never by discovery. The page connects when it is given a
 * port AND a token, either as `?agentBridge=PORT&token=…` in the URL or from a
 * previous session in localStorage. Nothing connects on its own, and a page
 * that has not been handed a token cannot find its way in by guessing the port.
 *
 * The socket is deliberately narrow: it accepts a method name and JSON args,
 * and will only ever invoke a function that exists on the agent API. It cannot
 * evaluate arbitrary code in the page.
 */

import type { AgentApi } from './agent';

/** Where a bridge lives. Both halves are required — a port alone won't do. */
export interface BridgeCredentials {
    port: number;
    token: string;
}

const STORAGE_KEY = 'dadaki.agentBridge';

/**
 * Read bridge credentials from the URL, falling back to a previous session.
 *
 * Credentials found in the URL are persisted so a reload stays attached (the
 * editor reloads often, and re-pasting a URL each time would make the mode
 * unusable), and stripped from the address bar so the token isn't left sitting
 * in browser history or copied into a shared link.
 */
export function readBridgeCredentials(): BridgeCredentials | null {
    try {
        const params = new URLSearchParams(window.location.search);
        const port = Number(params.get('agentBridge'));
        const token = params.get('token');
        if (port > 0 && token) {
            const creds = { port, token };
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
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return null;
        const parsed = JSON.parse(saved) as BridgeCredentials;
        return parsed?.port > 0 && parsed?.token ? parsed : null;
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
    /** Close the socket and stop reconnecting. */
    disconnect(): void;
    /** True while a live socket is attached. */
    readonly connected: boolean;
}

export interface BridgeOptions {
    /** Called on connect/disconnect so a host can show status. */
    onStatus?: (connected: boolean) => void;
    /** Reconnect backoff ceiling. */
    maxRetryMs?: number;
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
    const { onStatus, maxRetryMs = 10_000 } = opts;
    let socket: WebSocket | null = null;
    let stopped = false;
    let retry = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
        if (stopped) return;
        const url = `ws://127.0.0.1:${creds.port}/?token=${encodeURIComponent(creds.token)}`;
        const ws = new WebSocket(url);
        socket = ws;

        ws.onopen = () => {
            retry = 500;
            onStatus?.(true);
            console.info('[dadaki] agent bridge attached');
        };

        ws.onmessage = async (event) => {
            let msg: { id?: number; method?: string; args?: unknown[] };
            try {
                msg = JSON.parse(String(event.data));
            } catch {
                return;
            }
            if (typeof msg.id !== 'number' || !msg.method) return;

            const reply = (body: Record<string, unknown>) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ id: msg.id, ...body }));
                }
            };

            // Only ever dispatch to a real function on the agent API — this
            // socket must not become a way to evaluate arbitrary code.
            const fn = (agent as unknown as Record<string, unknown>)[msg.method];
            if (typeof fn !== 'function') {
                reply({ ok: false, error: `unknown method ${msg.method}` });
                return;
            }
            try {
                const value = await (fn as (...a: unknown[]) => unknown).apply(
                    agent,
                    msg.args ?? [],
                );
                reply({ ok: true, value: value ?? null });
            } catch (err) {
                reply({ ok: false, error: (err as Error)?.message ?? String(err) });
            }
        };

        const closed = (why: string) => {
            if (socket !== ws) return;
            socket = null;
            onStatus?.(false);
            if (stopped) return;
            // A rejected token is permanent; retrying would just spin. Discard
            // the stored credentials too: the common cause is a restarted MCP
            // server issuing a fresh token, and creds kept after a rejection
            // would make every future reload of this tab fail the same way,
            // recoverable only by knowing to call clearBridgeCredentials().
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
