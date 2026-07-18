/**
 * Mode selection for the MCP server.
 *
 * Every tool works in every mode — the mode only decides how calls reach an
 * editor. Configuration is via environment variables because MCP clients
 * launch servers from a JSON config where `env` is the natural place to put
 * this; CLI flags are accepted too for running it by hand.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EditorTransport } from './transport.ts';
import { BridgeTransport } from './transport_bridge.ts';
import { PuppeteerTransport } from './transport_puppeteer.ts';

export type Mode = 'headless' | 'headful' | 'bridge';

/**
 * Default bridge port. Fixed, not ephemeral, so the connect URL is the SAME
 * every run — an attached tab keeps working across server restarts instead of
 * needing the URL re-pasted each time.
 */
const DEFAULT_BRIDGE_PORT = 7331;

/**
 * Where the bridge token is remembered, outside any repo so it is never
 * committed. A token regenerated per run would reject the previously attached
 * tab on every restart, which makes bridge mode unusable in practice: the
 * whole point is that you attach once and forget about it.
 */
const TOKEN_FILE = join(homedir(), '.dadaki', 'agent-bridge.json');

function persistentToken(): string {
    try {
        const saved = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as { token?: string };
        if (saved.token) return saved.token;
    } catch {
        // No token yet (or an unreadable one) — mint a fresh one below.
    }
    const token = randomBytes(24).toString('hex');
    try {
        mkdirSync(dirname(TOKEN_FILE), { recursive: true });
        writeFileSync(TOKEN_FILE, JSON.stringify({ token }, null, 2));
        // Owner-only: it is a remote-control credential for your documents.
        chmodSync(TOKEN_FILE, 0o600);
    } catch (err) {
        console.error(
            `[dadaki-mcp] could not persist the bridge token to ${TOKEN_FILE} ` +
                `(${(err as Error).message}). Attached tabs will need re-attaching ` +
                'after a restart.',
        );
    }
    return token;
}

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
    const explicitPort = args.get('port') ?? process.env.DADAKI_MCP_PORT;
    const port = explicitPort !== undefined ? Number(explicitPort) || 0 : DEFAULT_BRIDGE_PORT;
    // Explicit token wins; otherwise reuse the one on disk so a restart doesn't
    // orphan an attached tab. Still a secret the page must be HANDED — nothing
    // attaches by discovering the port.
    const token = args.get('token') ?? process.env.DADAKI_MCP_TOKEN ?? persistentToken();

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
