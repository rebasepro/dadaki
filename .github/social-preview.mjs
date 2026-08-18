// Regenerate the repository's social preview card (Settings → Social preview).
//
//     node .github/social-preview.mjs
//
// Kept in the repo because the card embeds the product's own mark and typeface:
// when either changes, this is what re-renders it rather than someone matching
// the old one by eye in a design tool.
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';

const ROOT = '/Users/francesco/dadaki-vector-editor';
const b64 = (p, mime) => `data:${mime};base64,${readFileSync(p).toString('base64')}`;

// Inline the real assets: the mark the app ships as its icon, and Inter, the
// UI's own typeface. A card drawn with substitutes is a card that does not
// match the product.
const html = readFileSync(new URL('social-preview.html', import.meta.url), 'utf8')
    .replace('MARK_URL', b64(`${ROOT}/cloud/frontend/public/logo-mark.svg`, 'image/svg+xml'))
    .replace('INTER_URL', b64(`${ROOT}/packages/app/public/Inter.ttf`, 'font/ttf'));

const CARDS = [
    { html: 'social-preview.html', png: 'social-preview.png', h: 640 },
    { html: 'readme-banner.html', png: 'readme-banner.png', h: 440 },
];

const browser = await puppeteer.launch({
    // The system Chrome: puppeteer's own download is not present, and the
    // card only needs a compositor, not a pinned build.
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
for (const card of CARDS) {
    const page = await browser.newPage();
    const markup = readFileSync(new URL(card.html, import.meta.url), 'utf8')
        .replace('MARK_URL', b64(`${ROOT}/cloud/frontend/public/logo-mark.svg`, 'image/svg+xml'))
        .replace('INTER_URL', b64(`${ROOT}/packages/app/public/Inter.ttf`, 'font/ttf'));
    await page.setViewport({ width: 1280, height: card.h, deviceScaleFactor: 1 });
    await page.setContent(markup, { waitUntil: 'networkidle0' });
    await page.evaluateHandle('document.fonts.ready');
    await page.screenshot({ path: new URL(card.png, import.meta.url).pathname });
}
await browser.close();
console.log('done');
