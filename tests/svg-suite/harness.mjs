#!/usr/bin/env node
/**
 * SVG conformance harness — resvg test suite.
 *
 * Drives the real editor in a headless browser: for each vendored test it
 * resets to a blank document sized to the SVG viewBox, imports the SVG via the
 * app's own importer (`app.ui.parseSVG`), rasterises the document to PNG at the
 * same scale the reference was rendered at (refWidth / viewBoxWidth), then
 * compares the two images pixel-for-pixel *inside the page* using CanvasKit
 * (both flattened onto white to normalise alpha). No native image deps needed.
 *
 * The editor's importer is lossy by design, so this is a *conformance tracker*,
 * not a pass/fail gate: it records a per-test similarity score and compares the
 * run against a committed baseline. CI fails only on REGRESSIONS (a test that
 * scored well before and now scores worse), never on the large body of
 * features that simply aren't implemented yet.
 *
 * Usage:
 *   node tests/svg-suite/harness.mjs                 # run all, compare to baseline
 *   node tests/svg-suite/harness.mjs --update        # run all, (re)write baseline.json
 *   node tests/svg-suite/harness.mjs --filter shapes # only tests whose path contains "shapes"
 *   node tests/svg-suite/harness.mjs --diff          # write diff PNGs for regressions to report/
 *   node tests/svg-suite/harness.mjs --url http://localhost:5173   # use an already-running dev server
 *
 * Env knobs: PASS_THRESHOLD (default 0.98), REGRESSION_EPS (default 0.02).
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const FIXTURES = join(__dirname, 'fixtures', 'tests');
const BASELINE_PATH = join(__dirname, 'baseline.json');
const REPORT_DIR = join(__dirname, 'report');

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const flagVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const UPDATE = hasFlag('--update');
const WRITE_DIFF = hasFlag('--diff');
const FILTER = flagVal('--filter');
const EXTERNAL_URL = flagVal('--url');
const LIMIT = flagVal('--limit') ? parseInt(flagVal('--limit'), 10) : Infinity;
const PASS_THRESHOLD = parseFloat(process.env.PASS_THRESHOLD ?? '0.98');
const REGRESSION_EPS = parseFloat(process.env.REGRESSION_EPS ?? '0.02');

// ── Discover test files ────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.svg') && existsSync(p.replace(/\.svg$/, '.png'))) out.push(p);
  }
  return out;
}
let tests = walk(FIXTURES).sort();
if (FILTER) tests = tests.filter((p) => relative(FIXTURES, p).includes(FILTER));
tests = tests.slice(0, LIMIT);
if (tests.length === 0) { console.error('No matching tests.'); process.exit(1); }
console.log(`Discovered ${tests.length} test(s).`);

// ── Parse the SVG viewport (used for doc size + render scale) ───────────────
function parseViewport(svgText) {
  // Only read width/height off the <svg> opening tag. A leading \s guard keeps
  // `stroke-width=` (and child-element width/height) from matching.
  const svgTag = (svgText.match(/<svg\b[^>]*>/i) || [''])[0];
  const w = parseFloat((svgTag.match(/(?:^|\s)width\s*=\s*["']([\d.]+)/) || [])[1]);
  const h = parseFloat((svgTag.match(/(?:^|\s)height\s*=\s*["']([\d.]+)/) || [])[1]);
  const vb = svgText.match(/viewBox\s*=\s*["']([^"']+)["']/);
  if (vb) {
    const p = vb[1].trim().split(/[\s,]+/).map(Number);
    if (p.length >= 4 && p[2] > 0 && p[3] > 0) {
      // When explicit width/height define a DIFFERENT aspect ratio than the
      // viewBox, the SVG viewport is width×height and the viewBox is fitted
      // into it via preserveAspectRatio — resvg renders at the viewport size.
      // Keep width/height in that case so the importer applies the fit; the
      // common (matching-aspect) case keeps geometry in viewBox units.
      const hasWH = w > 0 && h > 0;
      const aspectDiffers = hasWH && Math.abs((w / h) - (p[2] / p[3])) > 0.01;
      if (aspectDiffers) return { w, h, hasViewBox: true, keepWH: true };
      return { w: p[2], h: p[3], hasViewBox: true, keepWH: false };
    }
  }
  if (w > 0 && h > 0) return { w, h, hasViewBox: false, keepWH: false };
  return null;
}

// PNG dimensions straight from the IHDR chunk — avoids decoding on the Node side.
function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ── Dev server ──────────────────────────────────────────────────────────────
async function freePort() {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => res(port)); });
  });
}

async function startServer() {
  if (EXTERNAL_URL) return { url: EXTERNAL_URL, stop: async () => {} };
  const port = await freePort();
  const bin = join(REPO, 'node_modules', '.bin', 'vite');
  const proc = spawn(bin, ['--port', String(port), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
  const url = `http://localhost:${port}`;
  // Wait for the server to answer.
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return { url, stop: async () => { proc.kill(); } };
}

// ── In-page: import + rasterise + pixel-diff (runs inside the browser) ───────
// Returns { status, similarity, rmse, refW, refH, outW, outH, scale, error?, diffB64? }.
async function runInPage(page, svgText, refB64, vp, wantDiff) {
  return page.evaluate(async (svgText, refB64, vp, wantDiff) => {
    const app = window.app, ck = app.ck;
    try {
      app.scene.newDocument(vp.w, vp.h);
      // When a viewBox defines the coordinate system, drop width/height so the
      // importer keeps geometry in viewBox units (matching resvg's render).
      let svg = svgText;
      if (vp.hasViewBox && !vp.keepWH) {
        svg = svg.replace(/<svg([^>]*)>/, (m, a) =>
          '<svg' + a.replace(/\s(width|height)\s*=\s*["'][^"']*["']/g, '') + '>');
      }
      await app.ui.parseSVG(svg);

      const refBytes = Uint8Array.from(atob(refB64), (c) => c.charCodeAt(0));
      const refImg = ck.MakeImageFromEncoded(refBytes);
      const refW = refImg.width(), refH = refImg.height();
      const scale = refW / vp.w;

      const blob = app.renderer.exportPNG(scale);
      if (!blob) { refImg.delete(); return { status: 'error', error: 'exportPNG returned null' }; }
      const outBytes = new Uint8Array(await blob.arrayBuffer());
      const outImg = ck.MakeImageFromEncoded(outBytes);
      const outW = outImg.width(), outH = outImg.height();

      const info = (img) => ({
        width: img.width(), height: img.height(),
        colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      });
      const refPx = refImg.readPixels(0, 0, info(refImg));
      const outPx = outImg.readPixels(0, 0, info(outImg));

      const W = Math.min(refW, outW), H = Math.min(refH, outH);
      const maxArea = Math.max(refW, outW) * Math.max(refH, outH);
      const flat = (px, i) => {
        const a = px[i + 3] / 255;
        return [px[i] * a + 255 * (1 - a), px[i + 1] * a + 255 * (1 - a), px[i + 2] * a + 255 * (1 - a)];
      };
      let diffCount = 0, sse = 0;
      let diffData = null;
      if (wantDiff) diffData = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const ir = (y * refW + x) * 4, io = (y * outW + x) * 4;
          const r = flat(refPx, ir), o = flat(outPx, io);
          const d = Math.abs(r[0] - o[0]) + Math.abs(r[1] - o[1]) + Math.abs(r[2] - o[2]);
          sse += (r[0] - o[0]) ** 2 + (r[1] - o[1]) ** 2 + (r[2] - o[2]) ** 2;
          const differs = d > 30;
          if (differs) diffCount++;
          if (diffData) {
            const di = (y * W + x) * 4;
            // magenta where different, faded grey of the reference elsewhere
            if (differs) { diffData[di] = 255; diffData[di + 1] = 0; diffData[di + 2] = 255; diffData[di + 3] = 255; }
            else { const g = (r[0] + r[1] + r[2]) / 3; diffData[di] = diffData[di + 1] = diffData[di + 2] = 128 + g / 2; diffData[di + 3] = 255; }
          }
        }
      }
      // Count non-overlapping area (size mismatch) as fully different.
      const overlap = W * H;
      const total = maxArea;
      const totalDiff = diffCount + (total - overlap);

      let diffB64 = null;
      if (diffData) {
        const surf = ck.MakeSurface(W, H);
        const img2 = ck.MakeImage({ width: W, height: H, colorType: ck.ColorType.RGBA_8888,
          alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }, diffData, W * 4);
        const cv = surf.getCanvas(); cv.drawImage(img2, 0, 0);
        const snap = surf.makeImageSnapshot();
        const enc = snap.encodeToBytes();
        diffB64 = btoa(String.fromCharCode(...enc));
        img2.delete(); snap.delete(); surf.delete();
      }
      refImg.delete(); outImg.delete();
      return {
        status: 'ok', similarity: 1 - totalDiff / total, rmse: Math.sqrt(sse / (overlap * 3)),
        refW, refH, outW, outH, scale, diffB64,
      };
    } catch (e) {
      return { status: 'error', error: String(e && e.message || e) };
    }
  }, svgText, refB64, vp, wantDiff);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const server = await startServer();
console.log(`Dev server: ${server.url}`);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => { /* swallow: per-test try/catch reports real errors */ });

