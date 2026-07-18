/**
 * Mode selection for the MCP server.
 *
 * Every tool works in every mode — the mode only decides how calls reach an
 * editor. Configuration is via environment variables because MCP clients
 * launch servers from a JSON config where `env` is the natural place to put
 * this; CLI flags are accepted too for running it by hand.
 */

import { randomBytes } from 'node:crypto';
import type { EditorTransport } from './transport.ts';
import { BridgeTransport } from './transport_bridge.ts';
import { PuppeteerTransport } from './transport_puppeteer.ts';

export type Mode = 'headless' | 'headful' | 'bridge';

export interface Config {
    mode: Mode;
    /** Load this URL instead of the bundled build (dev server, staging, cloud). */
    url?: string;
    /** Bridge only: port to listen on (0 = pick a free one). */
    port: number;
    /** Bridge only: the shared secret an editor must present. */
    token: string;
}

function envFlag(name: string): boolean {
    const v = process.env[name];
    return v === '1' || v === 'true';
}

export function readConfig(argv: string[] = process.argv.slice(2)): Config {
    const args = new Map<string, string>();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const eq = a.indexOf('=');
        if (eq !== -1) args.set(a.slice(2, eq), a.slice(eq + 1));
        else args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? 'true' : (argv[++i] ?? 'true'));
    }

    const rawMode = args.get('mode') ?? process.env.DADAKI_MCP_MODE;
    let mode: Mode;
    if (rawMode === 'bridge' || rawMode === 'headful' || rawMode === 'headless') {
        mode = rawMode;
    } else if (envFlag('DADAKI_MCP_HEADFUL')) {
        // Retained: this was the original way to watch the agent work.
        mode = 'headful';
    } else {
        mode = 'headless';
    }

    const url = args.get('url') ?? process.env.DADAKI_MCP_URL;
    const port = Number(args.get('port') ?? process.env.DADAKI_MCP_PORT ?? 0) || 0;
    // A generated token is the safe default: it means the bridge is never
    // reachable by a page that wasn't explicitly handed the credentials.
    const token =
        args.get('token') ?? process.env.DADAKI_MCP_TOKEN ?? randomBytes(24).toString('hex');

    return { mode, url, port, token };
}

/** Build the transport for a config, and describe how to reach it. */
export async function createTransport(
    cfg: Config,
): Promise<{ transport: EditorTransport; notice: string }> {
    if (cfg.mode === 'bridge') {
        const transport = new BridgeTransport({ port: cfg.port, token: cfg.token });
        const port = await transport.listen();
        const base = cfg.url ?? 'http://localhost:5199/';
        const sep = base.includes('?') ? '&' : '?';
        const connectUrl = `${base}${sep}agentBridge=${port}&token=${cfg.token}`;
        return {
            transport,
            notice:
                `[dadaki-mcp] bridge mode — listening on 127.0.0.1:${port}\n` +
                '[dadaki-mcp] open your editor with this URL to attach it:\n' +
                `\n    ${connectUrl}\n\n` +
                '[dadaki-mcp] the tab stays attached across reloads until you clear it.',
        };
    }

    const transport = new PuppeteerTransport({
        headful: cfg.mode === 'headful',
        url: cfg.url,
    });
    return {
        transport,
        notice: `[dadaki-mcp] ${cfg.mode} mode${cfg.url ? ` — ${cfg.url}` : ''}`,
    };
}
