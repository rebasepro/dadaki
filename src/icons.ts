/**
 * Inline Lucide icon SVG helper.
 *
 * Returns raw `<svg>…</svg>` strings sized for the context they appear in.
 * All icons come from the Lucide icon set (https://lucide.dev) to match
 * the toolbar icons already loaded via the CDN.
 *
 * By generating SVG strings we can drop them into `innerHTML` and
 * `textContent` sites where the old emoji characters were used,
 * without needing React or a DOM-diffing library.
 */

// ─── SVG wrapper ─────────────────────────────────────────────────
function svg(inner: string, size: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;">${inner}</svg>`;
}

// ─── Lucide icon paths ───────────────────────────────────────────

/** Folder icon – for Group nodes in the layer panel */
export function iconFolder(size = 14): string {
    return svg(
        '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
        size,
    );
}

/** Square icon – for Rect nodes */
export function iconSquare(size = 14): string {
    return svg(
        '<rect width="18" height="18" x="3" y="3" rx="2"/>',
        size,
    );
}

/** Circle icon – for Ellipse nodes */
export function iconCircle(size = 14): string {
    return svg(
        '<circle cx="12" cy="12" r="10"/>',
        size,
    );
}

/** Pen-tool icon – for Path nodes */
export function iconPenTool(size = 14): string {
    return svg(
        '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
        size,
    );
}

/** Type icon – for Text nodes */
export function iconType(size = 14): string {
    return svg(
        '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
        size,
    );
}

/** Hexagon icon – generic shape fallback */
export function iconHexagon(size = 14): string {
    return svg(
        '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
        size,
    );
}

/** Eye icon – visible layer */
export function iconEye(size = 12): string {
    return svg(
        '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
        size,
    );
}

/** Eye-off icon – hidden layer */
export function iconEyeOff(size = 12): string {
    return svg(
        '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
        size,
    );
}

/** Lock icon – locked layer */
export function iconLock(size = 12): string {
    return svg(
        '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        size,
    );
}

/** Undo icon */
export function iconUndo(size = 14): string {
    return svg(
        '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
        size,
    );
}

/** Redo icon */
export function iconRedo(size = 14): string {
    return svg(
        '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
        size,
    );
}

/** Pencil / edit icon – for Edit Path */
export function iconPencil(size = 14): string {
    return svg(
        '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
        size,
    );
}

/** Trash icon – for Delete actions */
export function iconTrash(size = 14): string {
    return svg(
        '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
        size,
    );
}