async function loadApp() {
  await page.goto(server.url, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(
    () => window.app && window.app.scene && window.app.scene.engine && window.app.ui && window.app.renderer && window.app.ck,
    { timeout: 30000 });
}
await loadApp();

const results = {};
let done = 0;
const t0 = Date.now();
for (const svgPath of tests) {
  const rel = relative(FIXTURES, svgPath).replace(/\\/g, '/');
  const svgText = readFileSync(svgPath, 'utf8');
  const refBuf = readFileSync(svgPath.replace(/\.svg$/, '.png'));
  const vp = parseViewport(svgText) || { ...pngSize(refBuf), hasViewBox: false };
  const refB64 = refBuf.toString('base64');

  let res;
  try {
    res = await Promise.race([
      runInPage(page, svgText, refB64, vp, WRITE_DIFF),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
    ]);
  } catch (e) {
    res = { status: 'error', error: String(e.message || e) };
    await loadApp(); // recover the page after a hang/crash
  }

  const { diffB64, ...rec } = res;
  results[rel] = rec;
  // Only dump diffs for tests that actually fail — combine with --filter to
  // inspect a specific area without producing a diff for all ~1.7k tests.
  if (WRITE_DIFF && diffB64 && !(rec.status === 'ok' && rec.similarity >= PASS_THRESHOLD)) {
    const outPath = join(REPORT_DIR, 'diffs', rel.replace(/\.svg$/, '.diff.png'));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, Buffer.from(diffB64, 'base64'));
  }

  done++;
  if (done % 50 === 0 || done === tests.length) {
    const pct = ((done / tests.length) * 100).toFixed(0);
    process.stdout.write(`\r  ${done}/${tests.length} (${pct}%)   `);
  }
  // Periodic page reload to keep WASM heap from growing unbounded.
  if (done % 400 === 0) await loadApp();
}
process.stdout.write('\n');
await browser.close();
await server.stop();

