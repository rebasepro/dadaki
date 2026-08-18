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

    // Overlapping circles and a fan of lines: every region below is a face the
    // arrangement found, not a shape someone drew.
    const ids = [];
    const circles = [
        [420, 330, 190], [610, 330, 190], [515, 470, 190], [515, 190, 150],
    ];
    for (const [cx, cy, r] of circles) ids.push(e.add_ellipse(cx, cy, r, r));
    for (const [x1, y1, x2, y2] of [
        [180, 250, 860, 250], [180, 420, 860, 420], [340, 60, 340, 640], [700, 60, 700, 640],
    ]) {
        ids.push(e.add_path(JSON.stringify([{
            closed: false,
            points: [
                { x: x1, y: y1, cp1: [x1, y1], cp2: [x1, y1] },
                { x: x2, y: y2, cp1: [x2, y2], cp2: [x2, y2] },
            ],
        }])));
    }
    for (const id of ids) {
        e.set_node_style(id, JSON.stringify({
            fills: [], strokes: [{ color: { r: 0.07, g: 0.07, b: 0.09, a: 1 }, width: 1.5,
                dash_array: [], dash_offset: 0, miter_limit: 4, alignment: 'Center' }],
            opacity: 1, blend_mode: 0, fill_rule: 0, corner_radius: 0, effects: [],
        }));
    }

    const group = e.group_nodes(JSON.stringify(ids));
    e.set_node_live_paint(group, true);
    e.set_live_paint_group(group);

    // A palette that agrees with the banner rather than a random wheel.
    const palette = [
        [0.231, 0.510, 0.965], [0.925, 0.282, 0.600], [0.976, 0.694, 0.259],
        [0.024, 0.714, 0.831], [0.545, 0.361, 0.965], [0.180, 0.800, 0.443],
        [0.937, 0.267, 0.267], [0.373, 0.647, 0.980], [0.988, 0.459, 0.220],
    ];
    const seen = new Set();
    let n = 0;
    for (let i = 0; i < 220; i++) {
        for (let j = 0; j < 220; j++) {
            const x = 150 + (760 * (i + 0.5)) / 220;
            const y = 40 + (620 * (j + 0.5)) / 220;
            const fid = e.query_face_at(x, y);
            if (fid == null || fid < 0 || seen.has(fid)) continue;
            seen.add(fid);
            // Leave a few unpainted, so the drawing reads as artwork rather
            // than a colour test chart.
            if (n % 4 !== 3) {
                const c = palette[n % palette.length];
                e.set_face_paint(fid, JSON.stringify({ r: c[0], g: c[1], b: c[2], a: 1 }));
            }
            n++;
        }
    }

    // Select the group so the properties panel has something in it. An empty
    // inspector beside finished artwork reads as a screenshot taken before the
    // work started, which is the opposite of what this image is for.
    e.select_node(group, false);
    window.app.ui.syncWithSelection?.();
    window.app.ui.updateLayerList?.();

    const r = window.app.renderer;
    const canvas = document.querySelector('canvas');
    const z = 0.78;
    r.zoom = z;
    // Nudged down-right of centre: the artboard's name label sits ABOVE its top
    // edge, and dead-centring the artwork slid that label under the ruler.
    r.pan = { x: canvas.clientWidth / 2 - 515 * z, y: canvas.clientHeight / 2 - 300 * z };
    r.requestRender?.();
});

await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: OUT });
await browser.close();
console.log('captured', OUT);
