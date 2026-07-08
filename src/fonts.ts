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

/** Cache of loaded font ArrayBuffers per family (regular + bold TTFs). */
const fontDataCache = new Map<string, ArrayBuffer[]>();

/** Google Fonts family name → fontsource CDN id (lowercase, hyphenated). */
function fontsourceId(fontFamily: string): string {
    return fontFamily.toLowerCase().replace(/\s+/g, '-');
}

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
    if (fontDataCache.has(fontFamily)) return fontDataCache.get(fontFamily)![0] ?? null;
    if (loadingFonts.has(fontFamily)) return null; // already in progress

    loadingFonts.add(fontFamily);
    ensureFontCSS(fontFamily); // still needed for the HTML edit overlay (woff2 is fine there)

    try {
        // Fetch raw TTFs, NOT the Google Fonts CSS: for a modern browser
        // User-Agent that CSS resolves to woff2, which CanvasKit/FreeType can't
        // decode (renders tofu). The fontsource CDN serves plain TTF that
        // CanvasKit registers correctly. Grab regular (400) and bold (700).
        const id = fontsourceId(fontFamily);
        const url = (w: number) => `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${w}-normal.ttf`;
        const fetchTtf = async (w: number): Promise<ArrayBuffer | null> => {
            try {
                const resp = await fetch(url(w));
                return resp.ok ? await resp.arrayBuffer() : null;
            } catch { return null; }
        };
        const [regular, bold] = await Promise.all([fetchTtf(400), fetchTtf(700)]);
        if (!regular) throw new Error('no TTF for regular weight');
        const buffers = bold ? [regular, bold] : [regular];

        fontDataCache.set(fontFamily, buffers);
        loadingFonts.delete(fontFamily);

        // Notify listeners (renderer repaints)
        for (const cb of fontLoadCallbacks) cb();

        return regular;
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
    for (const [name, buffers] of fontDataCache) {
        for (const data of buffers) provider.registerFont(data, name);
    }
    return provider;
}

/** Check if a font's binary data is already cached. */
export function isFontLoaded(fontFamily: string): boolean {
    return fontDataCache.has(fontFamily);
}

/** Get cached font data — the regular weight (or null). */
export function getFontData(fontFamily: string): ArrayBuffer | null {
    return fontDataCache.get(fontFamily)?.[0] ?? null;
}
