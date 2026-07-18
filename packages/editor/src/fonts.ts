/**
 * Font loading system for the vector editor.
 * Loads Google Fonts dynamically and registers them with CanvasKit.
 */
import type { CanvasKit } from 'canvaskit-wasm';

/**
 * Family assigned to newly created text. Needed because CanvasKit's RefDefault
 * typeface is not a sans-serif, so text created with an empty family renders in
 * a font that doesn't match the HTML edit overlay's `sans-serif` preview. Using
 * a concrete, loadable family makes the preview and the committed node agree.
 */
export const DEFAULT_TEXT_FONT = 'Inter';

/** Curated list of available Google Fonts. */
export const GOOGLE_FONTS = [
    'Inter',
    'Roboto',
    'Open Sans',
    'Lato',
    'Montserrat',
    'Poppins',
    'Nunito',
    'Playfair Display',
    'Merriweather',
    'Lora',
    'PT Serif',
    'JetBrains Mono',
    'Fira Code',
    'Source Code Pro',
    'Bebas Neue',
    'Oswald',
    'Raleway',
];

/**
 * The faces of one family. Named rather than positional: these used to be a
 * bare array indexed 0 = regular, 1 = bold, which silently mis-selects as soon
 * as a family publishes some faces but not others.
 */
export interface FontFaces {
    regular: ArrayBuffer;
    bold: ArrayBuffer | null;
    italic: ArrayBuffer | null;
    boldItalic: ArrayBuffer | null;
}

/** Cache of loaded faces per family. */
const fontDataCache = new Map<string, FontFaces>();

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
    if (fontDataCache.has(fontFamily)) return fontDataCache.get(fontFamily)!.regular;
    if (loadingFonts.has(fontFamily)) return null; // already in progress

    loadingFonts.add(fontFamily);
    ensureFontCSS(fontFamily); // still needed for the HTML edit overlay (woff2 is fine there)

    try {
        // Fetch raw TTFs, NOT the Google Fonts CSS: for a modern browser
        // User-Agent that CSS resolves to woff2, which CanvasKit/FreeType can't
        // decode (renders tofu). The fontsource CDN serves plain TTF that
        // CanvasKit registers correctly. Grab regular (400) and bold (700).
        const id = fontsourceId(fontFamily);
        const url = (w: number, style: 'normal' | 'italic') =>
            `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${w}-${style}.ttf`;
        const fetchTtf = async (
            w: number,
            style: 'normal' | 'italic',
        ): Promise<ArrayBuffer | null> => {
            try {
                const resp = await fetch(url(w, style));
                return resp.ok ? await resp.arrayBuffer() : null;
            } catch {
                return null;
            }
        };
        // Italic faces are fetched too: the renderer asks the paragraph API for
        // a slant, and without an italic face registered there is nothing for
        // it to select, so `italic: true` silently renders upright. Not every
        // family publishes one (Bebas Neue, for instance), hence the nulls.
        const [regular, bold, italic, boldItalic] = await Promise.all([
            fetchTtf(400, 'normal'),
            fetchTtf(700, 'normal'),
            fetchTtf(400, 'italic'),
            fetchTtf(700, 'italic'),
        ]);
        if (!regular) throw new Error('no TTF for regular weight');

        fontDataCache.set(fontFamily, { regular, bold, italic, boldItalic });
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
export function buildFontProvider(
    ck: CanvasKit,
): ReturnType<CanvasKit['TypefaceFontProvider']['Make']> | null {
    if (fontDataCache.size === 0) return null;
    const provider = ck.TypefaceFontProvider.Make();
    for (const [name, faces] of fontDataCache) {
        // All faces register under the SAME family name; the paragraph API
        // picks between them using each face's own weight/slant metadata.
        for (const data of [faces.regular, faces.bold, faces.italic, faces.boldItalic]) {
            if (data) provider.registerFont(data, name);
        }
    }
    return provider;
}

/**
 * Resolve once no font load is in flight.
 *
 * Font loading is async, but an agent's loop is create-then-render with no
 * pause in between — so without this, the first render after adding text
 * always shows the fallback face, and an agent judging its own work from that
 * image draws the wrong conclusion about weight and shape. Rendering awaits
 * this; interactive use doesn't need to, because a human's next frame comes
 * long after the fetch.
 *
 * Waits are bounded: a family that 404s or a machine that is offline must
 * degrade to the fallback face, not hang the render.
 */
export async function fontsSettled(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (loadingFonts.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** Check if a font's binary data is already cached. */
export function isFontLoaded(fontFamily: string): boolean {
    return fontDataCache.has(fontFamily);
}

/** Get cached font data — the regular weight (or null). */
export function getFontData(fontFamily: string): ArrayBuffer | null {
    return fontDataCache.get(fontFamily)?.regular ?? null;
}

/** Get cached font data for a weight/slant, falling back to the nearest face
 *  the family actually publishes. Null if the family isn't loaded. */
export function getFontDataForWeight(
    fontFamily: string,
    weight: number,
    italic = false,
): ArrayBuffer | null {
    const faces = fontDataCache.get(fontFamily);
    if (!faces) return null;
    const wantBold = weight >= 600;
    if (wantBold && italic) return faces.boldItalic ?? faces.bold ?? faces.italic ?? faces.regular;
    if (wantBold) return faces.bold ?? faces.regular;
    if (italic) return faces.italic ?? faces.regular;
    return faces.regular;
}
