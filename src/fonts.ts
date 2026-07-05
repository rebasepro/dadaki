/**
 * Font loading system for the vector editor.
 * Loads Google Fonts dynamically and registers them with CanvasKit.
 */
import type { CanvasKit } from 'canvaskit-wasm';

/** Curated list of available Google Fonts. */
export const GOOGLE_FONTS = [
    'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito',
    'Playfair Display', 'Merriweather', 'Lora', 'PT Serif',
    'JetBrains Mono', 'Fira Code', 'Source Code Pro',
    'Bebas Neue', 'Oswald', 'Raleway',
];

/** Cache of loaded font ArrayBuffers. */
const fontDataCache = new Map<string, ArrayBuffer>();

/** Set of fonts currently being loaded (to avoid duplicate fetches). */
const loadingFonts = new Set<string>();

/** Callbacks to invoke when a font finishes loading. */
const fontLoadCallbacks: Array<() => void> = [];

/**
 * Register a callback that fires whenever a new font finishes loading.
 * The renderer uses this to trigger a repaint.
 */
export function onFontLoaded(cb: () => void) {
    fontLoadCallbacks.push(cb);
}

/**
 * Ensure a Google Font CSS link is added to the document head
 * (so the inline text editor uses the correct font).
 */
export function ensureFontCSS(fontFamily: string) {
    const linkId = `gfont-${fontFamily.replace(/\s+/g, '-')}`;
    if (document.getElementById(linkId)) return;
    const link = document.createElement('link');
    link.id = linkId;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}:wght@400;700&display=swap`;
    document.head.appendChild(link);
}

/**
 * Load a Google Font's binary data (for CanvasKit registration).
 * Fetches the CSS, extracts the font file URL, downloads it.
 * Returns the ArrayBuffer, or null if loading fails.
 */
export async function loadGoogleFontData(fontFamily: string): Promise<ArrayBuffer | null> {
    if (fontDataCache.has(fontFamily)) return fontDataCache.get(fontFamily)!;
    if (loadingFonts.has(fontFamily)) return null; // already in progress

    loadingFonts.add(fontFamily);
    ensureFontCSS(fontFamily);

    try {
        // Fetch the Google Fonts CSS to discover the font file URL.
        // The browser sends its own User-Agent, which determines the file format.
        const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}:wght@400`;
        const cssResp = await fetch(cssUrl);
        if (!cssResp.ok) throw new Error(`CSS fetch failed: ${cssResp.status}`);
        const css = await cssResp.text();

        // Extract the first src url(...) from the @font-face rule
        const urlMatch = css.match(/src:\s*url\(([^)]+)\)/);
        if (!urlMatch) throw new Error('No font URL found in CSS');

        const fontUrl = urlMatch[1];
        const fontResp = await fetch(fontUrl);
        if (!fontResp.ok) throw new Error(`Font fetch failed: ${fontResp.status}`);
        const fontData = await fontResp.arrayBuffer();

        fontDataCache.set(fontFamily, fontData);
        loadingFonts.delete(fontFamily);

        // Notify listeners
        for (const cb of fontLoadCallbacks) cb();

        return fontData;
    } catch (err) {
        console.warn(`[fonts] Failed to load "${fontFamily}":`, err);
        loadingFonts.delete(fontFamily);
        return null;
    }
}

/**
 * Build a CanvasKit TypefaceFontProvider with all currently loaded fonts.
 * Returns null if no custom fonts have been loaded yet.
 */
export function buildFontProvider(ck: CanvasKit): ReturnType<CanvasKit['TypefaceFontProvider']['Make']> | null {
    if (fontDataCache.size === 0) return null;
    const provider = ck.TypefaceFontProvider.Make();
    for (const [name, data] of fontDataCache) {
        provider.registerFont(data, name);
    }
    return provider;
}

/** Check if a font's binary data is already cached. */
export function isFontLoaded(fontFamily: string): boolean {
    return fontDataCache.has(fontFamily);
}

/** Get cached font data (or null). */
export function getFontData(fontFamily: string): ArrayBuffer | null {
    return fontDataCache.get(fontFamily) ?? null;
}
