// End-to-end check of the pairing flow, as a real MCP client would see it:
// spawn the dadaki MCP server, hand it ONLY the code from the editor, and see
// whether it can then drive the document.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CODE = process.argv[2];
const BACKEND = process.argv[3] ?? 'http://localhost:3001';
const SERVER = '/Users/francesco/dadaki-vector-editor/packages/mcp/src/index.ts';

let fail = 0;
const check = (label, ok, detail) =>
    ok ? console.log(`  ok  ${label}`) : (fail++, console.error(`FAIL  ${label}`, detail ?? ''));

const client = new Client({ name: 'pair-check', version: '1' });
const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    if (r.isError) throw new Error(text);
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

try {
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            // Deliberately NO --token: the whole point is that the code is enough.
            args: ['--experimental-strip-types', SERVER, '--mode', 'relay', '--url', BACKEND],
        }),
    );

    const tools = (await client.listTools()).tools.map((t) => t.name);
    check('the server exposes a `connect` tool', tools.includes('connect'), tools.slice(0, 8));

    // Before pairing, this server has some stale token and should NOT be driving.
    let early = null;
    try {
        await call('describe_scene');
    } catch (e) {
        early = e.message;
    }
    check(
        'before pairing it refuses, and says how to fix it',
        !!early && /Connect agent/i.test(early) && /code/i.test(early),
        early,
    );

    const connected = await call('connect', { code: CODE });
    check('connect redeems the code', connected?.connected === true, connected);
    check('and comes back with the live scene', !!connected?.scene?.canvas, connected?.scene);

    // Now drive it for real.
    const rect = await call('create_rect', {
        x: 120, y: 120, width: 260, height: 180,
        style: { fill: '#00a2ff' },
    });
    check('a draw lands in the paired document', typeof rect?.id === 'number', rect);

    const scene = await call('describe_scene');
    check('and shows up in the scene', (scene.nodes ?? []).length >= 1, scene.nodes?.length);

    // A code is single use.
    let reuse = null;
    try {
        await call('connect', { code: CODE });
    } catch (e) {
        reuse = e.message;
    }
    check('the code cannot be reused', !!reuse && /not valid|expired|used/i.test(reuse), reuse);
} catch (err) {
    fail++;
    console.error('threw:', err.message);
} finally {
    await client.close().catch(() => {});
    console.log(fail === 0 ? '\nPairing flow OK.' : `\n${fail} check(s) failed.`);
    process.exit(fail === 0 ? 0 : 1);
}
