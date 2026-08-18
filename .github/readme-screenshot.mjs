// Capture the README screenshot from the REAL editor, running locally.
//
//     pnpm dev            # packages/app on :5199
//     node .github/readme-screenshot.mjs
//
// A screenshot is the one image in a README that cannot be faked without it
// becoming a lie, so this drives the actual application: it builds a small
// composition through the engine's own verbs, paints the regions with the Live
// Paint bucket, and photographs the window.
import puppeteer from 'puppeteer';

const OUT = new URL('screenshot.png', import.meta.url).pathname;

const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--force-device-scale-factor=2', '--hide-scrollbars'],
});
const page = await browser.newPage();
// 2× so the panels and type are crisp on a retina display, where a 1× capture
// of a UI reads as blurry.
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await page.goto('http://localhost:5199', { waitUntil: 'networkidle0' });
await page.waitForFunction('!!window.app?.scene?.engine', { timeout: 60000 });

await page.evaluate(() => {
    const e = window.app.scene.engine;
    const ids = [];
    const stroke = (id, w = 2) => e.set_node_style(id, JSON.stringify({
        fills: [], strokes: [{ color: { r: 0.05, g: 0.05, b: 0.07, a: 1 }, width: w,
            dash_array: [], dash_offset: 0, miter_limit: 4, alignment: 'Center' }],
        opacity: 1, blend_mode: 0, fill_rule: 0, corner_radius: 0, effects: [],
    }));
    const line = (pts, closed = false) => {
        const id = e.add_path(JSON.stringify([{ closed, points: pts.map(([x, y]) => ({ x, y, cp1: [x, y], cp2: [x, y] })) }]));
        ids.push(id); stroke(id); return id;
    };

    // A landscape, drawn the way this editor wants to be used: nothing here is
    // a filled shape. It is a frame, a sun, some ridges and some water lines —
    // every colour below is a region the arrangement finds between them.
    const W = 980, H = 660, HORIZON = 400;
    line([[0, 0], [W, 0], [W, H], [0, H]], true);            // frame
    ids.push(e.add_ellipse(470, 250, 130, 130));             // sun
    stroke(ids[ids.length - 1]);
    line([[0, HORIZON], [W, HORIZON]]);                      // horizon

    // Rays: they cut the sky into wedges, which is where the graded colour goes.
    // Each one stops ON the frame — a ray running past it would leave the
    // drawing, and the region it was meant to divide would never close.
    const toEdge = (ox, oy, dx, dy) => {
        let best = Infinity;
        for (const [d, o, lo, hi] of [[dx, ox, 0, W], [dy, oy, 0, H]]) {
            if (Math.abs(d) < 1e-9) continue;
            for (const bound of [lo, hi]) {
                const s = (bound - o) / d;
                if (s > 1e-6 && s < best) best = s;
            }
        }
        return [ox + dx * best, oy + dy * best];
    };
    for (let a = -80; a <= 80; a += 16) {
        const t = (a * Math.PI) / 180;
        line([[470, 250], toEdge(470, 250, Math.sin(t), -Math.cos(t))]);
    }
    // Ridges, back to front.
    line([[0, 336], [120, 250], [260, 330], [400, 235], [520, 330], [660, 245], [800, 330], [W, 268]]);
    line([[0, HORIZON], [150, 305], [330, HORIZON], [470, 320], [640, HORIZON], [820, 300], [W, HORIZON]]);
    // Water: bands plus a reflection column under the sun.
    for (const y of [430, 465, 505, 550, 600]) line([[0, y], [W, y]]);
    line([[400, HORIZON], [370, H]]);
    line([[540, HORIZON], [575, H]]);

    const group = e.group_nodes(JSON.stringify(ids));
    e.set_node_live_paint(group, true);
    e.set_live_paint_group(group);

    // Colour by POSITION, not by cycling a palette: the sky warms as it falls
    // toward the horizon, the water cools as it comes forward. A ramp is what
    // makes a set of flat regions read as a picture.
    const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    const seen = new Set();
    for (let i = 0; i < 260; i++) {
        for (let j = 0; j < 260; j++) {
            const x = 4 + (W - 8) * (i + 0.5) / 260;
            const y = 4 + (H - 8) * (j + 0.5) / 260;
            const fid = e.query_face_at(x, y);
            if (fid == null || fid < 0 || seen.has(fid)) continue;
            seen.add(fid);
            const b = String(e.face_bounds(fid)).split(',').map(Number);
            const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
            const inSun = Math.hypot(cx - 470, cy - 250) < 130;
            let c;
            if (inSun) {
                c = mix([1.0, 0.85, 0.35], [0.99, 0.55, 0.24], (cy - 120) / 260);
            } else if (cy < HORIZON) {
                const t = Math.min(1, Math.max(0, cy / HORIZON));
                c = t < 0.55
                    ? mix([0.25, 0.20, 0.50], [0.86, 0.35, 0.45], t / 0.55)
                    : mix([0.86, 0.35, 0.45], [0.98, 0.68, 0.35], (t - 0.55) / 0.45);
            } else {
                const t = Math.min(1, Math.max(0, (cy - HORIZON) / (H - HORIZON)));
                c = mix([0.13, 0.33, 0.58], [0.05, 0.13, 0.30], t);
            }
            e.set_face_paint(fid, JSON.stringify({ r: c[0], g: c[1], b: c[2], a: 1 }));
        }
    }

    // The artboard is the drawing's own size. Left at its default the picture
    // sits on the top half of a square page and half the screenshot is blank.
    // Done last: the paint pass above walks the canvas, and resizing the page
    // under it first only moves the sampling around.
    const board = JSON.parse(e.get_artboards_json?.() ?? '[]')[0];
    if (board) e.set_artboard_bounds(board.id, 0, 0, W, H);
    window.app.scene.invalidateCache?.();

    e.select_node(group, false);
    window.app.ui.syncWithSelection?.();
    window.app.ui.updateLayerList?.();

    // Frame the ARTWORK, not the artboard: the drawing occupies the top of a
    // 1000-square canvas, and centring the canvas puts half a page of white in
    // the photograph.
    const r = window.app.renderer;
    const canvas = document.querySelector('canvas');
    const z = Math.min((canvas.clientWidth - 260) / W, (canvas.clientHeight - 200) / H);
    r.zoom = z;
    r.pan = { x: canvas.clientWidth / 2 - (W / 2) * z, y: canvas.clientHeight / 2 - (H / 2) * z };
    r.requestRender?.();
});

await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: OUT });
await browser.close();
console.log('captured', OUT);
