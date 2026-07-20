/**
 * How the MCP server reaches an editor.
 *
 * The agent API (`EditorHandle.agent`) is identical in every editor instance —
 * the local build, a dev server, the deployed cloud app. What differs is only
 * how a Node process gets a call into that page. Isolating that behind one
 * interface is what lets every tool work in every mode: the tool layer calls
 * `transport.call(method, args)` and never learns which mode it is in.
 *
 * Rendering deliberately is NOT part of this interface. It used to be a
 * puppeteer screenshot, which only one transport could do; it is now
 * `agent.toPNG()`, a normal call that CanvasKit services inside the page. So a
 * render looks the same — and produces the same pixels — in every mode.
 */

export interface EditorTransport {
    /** Human-readable mode name, for diagnostics. */
    readonly mode: string;
    /** Invoke a method on the in-page agent API. Args must be JSON-serializable. */
    call<T = unknown>(method: string, args?: unknown[]): Promise<T>;
    close(): Promise<void>;
}

/** Thrown when the editor reports an error, so tools can relay it verbatim. */
export class AgentCallError extends Error {}

/**
 * The snippet both transports run inside the page. Kept here so the two paths
 * can't drift: the bridge evaluates it directly, puppeteer passes it to
 * `page.evaluate`. Async so a Promise-returning verb (importSVG, toPNG) is
 * awaited in-page rather than serialized across the wire as `{}`.
 */
export const IN_PAGE_INVOKE = `async (method, args) => {
    const agent = window.app?.agent;
    if (!agent) return { ok: false, error: 'editor agent API is not available on this page' };
    if (typeof agent[method] !== 'function') return { ok: false, error: 'unknown method ' + method };
    try {
        return { ok: true, value: (await agent[method](...args)) ?? null };
    } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
    }
}`;

export interface InvokeResult {
    ok: boolean;
    value?: unknown;
    error?: string;
}

/** Unwrap the in-page result shape, turning a reported error into a throw. */
export function unwrap<T>(result: InvokeResult): T {
    if (!result?.ok) throw new AgentCallError(String(result?.error ?? 'unknown editor error'));
    return result.value as T;
}
