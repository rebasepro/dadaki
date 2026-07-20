/**
 * End-to-end test for RELAY mode — an agent driving an editor in a HOSTED app.
 *
 * This is the arrangement the local bridge cannot cover. A public origin is
 * forbidden from reaching `ws://127.0.0.1` (Chrome's Local Network Access
 * checks), so both sides connect outward and the app's backend pairs them. The
 * check that matters most is the last one: no LOCAL_NETWORK_ACCESS errors,
 * i.e. the relay genuinely avoids the restriction rather than tripping it
 * somewhere quieter.
 *
 * Needs the cloud stack running (backend :3001, frontend :5200):
 *   cd cloud && rebase dev
 *   node packages/mcp/smoke_relay.mjs
 *
 * Override the origins with RELAY_FRONTEND / RELAY_BACKEND to point at a
 * deployment instead.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer';

const FRONTEND = process.env.RELAY_FRONTEND ?? 'http://localhost:5200';
const BACKEND = process.env.RELAY_BACKEND ?? 'http://localhost:3001';
const SERVER   = '/Users/francesco/vector-editor/packages/mcp/src/index.ts';
const TOKEN    = randomBytes(24).toString('hex');

let fail = 0;
const check = (l, ok, d) => ok ? console.log(`  ok  ${l}`) : (fail++, console.error(`FAIL  ${l}`, d ?? ''));

const browser = await puppeteer.launch({ headless: true, args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const client = new Client({ name: 'relay-check', version: '1' });
const call = async (n, a={}) => { const r = await client.callTool({name:n,arguments:a}); const t=(r.content)[0]?.text??''; if(r.isError) throw new Error(t); return JSON.parse(t); };

try {
  // The agent side points at the BACKEND origin (dev: API is separate).
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['--experimental-strip-types', SERVER, '--mode', 'relay', '--url', BACKEND, '--token', TOKEN] }));

  const page = await browser.newPage();
  const errs = [];
  page.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
  await page.goto(`${FRONTEND}/edit/new/blank?agentBridge=cloud&token=${TOKEN}`, { waitUntil: 'load' });
  await page.waitForFunction('Boolean(window.app && window.app.agent)', { timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));

  const st = JSON.parse(await page.evaluate('JSON.stringify({badge:document.querySelectorAll(".agent-badge").length,url:location.search,stored:localStorage.getItem("dadaki.agentBridge")})'));
  check('relay credentials stored as kind=relay', /"kind":"relay"/.test(st.stored ?? ''), st.stored);
  check('token stripped from the address bar', !String(st.url).includes(TOKEN), st.url);
  check('"Agent connected" badge visible', st.badge === 1, st);

  const relayStatus = await (await fetch(`${BACKEND}/api/agent-bridge/status?token=${TOKEN}`)).json();
  check('backend sees an attached editor', relayStatus.attached === true, relayStatus);

  const rect = await call('create_rect', { x: 40, y: 40, width: 200, height: 120, style: { fill: '#00a2ff' } });
  check('MCP call reaches the editor through the relay', typeof rect.id === 'number', rect);

  const scene = await page.evaluate('window.app.agent.describe()');
  check('the edit landed in THAT tab', (scene.nodes||[]).length === 1, scene.nodes?.length);

  const png = await call('render_png', { scale: 1 });
  check('render round-trips through the relay', (png.image?.length ?? 0) > 1000, png.image?.length);

  const lna = errs.filter(e => /LOCAL_NETWORK_ACCESS/.test(e));
  check('no local-network-access errors (relay avoids them)', lna.length === 0, lna.slice(0,2));
} catch (e) { fail++; console.error('FAIL unexpected:', e.message); }
finally { await client.close().catch(()=>{}); await browser.close().catch(()=>{}); }

console.log(fail === 0 ? '\nall relay checks passed' : `\n${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
