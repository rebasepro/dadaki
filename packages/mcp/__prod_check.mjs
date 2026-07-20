import { createServer as netServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import puppeteer from 'puppeteer';

const SITE = 'https://dadaki.apps.rebase.pro/edit/new/blank';
const SERVER = '/Users/francesco/vector-editor/packages/mcp/src/index.ts';
const TOKEN = 'prod-verify-token';
const freePort = async () => { const s=netServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(()=>r())); return p; };
const bridgePort = await freePort();          // never 7331

const client = new Client({ name:'prod-verify', version:'1' });
const browser = await puppeteer.launch({headless:true,args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
let fail=0; const check=(l,ok,d)=>{ok?console.log(`  ok  ${l}`):(fail++,console.error(`FAIL  ${l}`,d??''));};
const call = async (n,a={}) => { const r = await client.callTool({name:n,arguments:a}); const t=(r.content)[0]?.text??''; if(r.isError) throw new Error(t); return JSON.parse(t); };

try {
  await client.connect(new StdioClientTransport({command:process.execPath,
    args:['--experimental-strip-types',SERVER,'--mode','bridge','--port',String(bridgePort),'--token',TOKEN]}));

  const plain = await browser.newPage();
  await plain.goto(SITE,{waitUntil:'load'});
  await new Promise(r=>setTimeout(r,9000));
  const ps = JSON.parse(await plain.evaluate('JSON.stringify({app:typeof window.app,canvas:!!document.querySelector("#editor-canvas")})'));
  check('production editor mounts for an ordinary visitor', ps.canvas, ps);
  check('NO agent handle without credentials (gate live)', ps.app==='undefined', ps);
  await plain.close();

  const att = await browser.newPage();
  await att.goto(`${SITE}?agentBridge=${bridgePort}&token=${TOKEN}`,{waitUntil:'load'});
  await att.waitForFunction('Boolean(window.app && window.app.agent)',{timeout:90000});
  await new Promise(r=>setTimeout(r,3000));
  const as = JSON.parse(await att.evaluate('JSON.stringify({badge:document.querySelectorAll(".agent-badge").length,url:location.search})'));
  check('token stripped from the address bar', !String(as.url).includes(TOKEN), as.url);
  check('"Agent connected" badge visible', as.badge===1, as);

  const rect = await call('create_rect',{x:60,y:60,width:220,height:140,style:{fill:'#00a2ff'}});
  check('MCP call reaches the PRODUCTION editor', typeof rect.id==='number', rect);
  const inPage = JSON.parse(await att.evaluate('JSON.stringify(window.app.agent.describe())').catch(()=>'null')) ?? await att.evaluate('window.app.agent.describe()');
  const scene = inPage instanceof Promise ? await inPage : inPage;
  check('the edit landed in that production tab', (scene.nodes||[]).length===1, scene.nodes?.length);
} catch(e){ fail++; console.error('FAIL unexpected:', e.message); }
finally { await client.close().catch(()=>{}); await browser.close().catch(()=>{}); }
console.log(fail===0?'\nall production checks passed':`\n${fail} failed`);
process.exit(fail===0?0:1);