// ── Aggregate + report ────────────────────────────────────────────────────
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
const cats = {};
let sumSim = 0, okCount = 0, errCount = 0, passCount = 0;
for (const [rel, r] of Object.entries(results)) {
  const cat = rel.split('/')[0];
  cats[cat] ??= { n: 0, sum: 0, pass: 0, err: 0 };
  cats[cat].n++;
  if (r.status === 'ok') {
    okCount++; sumSim += r.similarity; cats[cat].sum += r.similarity;
    if (r.similarity >= PASS_THRESHOLD) { passCount++; cats[cat].pass++; }
  } else { errCount++; cats[cat].err++; }
}
mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(join(REPORT_DIR, 'results.json'),
  JSON.stringify({ meta: { when: new Date().toISOString(), tests: tests.length, elapsed, PASS_THRESHOLD }, results }, null, 2));

console.log(`\n── SVG conformance (resvg suite) ──  ${elapsed}s`);
console.log(`  passing (≥${PASS_THRESHOLD}): ${passCount}/${tests.length}` +
  `   mean similarity: ${(sumSim / Math.max(okCount, 1)).toFixed(4)}   errors: ${errCount}`);
console.log('  by category:');
for (const [cat, c] of Object.entries(cats).sort()) {
  console.log(`    ${cat.padEnd(14)} pass ${String(c.pass).padStart(4)}/${String(c.n).padStart(4)}` +
    `   mean ${(c.sum / Math.max(c.n - c.err, 1)).toFixed(3)}${c.err ? `   err ${c.err}` : ''}`);
}

// ── Baseline: update or gate on regressions ────────────────────────────────
if (UPDATE) {
  const baseline = {};
  for (const [rel, r] of Object.entries(results)) baseline[rel] = r.status === 'ok' ? +r.similarity.toFixed(4) : null;
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 0).replace(/,/g, ',\n') + '\n');
  console.log(`\n✔ baseline.json written (${Object.keys(baseline).length} entries).`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.log('\n⚠ No baseline.json — run with --update to create one. Skipping regression gate.');
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
// A regression is a test that was PASSING in the baseline (>= PASS_THRESHOLD)
// and has now clearly broken (dropped below the threshold by more than the
// noise margin). We deliberately do NOT gate on movement within the large body
// of already-failing tests: several of those (patterns, filters) are rendered
// through async/AA paths that jitter run-to-run, and gating them would produce
// false failures. Progress on failing tests shows up in the pass count / mean.
const regressions = [];
for (const [rel, r] of Object.entries(results)) {
  const base = baseline[rel];
  if (base == null || base < PASS_THRESHOLD) continue; // only guard known-good tests
  const cur = r.status === 'ok' ? r.similarity : 0;
  if (cur < PASS_THRESHOLD - REGRESSION_EPS) regressions.push({ rel, base, cur: +cur.toFixed(4) });
}
regressions.sort((a, b) => (a.base - a.cur) - (b.base - b.cur));
if (regressions.length) {
  console.log(`\n✗ ${regressions.length} REGRESSION(S) (dropped >${REGRESSION_EPS} below baseline):`);
  for (const g of regressions.slice(0, 40)) console.log(`    ${g.base.toFixed(3)} → ${g.cur.toFixed(3)}   ${g.rel}`);
  if (regressions.length > 40) console.log(`    …and ${regressions.length - 40} more`);
  process.exit(1);
}
console.log('\n✔ No regressions vs baseline.');
process.exit(0);
