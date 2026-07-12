import type { Canvas, CanvasKit, Paint, Path, Surface } from 'canvaskit-wasm';

/** A Live Paint outline point: anchor + incoming/outgoing bézier handles. */
type OutlinePt = { x: number; y: number; cp1: number[]; cp2: number[] };

import { adaptiveTileSources, maxTileScale, rasterizeAdaptiveTile } from './adaptive_tiles';
import { appendSubpathsToPath, invertAffine, nodeToWorldPath } from './boolean_ops';
import {
    buildFontProvider,
    getFontData,
    isFontLoaded,
    loadGoogleFontData,
    onFontLoaded,
} from './fonts';

/** Helper for efficient zero-copy parsing of the WASM binary render buffer. */
class BinaryReader {
    view: DataView;
    offset: number = 0;
    private decoder = new TextDecoder();

    constructor(view: DataView) {
        this.view = view;
    }

    u8() {
        const v = this.view.getUint8(this.offset);
        this.offset += 1;
        return v;
    }
    u16() {
        const v = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return v;
    }
    u32() {
        const v = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return v;
    }
    f32() {
        const v = this.view.getFloat32(this.offset, true);
        this.offset += 4;
        return v;
    }

    f32Array(n: number): Float32Array {
        // The protocol keeps every field 4-byte aligned relative to the buffer
        // start, so a zero-copy view works whenever the WASM allocation itself
        // is 4-byte aligned (true in practice, but not guaranteed for Vec<u8>).
        const byteOffset = this.view.byteOffset + this.offset;
        this.offset += n * 4;
        if (byteOffset % 4 === 0) {
            return new Float32Array(this.view.buffer, byteOffset, n);
        }
        const arr = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            arr[i] = this.view.getFloat32(byteOffset + i * 4, true);
        }
        return arr;
    }

    string(): string {
        const len = this.u32();
        const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
        this.offset += len;
        // Align to 4 bytes
        this.offset = (this.offset + 3) & ~3;
        return this.decoder.decode(bytes);
    }
}

import type { InputManager } from './input';
import type { Artboard } from './types';
import type { WasmScene } from './wasm_scene';

/** Resize-handle direction for an artboard. */
export type ArtboardHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

// Render protocol (see engine/src/lib.rs "Render Protocol"). These MUST match
// the RENDER_PROTOCOL_MAGIC / RENDER_PROTOCOL_VERSION constants the engine emits.
// Bump EXPECTED_RENDER_PROTOCOL_VERSION here in lockstep with any change to the
// render-buffer layout on either side; a mismatch means engine/pkg is stale
// (rebuild wasm) or renderer.ts is out of date.
const RENDER_PROTOCOL_MAGIC = 0x31434556; // ASCII "VEC1", little-endian
const EXPECTED_RENDER_PROTOCOL_VERSION = 11; // v11: anisotropic blur + elliptical-radial gradient transform

/** One decoded effect record from the render buffer. */
interface EffectRecord {
    kind: number; // 0 = blur, 1 = drop shadow, 2 = color matrix
    radius: number;
    radiusY: number; // kind 0: y-axis blur sigma (anisotropic); = radius when isotropic
    dx: number;
    dy: number;
    r: number;
    g: number;
    b: number;
    a: number;
    matrix?: number[]; // 20 floats, for kind 2
    linearRGB?: boolean; // for kind 2: apply matrix in linearRGB space
}

export class Renderer {
    /** Local-space bounding box of a text node's rendered glyphs, used for the
     *  selection frame. Measures with the Font glyph-width API (getGlyphPaths
     *  isn't available in this build). Falls back to an em-based estimate. */
    getTextLocalBounds(id: number): { x: number; y: number; w: number; h: number } | null {
        const node = this.scene.getNode(id);
        if (!node?.geometry.Text) return null;
        const geo = node.geometry.Text;
        const fontSize = geo.font_size;
        const lineHeight = geo.line_height || 1.2;
        const lines = (geo.content || '').split('\n');
        let width = 0;
        try {
            const font = new this.ck.Font(null, fontSize);
            for (const line of lines) {
                if (!line) continue;
                const widths = font.getGlyphWidths(font.getGlyphIDs(line));
                let w = 0;
                for (let k = 0; k < widths.length; k++) w += widths[k];
                if (w > width) width = w;
            }
            font.delete();
        } catch {
            width = 0;
        }
        if (width <= 0) width = Math.max(1, geo.content.length) * fontSize * 0.6;
        const h = fontSize + (lines.length - 1) * fontSize * lineHeight;
        // Alignment anchors the text around the origin (center → -w/2, right → -w).
        const offsetX = geo.text_align === 1 ? -width / 2 : geo.text_align === 2 ? -width : 0;
        return { x: offsetX, y: -fontSize, w: width, h };
    }

    ck: CanvasKit;
    canvas: HTMLCanvasElement;
    scene: WasmScene;
    surface: Surface | null;
    // CanvasKit WebGL context handles — typed as `number` (opaque GL context IDs)
    private glContext: number = 0;
    private grContext: unknown = null;
    isRunning: boolean;
    zoom: number;
    pan: { x: number; y: number };
    inputManager: InputManager | null = null;
    /** Ruler/guide controller — asked to redraw its strips after each frame. */
    guidesController: { syncRulers(): void } | null = null;
    /** Face ID currently being hovered by the paint bucket tool (or -1). */
    hoverFaceId: number = -1;
    hoverEdgeId: number = -1;
    /** UI-level selected artboard (drawn highlighted with resize handles). */
    selectedArtboardId: number | null = null;

    // ─── Cached Resources (avoid per-frame allocation) ───
    private paint: Paint | null = null;

    // ─── Dirty-frame gating ───
    /** When false, the rAF loop skips rendering. Set to true by requestRender(). */
    private _needsRender = true;
    /** One-shot guard so a render-protocol desync logs once, not every frame. */
    private _protocolDesyncWarned = false;
    /** Node id of the text being edited inline (skipped while its overlay is up). */
    editingTextId: number | null = null;
    private get _editingTextId(): number | null {
        return this.editingTextId;
    }
    /** Dedicated SrcIn paint for compositing masked-content layers. */
    private _maskPaint: Paint | null = null;
    /** Stack of open mask spans matching CMD_BEGIN_MASK / CMD_END_MASK nesting.
     *  `mode` is the mask_type (0 = alpha, 1 = luminance, 2 = geometric clip).
     *  For mode 2, `pendingClip` is true until the mask shape's DRAW_NODE has
     *  been captured as a canvas clip; `converted` marks a mode-2 span that
     *  fell back to the alpha saveLayer protocol (mask node wasn't a plain
     *  shape). For modes 0/1, `pendingLayer` is true until the mask/luma
     *  layers have been opened — opening is deferred to the mask shape's
     *  DRAW_NODE record so the layers can be BOUNDED to the mask's geometry
     *  (`bounds`, local to the surrounding group space) instead of allocating
     *  full-viewport textures per masked span. */
    private _maskStack: {
        mode: number;
        pendingClip: boolean;
        pendingLayer: boolean;
        converted: boolean;
        bounds: ReturnType<CanvasKit['LTRBRect']> | null;
    }[] = [];
    /** Dedicated paint with luminance→alpha color filter for luminance masks. */
    private _lumaPaint: Paint | null = null;
    /** True while rendering into an offscreen surface for PNG export. */
    private _exporting = false;
    /** World-space bounds to export (defaults to the primary artboard). */
    private _exportBounds: { x: number; y: number; w: number; h: number } | null = null;
    /** Solid background to fill behind exported content (null = transparent). */
    private _exportBackground: { r: number; g: number; b: number; a: number } | null = null;
    /**
     * True while rendering the supersampled export pass. Fill/stroke anti-aliasing
     * is disabled so adjacent shapes tile perfectly at the supersampled
     * resolution; the final high-quality downscale reintroduces clean edge
     * anti-aliasing (SSAA). This is what removes the hairline "seam" between two
     * abutting fills that a single-sample, per-shape-AA raster leaves behind.
     */
    private _exportNoAA = false;

    // ─── Path object cache (avoid rebuilding CanvasKit paths every frame) ───
    private _pathCache: Map<
        number,
        { path: ReturnType<CanvasKit['Path']['prototype']['copy']>; fillRule: number }
    > = new Map();

    // Geometric-clip paths (mask_type 2), already node-transformed, keyed by
    // node id — building one costs a path copy + transform in wasm, which
    // shows up at 60fps × several clip spans. Invalidated with _pathCache.
    private _clipPathCache: Map<number, { path: Path; key: string }> = new Map();

    /** Typefaces built from loaded font data, for text-on-path RSXform layout. */
    private _typefaceCache = new Map<
        string,
        ReturnType<CanvasKit['Typeface']['MakeFreeTypeFaceFromData']> | null
    >();

    // ─── Drag-layer cache ───
    // Re-recording every node's draw commands is CPU-bound (~12µs/node), so
    // dragging in a large scene can't hit 60fps by caching shaders alone.
    // While a selection of ROOT nodes is dragged, the static rest of the scene
    // is snapshotted once into two GPU textures — content below and content
    // above the moving nodes in z — and each drag frame only blits those and
    // re-records the moving subtree. Built by beginDragLayerCache(), dropped
    // on drag end or any full cache invalidation.
    private _dragLayer: {
        below: NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>> | null;
        above: NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>> | null;
        zoom: number;
        panX: number;
        panY: number;
        dpr: number;
        width: number;
        height: number;
    } | null = null;
    /** Observes the canvas's CSS box so the drawing buffer resyncs on any
     *  layout change, not just window resizes. */
    private _resizeObserver: ResizeObserver | null = null;
    /** Ids (moving roots + full subtrees) re-recorded live during a cached drag. */
    private _dragSubtree: Set<number> | null = null;
    private _dragMovingRoots: number[] = [];
    /** Set while rendering the below/above snapshot passes. */
    private _dragSnapshotPass: 'below' | 'above' | null = null;

    // ─── Group sprite cache ───
    // Command recording is CPU-bound (~12µs/node), so scenes with many heavy
    // groups can't be re-recorded every frame at 60fps. Each big ROOT group is
    // baked once into a GPU texture ("sprite") at the current device scale;
    // frames then draw one image per group instead of its whole subtree.
    // Sprites follow their group's transform (delta vs bake time), re-bake
    // when the zoom settles at a meaningfully different scale, and drop on
    // any content mutation (full invalidation) or a targeted edit inside the
    // group. When the needed on-screen resolution exceeds a sprite's texture
    // cap (deep zoom), the group falls back to direct rendering — few groups
    // are visible then, so direct is cheap.
    private _groupSprites: Map<
        number,
        {
            img: NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>>;
            surface: Surface;
            /** Padded world bounds at bake time. */
            x: number;
            y: number;
            w: number;
            h: number;
            bakeTransform: Float32Array;
            /** Device px per world unit the sprite was baked at. */
            scale: number;
        }
    > = new Map();
    /** Descendant id → cached root id, for stream exclusion + targeted drops. */
    private _spriteSubtreeIndex: Map<number, number> = new Map();
    /** Roots checked and found too small to be worth caching. */
    private _spriteIneligible: Set<number> = new Set();
    /** Roots queued for (re-)bake on the next settle tick. */
    private _spriteWanted: Set<number> = new Set();
    private _spriteBakeTimer: number | null = null;
    /** Root being baked right now (its opacity is applied at draw time, not baked in). */
    private _spriteBakeRootId: number | null = null;
    /** Subtree filter for the sprite-bake render pass. */
    private _bakeSubset: Set<number> | null = null;
    private static readonly SPRITE_MIN_SUBTREE = 30;
    // Per-sprite texture budget. 4096² ≈ 64 MB RGBA, but only groups on screen
    // bake, and at the deep zoom where a group needs this many pixels only one
    // or two are visible — so peak memory stays bounded while a zoomed-in group
    // can bake sharp enough to avoid an upscaled (pixelated) sprite.
    private static readonly SPRITE_MAX_DIM = 4096;
    private static readonly SPRITE_MAX_PIXELS = 16_000_000;
    // A sprite is drawn (rather than falling back to direct vector rendering)
    // only while the on-screen scale is within this factor of the baked scale.
    // Kept tight so an upscaled sprite never shows visible softening/pixelation:
    // past it, the group renders as sharp vectors (few groups are visible when
    // zoomed in, so direct is cheap), and a re-bake at the new scale is queued.
    private static readonly SPRITE_USABLE_UPSCALE = 1.15;

    // ─── Gradient shader cache ───
    private _gradientCache: Map<string, ReturnType<CanvasKit['Shader']['MakeLinearGradient']>> =
        new Map();
    // Decoded images keyed by engine image id. Images are immutable and
    // content-addressed, so an id maps to stable bytes for the life of a
    // document — the cache survives edits/undo and is only cleared on a full
    // document replacement (clearImageCache), where ids may be reused.
    private _imageCache: Map<number, ReturnType<CanvasKit['MakeImageFromEncoded']> | null> =
        new Map();
    private _imagePaint: Paint | null = null;
    // Zoom-adaptive filter-tile overrides: engine image id → CanvasKit image
    // re-baked at `scale` px per SVG unit. When present, drawing uses this
    // instead of the fixed-scale PNG registered at import, so browser-baked
    // filter tiles stay crisp at any zoom. See src/adaptive_tiles.ts.
    private _adaptiveTiles: Map<
        number,
        { img: NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>>; scale: number }
    > = new Map();
    // Pending re-bakes (image id → wanted scale), flushed by a debounced
    // worker once the zoom settles so wheel-zooming doesn't spam rasterizes.
    private _tileBakeQueue: Map<number, number> = new Map();
    private _tileBakeTimer: number | null = null;
    private _tileBakeBusy = false;
    // Repeating image shaders for pattern fills, keyed by pattern signature.
    private _patternShaderCache: Map<
        string,
        ReturnType<CanvasKit['Shader']['MakeLinearGradient']> | null
    > = new Map();
    // Effect (blur/shadow) ImageFilters, cached by effect signature — built once
    // and reused across frames (cleared on invalidateRenderCaches).
    private _effectFilterCache: Map<
        string,
        ReturnType<CanvasKit['ImageFilter']['MakeBlur']> | null
    > = new Map();
    private _effectPaint: Paint | null = null;

    // CanvasKit blend-mode lookup, indexed by our style enum (0 = Normal).
    // Built lazily once `this.ck` is available; shared by group + node passes.
    private _ckBlendModes: any[] | null = null;
    private ckBlendModes(): any[] {
        if (!this._ckBlendModes) {
            this._ckBlendModes = [
                this.ck.BlendMode.SrcOver, // 0: Normal
                this.ck.BlendMode.Multiply, // 1
                this.ck.BlendMode.Screen, // 2
                this.ck.BlendMode.Overlay, // 3
                this.ck.BlendMode.Darken, // 4
                this.ck.BlendMode.Lighten, // 5
                this.ck.BlendMode.ColorDodge, // 6
                this.ck.BlendMode.ColorBurn, // 7
                this.ck.BlendMode.HardLight, // 8
                this.ck.BlendMode.SoftLight, // 9
                this.ck.BlendMode.Difference, // 10
                this.ck.BlendMode.Exclusion, // 11
                this.ck.BlendMode.Hue, // 12
                this.ck.BlendMode.Saturation, // 13
                this.ck.BlendMode.Color, // 14
                this.ck.BlendMode.Luminosity, // 15
            ];
        }
        return this._ckBlendModes;
    }

    // ─── Filled faces cache ───

    // ─── Cached overlay paints (created once, reused every frame) ───
    private _overlayPaints: {
        selOutline: Paint;
        selHandleFill: Paint;
        selHandleStroke: Paint;
        hoverOutline: Paint;
        gridPaint: Paint;
        artboardFill: Paint;
        artboardStroke: Paint;
    } | null = null;

    constructor(ck: CanvasKit, canvas: HTMLCanvasElement, scene: WasmScene) {
        this.ck = ck;
        this.canvas = canvas;
        this.scene = scene;
        this.surface = null;
        this.isRunning = false;

        this.zoom = 1.0;
        this.pan = { x: 0, y: 0 };

        this.initGL();

        // Re-render when a Google Font finishes loading so text appears correctly
        onFontLoaded(() => {
            this.scene.invalidateCache();
            this._needsRender = true;
        });
    }

    /** Signal that the scene or view changed and a new frame is needed. */
    requestRender() {
        this._needsRender = true;
    }

    /** Subscribers notified whenever zoom/pan change (view transform changed).
     *  Used by the inline text-edit overlay to stay glued over the glyphs. */
    private viewChangeCbs: Array<() => void> = [];
    /** Register a callback fired on every zoom/pan change. */
    onViewChange(cb: () => void) {
        this.viewChangeCbs.push(cb);
    }
    /** Notify view-change subscribers. Call after mutating zoom/pan directly. */
    notifyViewChange() {
        for (const cb of this.viewChangeCbs) cb();
    }

    /** Invalidate all cached rendering resources. Call when the scene mutates. */
    invalidateRenderCaches() {
        // Clear path cache
        for (const entry of this._pathCache.values()) {
            entry.path.delete();
        }
        this._pathCache.clear();

        for (const entry of this._clipPathCache.values()) entry.path.delete();
        this._clipPathCache.clear();

        // Any full invalidation means non-transform content may have changed —
        // the drag-layer snapshots and group sprites can no longer be trusted.
        this.endDragLayerCache();
        this.invalidateAllGroupSprites();

        // Clear gradient cache
        for (const shader of this._gradientCache.values()) {
            if (shader) shader.delete();
        }
        this._gradientCache.clear();

        // Clear effect filter cache
        for (const f of this._effectFilterCache.values()) {
            if (f) f.delete();
        }
        this._effectFilterCache.clear();

        // Clear pattern shaders (cheap to rebuild from the cached tile image).
        for (const sh of this._patternShaderCache.values()) if (sh) sh.delete();
        this._patternShaderCache.clear();

        this._needsRender = true;
    }

    /** Build (or fetch a cached) ImageFilter chain for a node's effects.
     *  Effects stack: each filter takes the previous as input. */
    private getEffectFilter(
        effects: EffectRecord[],
    ): ReturnType<CanvasKit['ImageFilter']['MakeBlur']> | null {
        const key = effects
            .map(
                (e) =>
                    `${e.kind}:${e.radius},${e.radiusY},${e.dx},${e.dy},${e.r},${e.g},${e.b},${e.a},${e.matrix?.join(',') ?? ''},${e.linearRGB ? 'L' : 'S'}`,
            )
            .join('|');
        const cached = this._effectFilterCache.get(key);
        if (cached !== undefined) return cached;
        let filter: ReturnType<CanvasKit['ImageFilter']['MakeBlur']> | null = null;
        for (const e of effects) {
            if (e.kind === 0) {
                const sx = Math.max(0, e.radius);
                const sy = Math.max(0, e.radiusY);
                filter = this.ck.ImageFilter.MakeBlur(sx, sy, this.ck.TileMode.Decal, filter);
            } else if (e.kind === 1) {
                const s = Math.max(0, e.radius);
                const color = this.ck.Color4f(e.r, e.g, e.b, e.a);
                filter = this.ck.ImageFilter.MakeDropShadow(e.dx, e.dy, s, s, color, filter);
            } else if (e.kind === 2 && e.matrix && e.matrix.length === 20) {
                const cf = this.ck.ColorFilter.MakeMatrix(e.matrix);
                if (e.linearRGB) {
                    // SVG default: apply matrix in linearRGB space.
                    // Compose: sRGB→linear → matrix → linear→sRGB
                    const toLinear = this.ck.ColorFilter.MakeSRGBToLinearGamma();
                    const toSRGB = this.ck.ColorFilter.MakeLinearToSRGBGamma();
                    const linearMatrix = this.ck.ColorFilter.MakeCompose(
                        toSRGB,
                        this.ck.ColorFilter.MakeCompose(cf, toLinear),
                    );
                    filter = this.ck.ImageFilter.MakeColorFilter(linearMatrix, filter);
                } else {
                    filter = this.ck.ImageFilter.MakeColorFilter(cf, filter);
                }
            }
        }
        this._effectFilterCache.set(key, filter);
        return filter;
    }

    /** Drop all decoded images. Call when a different document is loaded (image
     *  ids may be reused for different bytes). Not called on ordinary edits. */
    clearImageCache() {
        for (const img of this._imageCache.values()) {
            if (img) img.delete();
        }
        this._imageCache.clear();
        for (const sh of this._patternShaderCache.values()) if (sh) sh.delete();
        this._patternShaderCache.clear();
        // Adaptive filter tiles and group sprites belong to the outgoing
        // document too.
        for (const t of this._adaptiveTiles.values()) t.img.delete();
        this._adaptiveTiles.clear();
        this._tileBakeQueue.clear();
        adaptiveTileSources.clear();
        this.invalidateAllGroupSprites();
        this._needsRender = true;
    }

    /** Decode (and cache) an engine image id into a CanvasKit Image, or null. */
    private getImage(imageId: number): ReturnType<CanvasKit['MakeImageFromEncoded']> | null {
        let img = this._imageCache.get(imageId);
        if (img === undefined) {
            const bytes = this.scene.engine?.get_image_bytes(imageId);
            img = bytes && bytes.length > 0 ? this.ck.MakeImageFromEncoded(bytes) : null;
            this._imageCache.set(imageId, img ?? null);
        }
        return img;
    }

    /** Repeating image shader for a pattern fill: tiles the image over
     *  `width`×`height` local units, then applies the pattern transform
     *  ([a,b,c,d,e,f]) as the shader's local matrix. Cached by signature. */
    private getPatternShader(
        imageId: number,
        width: number,
        height: number,
        transform: number[],
    ): ReturnType<CanvasKit['Shader']['MakeLinearGradient']> | null {
        const key = `${imageId}|${width}|${height}|${transform.join(',')}`;
        const cached = this._patternShaderCache.get(key);
        if (cached !== undefined) return cached;
        const img = this.getImage(imageId);
        let shader: ReturnType<CanvasKit['Shader']['MakeLinearGradient']> | null = null;
        if (img && img.width() > 0 && img.height() > 0 && width > 0 && height > 0) {
            const sx = width / img.width(),
                sy = height / img.height();
            const [a, b, c, d, e, f] = transform;
            // localMatrix = patternTransform · scale(image px → tile units), row-major 3x3.
            const m = [a * sx, c * sy, e, b * sx, d * sy, f, 0, 0, 1];
            shader = img.makeShaderOptions(
                this.ck.TileMode.Repeat,
                this.ck.TileMode.Repeat,
                this.ck.FilterMode.Linear,
                this.ck.MipmapMode.None,
                m,
            );
        }
        this._patternShaderCache.set(key, shader);
        return shader;
    }

    /** Draw a raster image node at (0,0,w,h) in the current (local) space. */
    private drawImageNode(canvas: Canvas, imageId: number, w: number, h: number, alpha: number) {
        let img = this.getImage(imageId);

        // Zoom-adaptive filter tiles: draw the re-baked bitmap when one
        // exists, and queue a re-bake when the on-screen scale has drifted
        // meaningfully from the baked scale (sharper when zooming in, cheaper
        // when zooming far back out). Only visible nodes reach this point, so
        // offscreen tiles never re-bake. Skipped during export: the export
        // render is synchronous, so an async bake could never land in it.
        const tileSrc = adaptiveTileSources.get(imageId);
        if (tileSrc) {
            const baked = this._adaptiveTiles.get(imageId);
            if (baked) img = baked.img;
            // Tile re-bakes are queued from live frames AND sprite bakes (a
            // sprite is the only place a cached group's tiles are drawn), but
            // not from PNG exports.
            if (!this._exporting || this._spriteBakeRootId !== null) {
                const m = canvas.getTotalMatrix(); // row-major 3×3
                const devScale = Math.max(Math.hypot(m[0], m[3]), Math.hypot(m[1], m[4]));
                const cur = baked ? baked.scale : tileSrc.baseScale;
                const want = Math.min(Math.max(devScale, tileSrc.baseScale), maxTileScale(tileSrc));
                if (want > cur * 1.4 || want < cur / 2.5) {
                    this._tileBakeQueue.set(imageId, want);
                    this.scheduleTileBakes();
                }
            }
        }

        if (!this._imagePaint) this._imagePaint = new this.ck.Paint();
        const ip = this._imagePaint;
        ip.setShader(null);
        ip.setStyle(this.ck.PaintStyle.Fill);
        const dst = this.ck.XYWHRect(0, 0, w, h);
        if (img) {
            ip.setColor(this.ck.Color4f(1, 1, 1, 1));
            ip.setAlphaf(alpha);
            const src = this.ck.XYWHRect(0, 0, img.width(), img.height());
            // Mitchell cubic so a zoomed raster / filter tile up-scales smoothly
            // instead of showing blocky (nearest-neighbour) pixels.
            canvas.drawImageRectCubic(img, src, dst, 1 / 3, 1 / 3, ip);
        } else {
            // Decode failed / missing bytes — draw a magenta placeholder.
            ip.setColor(this.ck.Color4f(1, 0, 1, 0.6 * alpha));
            canvas.drawRect(dst, ip);
        }
    }

    /** Debounce tile re-bakes until the zoom has settled (~160 ms without a
     *  zoom change), so continuous wheel-zooming doesn't rasterize every step. */
    private scheduleTileBakes() {
        if (this._tileBakeTimer !== null || this._tileBakeBusy) return;
        const zoomAt = this.zoom;
        this._tileBakeTimer = window.setTimeout(() => {
            this._tileBakeTimer = null;
            if (this.zoom !== zoomAt) {
                this.scheduleTileBakes(); // still zooming — wait another beat
                return;
            }
            void this.processTileBakes();
        }, 160);
    }

    /** Drain the bake queue: rasterize each tile's SVG source at the wanted
     *  scale (browser SVG renderer, off the frame loop) and swap the result in
     *  as the tile's drawing image. A wanted scale at/below the import bake
     *  drops the override instead, freeing the high-res bitmap. */
    private async processTileBakes() {
        if (this._tileBakeBusy) return;
        this._tileBakeBusy = true;
        let anyChanged = false;
        try {
            while (this._tileBakeQueue.size > 0) {
                const next = this._tileBakeQueue.entries().next().value;
                if (!next) break;
                const [imageId, scale] = next;
                this._tileBakeQueue.delete(imageId);
                const src = adaptiveTileSources.get(imageId);
                if (!src) continue;
                const prev = this._adaptiveTiles.get(imageId);
                if (scale <= src.baseScale * 1.01) {
                    if (prev) {
                        prev.img.delete();
                        this._adaptiveTiles.delete(imageId);
                        this._needsRender = true;
                        anyChanged = true;
                    }
                    continue;
                }
                const bitmap = await rasterizeAdaptiveTile(src, scale);
                if (!bitmap) continue;
                const ckImg = this.ck.MakeImageFromCanvasImageSource(bitmap);
                if (!ckImg) continue;
                if (prev) prev.img.delete();
                this._adaptiveTiles.set(imageId, { img: ckImg, scale });
                this._needsRender = true;
                anyChanged = true;
            }
        } finally {
            this._tileBakeBusy = false;
            // Tiles drawn inside cached groups changed — those sprites are
            // stale; drop them all (they re-queue on the next frame at the
            // same settled zoom, so both caches converge together).
            if (anyChanged && this._groupSprites.size > 0) {
                this.invalidateAllGroupSprites();
                this._needsRender = true;
            }
        }
    }

    /** Open the saveLayer sandwich for an alpha (mode 0) or luminance (mode 1)
     *  mask span, bounded to `bounds` when the mask shape's extent is known
     *  (null → unbounded, the pre-existing behavior). Layer counts must match
     *  what CMD_BEGIN_MASKED_CONTENT / CMD_END_MASK restore. */
    private openMaskLayers(
        canvas: Canvas,
        span: {
            mode: number;
            pendingLayer: boolean;
            bounds: ReturnType<CanvasKit['LTRBRect']> | null;
        },
        bounds: ReturnType<CanvasKit['LTRBRect']> | null,
    ) {
        span.pendingLayer = false;
        span.bounds = bounds;
        if (span.mode === 1) {
            // Luminance mask: 3-layer protocol.
            // Layer 0 (outer): collects the final masked result.
            canvas.saveLayer(undefined, bounds ?? undefined);
            // Layer 1 (luma): mask shapes are drawn here. On restore,
            // the luminance→alpha color filter converts RGB to alpha.
            if (!this._lumaPaint) {
                this._lumaPaint = new this.ck.Paint();
                // SVG luminance mask: A' = 0.2126·R + 0.7152·G + 0.0722·B
                // (R,G,B are premultiplied, so we also account for source alpha).
                const lumaMatrix = [
                    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0,
                ];
                this._lumaPaint.setColorFilter(this.ck.ColorFilter.MakeMatrix(lumaMatrix));
            }
            canvas.saveLayer(this._lumaPaint, bounds ?? undefined);
        } else {
            // Alpha mask: 2-layer protocol (original).
            // Isolated layer accumulating the mask shape's coverage.
            canvas.saveLayer(undefined, bounds ?? undefined);
        }
    }

    /** Collect `roots` plus all their descendants into a set. */
    private collectSubtree(roots: number[]): Set<number> {
        const out = new Set<number>();
        const stack = [...roots];
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (out.has(id)) continue;
            out.add(id);
            const kids = this.scene.getNodeChildren(id);
            if (kids) for (const k of kids) stack.push(k);
        }
        return out;
    }

    /** True if `rootId` or any descendant is a Live Paint group. Such subtrees
     *  must never be sprite-cached: the group's faces/edges render live
     *  in-stream (they mutate as the user paints) and the paint-bucket cursor
     *  hit-tests the *live* face geometry via query_face_at. A baked snapshot
     *  freezes and can misalign them, so the fill/highlight would land on a
     *  different region than what's shown — only visible once zoomed out far
     *  enough for sprites to engage. Mirrors the engine's `is_lp` guard in
     *  write_node_recursive, which refuses to sprite-skip a Live Paint group. */
    private subtreeHasLivePaint(rootId: number): boolean {
        const stack = [rootId];
        const seen = new Set<number>();
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (seen.has(id)) continue;
            seen.add(id);
            if (this.scene.getNodeLivePaint(id)) return true;
            const kids = this.scene.getNodeChildren(id);
            if (kids) for (const k of kids) stack.push(k);
        }
        return false;
    }

    /**
     * Start a drag-layer cache for a move of `movingIds`. Only supported when
     * every moving node is a ROOT node (top-level z-split is well-defined and
     * no ancestor group opacity/mask/blend can leak); returns false otherwise
     * and the caller just keeps the normal full-render path. Costs two extra
     * full renders up front (the below/above snapshots), then every drag frame
     * re-records only the moving subtree.
     */
    beginDragLayerCache(movingIds: number[]): boolean {
        this.endDragLayerCache();
        if (!this.surface || this._exporting || movingIds.length === 0) return false;
        const roots: number[] = Array.from(this.scene.getRootNodes());
        const rootSet = new Set(roots);
        if (!movingIds.every((id) => rootSet.has(id))) return false;

        const moving = new Set(movingIds);
        let minMovingIdx = Infinity;
        roots.forEach((r, i) => {
            if (moving.has(r) && i < minMovingIdx) minMovingIdx = i;
        });
        // Static roots under the lowest mover go in the below layer, the rest
        // above. (A static root sandwiched between two movers can't be split
        // exactly — it lands above, correct relative to the lowest mover.)
        const belowRoots = roots.filter((r, i) => !moving.has(r) && i < minMovingIdx);
        const aboveRoots = roots.filter((r, i) => !moving.has(r) && i >= minMovingIdx);

        const dpr = window.devicePixelRatio || 1;
        const snapshot = (
            pass: 'below' | 'above',
            ids: number[],
        ): NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>> | null => {
            this._dragSnapshotPass = pass;
            this._dragSubtree = this.collectSubtree(ids);
            try {
                this.render();
                return this.surface!.makeImageSnapshot() as NonNullable<
                    ReturnType<CanvasKit['MakeImageFromEncoded']>
                >;
            } finally {
                this._dragSnapshotPass = null;
            }
        };
        const below = snapshot('below', belowRoots);
        const above = snapshot('above', aboveRoots);

        this._dragLayer = {
            below,
            above,
            zoom: this.zoom,
            panX: this.pan.x,
            panY: this.pan.y,
            dpr,
            width: this.canvas.width,
            height: this.canvas.height,
        };
        this.setDragMovingRoots(movingIds);
        this._needsRender = true;
        return true;
    }

    /** Update which roots are re-recorded live during a cached drag (the set
     *  grows during an Alt clone-drag: originals stay put but aren't in the
     *  snapshots, and the clones move). No-op when unchanged. */
    setDragMovingRoots(movingIds: number[]) {
        if (!this._dragLayer) return;
        if (
            movingIds.length === this._dragMovingRoots.length &&
            movingIds.every((id, i) => id === this._dragMovingRoots[i])
        ) {
            return;
        }
        this._dragMovingRoots = [...movingIds];
        this._dragSubtree = this.collectSubtree(movingIds);
    }

    /** Drop the drag-layer cache (drag ended, or the static content changed). */
    endDragLayerCache() {
        if (this._dragLayer) {
            this._dragLayer.below?.delete();
            this._dragLayer.above?.delete();
            this._dragLayer = null;
            this._needsRender = true;
        }
        this._dragSubtree = null;
        this._dragMovingRoots = [];
    }

    /** Blit a drag-layer snapshot in WORLD space: the destination rect is the
     *  world region the snapshot covered, so it lands correctly even if the
     *  view panned (and merely scales if it zoomed) since the cache was built. */
    private drawDragLayerImage(
        canvas: Canvas,
        img: NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>>,
    ) {
        const dl = this._dragLayer!;
        if (!this._imagePaint) this._imagePaint = new this.ck.Paint();
        const ip = this._imagePaint;
        ip.setShader(null);
        ip.setStyle(this.ck.PaintStyle.Fill);
        ip.setColor(this.ck.Color4f(1, 1, 1, 1));
        ip.setAlphaf(1);
        const worldX = -dl.panX / dl.zoom;
        const worldY = -dl.panY / dl.zoom;
        const worldW = dl.width / dl.dpr / dl.zoom;
        const worldH = dl.height / dl.dpr / dl.zoom;
        canvas.drawImageRect(
            img,
            this.ck.XYWHRect(0, 0, dl.width, dl.height),
            this.ck.XYWHRect(worldX, worldY, worldW, worldH),
            ip,
        );
    }

    // ─── Group sprite cache methods ───

    /** Drop the sprite covering `id` — call for any edit to a node INSIDE a
     *  cached group. A change to the cached root's own transform doesn't need
     *  this: sprites follow their group's transform at draw time. */
    invalidateGroupSpriteFor(id: number) {
        const root = this._spriteSubtreeIndex.get(id);
        if (root !== undefined) this.dropGroupSprite(root);
    }

    private dropGroupSprite(root: number) {
        const s = this._groupSprites.get(root);
        if (!s) return;
        s.img.delete();
        s.surface.delete();
        this._groupSprites.delete(root);
        for (const [k, v] of this._spriteSubtreeIndex) {
            if (v === root) this._spriteSubtreeIndex.delete(k);
        }
        this._needsRender = true;
    }

    invalidateAllGroupSprites() {
        for (const s of this._groupSprites.values()) {
            s.img.delete();
            s.surface.delete();
        }
        this._groupSprites.clear();
        this._spriteSubtreeIndex.clear();
        this._spriteIneligible.clear();
        this._spriteWanted.clear();
    }

    /** Highest useful bake scale for a sprite of the given world size. */
    private spriteMaxScale(w: number, h: number): number {
        return Math.min(
            Renderer.SPRITE_MAX_DIM / Math.max(w, h),
            Math.sqrt(Renderer.SPRITE_MAX_PIXELS / (w * h)),
        );
    }

    /** Bake `rootId`'s subtree into a GPU texture at the current device scale
     *  (capped by the texture budget). Renders through the normal pipeline
     *  with an export-style state swap onto an offscreen GL surface. */
    private bakeGroupSprite(rootId: number): boolean {
        if (!this.surface || !this.scene.engine || this._exporting) return false;
        const b = this.scene.getNodeBounds(rootId);
        const bw = b[2] - b[0];
        const bh = b[3] - b[1];
        if (!(bw > 0) || !(bh > 0)) return false;
        // Pad for filter/stroke spill past the engine's geometry bounds.
        const pad = Math.max(10, 0.05 * Math.max(bw, bh));
        const x = b[0] - pad;
        const y = b[1] - pad;
        const w = bw + 2 * pad;
        const h = bh + 2 * pad;
        const dpr = window.devicePixelRatio || 1;
        const scale = Math.min(Math.max(0.05, this.zoom * dpr), this.spriteMaxScale(w, h));
        const pxW = Math.max(1, Math.ceil(w * scale));
        const pxH = Math.max(1, Math.ceil(h * scale));
        const ckAny = this.ck as unknown as Record<string, CallableFunction>;
        const surface = ckAny.MakeRenderTarget(this.grContext, pxW, pxH) as Surface | null;
        if (!surface) return false;

        const subtree = this.collectSubtree([rootId]);
        const savedSurface = this.surface;
        const savedZoom = this.zoom;
        const savedPan = this.pan;
        this.surface = surface;
        this.zoom = scale;
        this.pan = { x: -x * scale, y: -y * scale };
        this._exporting = true; // transparent clear, no chrome, dpr 1
        this._exportBounds = { x, y, w, h };
        this._bakeSubset = subtree;
        this._spriteBakeRootId = rootId;
        try {
            this.render();
        } finally {
            this.surface = savedSurface;
            this.zoom = savedZoom;
            this.pan = savedPan;
            this._exporting = false;
            this._exportBounds = null;
            this._bakeSubset = null;
            this._spriteBakeRootId = null;
        }
        const img = surface.makeImageSnapshot() as NonNullable<
            ReturnType<CanvasKit['MakeImageFromEncoded']>
        > | null;
        if (!img) {
            surface.delete();
            return false;
        }
        this._groupSprites.set(rootId, {
            img,
            surface,
            x,
            y,
            w,
            h,
            bakeTransform: this.scene.getTransform(rootId),
            scale,
        });
        for (const id of subtree) {
            if (id !== rootId) this._spriteSubtreeIndex.set(id, rootId);
        }
        this._needsRender = true;
        return true;
    }

    /** Draw a cached group as one image, transformed by the group's movement
     *  since bake time. Queues a re-bake when the on-screen scale has drifted. */
    private drawGroupSprite(
        canvas: Canvas,
        rootId: number,
        sprite: NonNullable<ReturnType<Renderer['_groupSprites']['get']>>,
        devScale: number,
    ) {
        const cur = this.scene.getTransform(rootId);
        const bk = sprite.bakeTransform;
        let delta: number[] | null = null;
        const moved =
            cur[0] !== bk[0] ||
            cur[1] !== bk[1] ||
            cur[2] !== bk[2] ||
            cur[3] !== bk[3] ||
            cur[4] !== bk[4] ||
            cur[5] !== bk[5];
        if (moved) {
            const inv = invertAffine(bk);
            if (inv) {
                // delta = cur · inv, row-major affine
                delta = [
                    cur[0] * inv[0] + cur[1] * inv[3],
                    cur[0] * inv[1] + cur[1] * inv[4],
                    cur[0] * inv[2] + cur[1] * inv[5] + cur[2],
                    cur[3] * inv[0] + cur[4] * inv[3],
                    cur[3] * inv[1] + cur[4] * inv[4],
                    cur[3] * inv[2] + cur[4] * inv[5] + cur[5],
                    0,
                    0,
                    1,
                ];
            }
        }
        if (delta) {
            canvas.save();
            canvas.concat(delta);
        }
        if (!this._imagePaint) this._imagePaint = new this.ck.Paint();
        const ip = this._imagePaint;
        ip.setShader(null);
        ip.setStyle(this.ck.PaintStyle.Fill);
        ip.setColor(this.ck.Color4f(1, 1, 1, 1));
        ip.setAlphaf(1);
        // Mitchell cubic resample so any residual up/down-scale of the sprite is
        // smooth, never blocky (nearest-neighbour reads as "pixelated").
        canvas.drawImageRectCubic(
            sprite.img,
            this.ck.XYWHRect(0, 0, sprite.img.width(), sprite.img.height()),
            this.ck.XYWHRect(sprite.x, sprite.y, sprite.w, sprite.h),
            1 / 3,
            1 / 3,
            ip,
        );
        if (delta) canvas.restore();

        // Queue a re-bake when the settled zoom wants a meaningfully different
        // resolution than the sprite has — but never chase past the cap. Upscale
        // threshold matches the usable factor so a zoomed-in sprite re-sharpens
        // before it would drift out of the usable range; downscale is looser
        // (a too-large sprite only wastes memory, it never looks wrong).
        const target = Math.min(Math.max(0.05, devScale), this.spriteMaxScale(sprite.w, sprite.h));
        const ratio = target / sprite.scale;
        if (ratio > 1.05 || ratio < 1 / 2.5) {
            this._spriteWanted.add(rootId);
            this.scheduleSpriteBakes();
        }
    }

    /** Debounce sprite bakes until the view settles, then spread them over
     *  timer ticks so a batch never blocks a frame for long. */
    private scheduleSpriteBakes() {
        if (this._spriteBakeTimer !== null) return;
        const zoomAt = this.zoom;
        this._spriteBakeTimer = window.setTimeout(() => {
            this._spriteBakeTimer = null;
            if (this.zoom !== zoomAt) {
                this.scheduleSpriteBakes();
                return;
            }
            this.processSpriteBakes();
        }, 160);
    }

    private processSpriteBakes() {
        // Don't bake mid-gesture (resize/rotate drags mutate every frame —
        // sprites would be dropped again immediately).
        if (this.inputManager?.isMouseDown) {
            this.scheduleSpriteBakes();
            return;
        }
        // A zero-sized surface (hidden/minimized window) can't judge
        // visibility — try again later rather than draining the queue.
        if (this.canvas.width === 0 || this.canvas.height === 0) {
            this.scheduleSpriteBakes();
            return;
        }
        // Only bake what's on screen: offscreen roots get re-queued when they
        // scroll into view, and baking all of them at once at a deep zoom
        // would blow the GPU memory budget for nothing.
        const dpr = window.devicePixelRatio || 1;
        const vMinX = -this.pan.x / this.zoom;
        const vMinY = -this.pan.y / this.zoom;
        const vMaxX = (this.canvas.width / dpr - this.pan.x) / this.zoom;
        const vMaxY = (this.canvas.height / dpr - this.pan.y) / this.zoom;
        const BUDGET = 4;
        let done = 0;
        for (const rootId of [...this._spriteWanted]) {
            if (done >= BUDGET) break;
            this._spriteWanted.delete(rootId);
            if (this._spriteIneligible.has(rootId)) continue;
            if (this.scene.getNodeType(rootId) !== 3) {
                // Not a group (or gone) — never cache.
                this._spriteIneligible.add(rootId);
                continue;
            }
            // A Live Paint group (or any root containing one) renders its faces
            // live and is hit-tested against live geometry — baking it desyncs
            // the paint-bucket fill/highlight from what's shown at low zoom.
            if (this.subtreeHasLivePaint(rootId)) {
                this._spriteIneligible.add(rootId);
                this.dropGroupSprite(rootId); // drop any sprite baked before this guard
                continue;
            }
            const b = this.scene.getNodeBounds(rootId);
            if (b[2] < vMinX || b[0] > vMaxX || b[3] < vMinY || b[1] > vMaxY) continue;
            if (!this._groupSprites.has(rootId)) {
                const size = this.collectSubtree([rootId]).size;
                if (size < Renderer.SPRITE_MIN_SUBTREE) {
                    this._spriteIneligible.add(rootId);
                    continue;
                }
            } else {
                this.dropGroupSprite(rootId);
            }
            if (this.bakeGroupSprite(rootId)) {
                done++;
            } else {
                // Bake failed (degenerate bounds / render-target allocation) —
                // don't retry-loop; eligibility resets with the next full
                // invalidation.
                this._spriteIneligible.add(rootId);
            }
        }
        if (this._spriteWanted.size > 0) {
            this._spriteBakeTimer = window.setTimeout(() => {
                this._spriteBakeTimer = null;
                this.processSpriteBakes();
            }, 30);
        }
    }

    /** Ensure the reusable overlay Paint objects exist. */
    private ensureOverlayPaints() {
        if (this._overlayPaints) return this._overlayPaints;
        const ck = this.ck;
        const selOutline = new ck.Paint();
        selOutline.setColor(ck.Color(0, 162, 255, 1.0));
        selOutline.setStyle(ck.PaintStyle.Stroke);

        const selHandleFill = new ck.Paint();
        selHandleFill.setColor(ck.Color(255, 255, 255, 1.0));
        selHandleFill.setStyle(ck.PaintStyle.Fill);

        const selHandleStroke = new ck.Paint();
        selHandleStroke.setColor(ck.Color(0, 162, 255, 1.0));
        selHandleStroke.setStyle(ck.PaintStyle.Stroke);

        const hoverOutline = new ck.Paint();
        hoverOutline.setColor(ck.Color(0, 162, 255, 0.55));
        hoverOutline.setStyle(ck.PaintStyle.Stroke);
        hoverOutline.setAntiAlias(true);

        const gridPaint = new ck.Paint();
        gridPaint.setColor(ck.Color(255, 255, 255, 0.04));
        gridPaint.setStyle(ck.PaintStyle.Stroke);

        const artboardFill = new ck.Paint();
        artboardFill.setColor(ck.Color(255, 255, 255, 1.0));
        artboardFill.setStyle(ck.PaintStyle.Fill);

        const artboardStroke = new ck.Paint();
        artboardStroke.setColor(ck.Color(80, 80, 80, 1.0));
        artboardStroke.setStyle(ck.PaintStyle.Stroke);

        this._overlayPaints = {
            selOutline,
            selHandleFill,
            selHandleStroke,
            hoverOutline,
            gridPaint,
            artboardFill,
            artboardStroke,
        };
        return this._overlayPaints;
    }

    private initGL() {
        // CanvasKit's GetWebGLContext/MakeGrContext aren't in public typings
        const ckAny = this.ck as unknown as Record<string, CallableFunction>;
        this.glContext = ckAny.GetWebGLContext(this.canvas) as number;
        this.grContext = ckAny.MakeGrContext(this.glContext);
        this.onResize();
        window.addEventListener('resize', () => this.onResize());
        // A window 'resize' fires only when the WINDOW changes size — not when
        // just the canvas's CSS box does (a side panel opening/closing, the
        // properties panel appearing on selection, any layout reflow). Without
        // catching those, the drawing-buffer size goes stale: the scene is
        // bitmap-scaled to fit the new box while pointer→world mapping still
        // uses the live client rect, so hover/paint lands on the wrong spot —
        // worst far from the canvas origin (a right-hand artboard looks most
        // off). A ResizeObserver on the canvas catches every box change.
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => this.onResize());
            this._resizeObserver.observe(this.canvas);
        }
    }

    destroy() {
        this.isRunning = false;
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._tileBakeTimer !== null) {
            window.clearTimeout(this._tileBakeTimer);
            this._tileBakeTimer = null;
        }
        for (const t of this._adaptiveTiles.values()) t.img.delete();
        this._adaptiveTiles.clear();
        this._tileBakeQueue.clear();
        if (this.paint) {
            this.paint.delete();
            this.paint = null;
        }
        if (this.surface) {
            this.surface.delete();
            this.surface = null;
        }
        // Clean up cached CanvasKit objects
        this.invalidateRenderCaches();
        if (this._overlayPaints) {
            this._overlayPaints.selOutline.delete();
            this._overlayPaints.selHandleFill.delete();
            this._overlayPaints.selHandleStroke.delete();
            this._overlayPaints.hoverOutline.delete();
            this._overlayPaints.gridPaint.delete();
            this._overlayPaints.artboardFill.delete();
            this._overlayPaints.artboardStroke.delete();
            this._overlayPaints = null;
        }
    }

    onResize() {
        try {
            const dpr = window.devicePixelRatio;
            const w = Math.round(this.canvas.clientWidth * dpr);
            const h = Math.round(this.canvas.clientHeight * dpr);
            // Nothing to size to yet (hidden/detached/zero-box). A later resize
            // — or the ResizeObserver — re-fires once the canvas has a real box.
            if (w === 0 || h === 0) return;
            // No actual size change: the ResizeObserver emits an initial
            // callback and can fire on unrelated reflows, so skip the costly
            // surface recreate + reallocation when the buffer already matches.
            if (this.surface && this.canvas.width === w && this.canvas.height === h) {
                return;
            }
            // Snapshots are sized to the old surface — rebuildable, so drop.
            this.endDragLayerCache();
            this.canvas.width = w;
            this.canvas.height = h;

            if (this.surface) {
                this.surface.delete();
            }

            const ckExt = this.ck as unknown as Record<string, CallableFunction>;
            const ckRaw = this.ck as unknown as Record<string, Record<string, unknown>>;
            this.surface = ckExt.MakeOnScreenGLSurface(
                this.grContext,
                this.canvas.width,
                this.canvas.height,
                ckRaw.ColorSpace ? ckRaw.ColorSpace.SRGB : null,
            ) as Surface | null;

            // Fallback for different CanvasKit versions
            if (!this.surface && ckExt.MakeRenderTarget) {
                this.surface = ckExt.MakeRenderTarget(
                    this.glContext,
                    this.canvas.width,
                    this.canvas.height,
                ) as Surface | null;
            }
            if (!this.surface) {
                this.surface = this.ck.MakeWebGLCanvasSurface(this.canvas);
            }

            this.render();
        } catch (e) {
            console.error('Failed to resize surface:', e);
        }
    }

    zoomToFit(docW: number, docH: number, originX = 0, originY = 0) {
        const viewW = this.canvas.clientWidth;
        const viewH = this.canvas.clientHeight;
        if (viewW <= 0 || viewH <= 0) return;

        const margin = 48; // css px on each side
        const scale = Math.min((viewW - margin * 2) / docW, (viewH - margin * 2) / docH);
        this.zoom = Math.max(0.02, Math.min(4, scale));
        // Center the content bounds (which may start at a non-zero origin when
        // there are multiple artboards) in the viewport.
        this.pan.x = (viewW - docW * this.zoom) / 2 - originX * this.zoom;
        this.pan.y = (viewH - docH * this.zoom) / 2 - originY * this.zoom;
        this.notifyViewChange();
    }

    /** Fit the given world-space bounds in the viewport (zoom to selection). */
    zoomToBounds(b: { x: number; y: number; w: number; h: number }) {
        const viewW = this.canvas.clientWidth;
        const viewH = this.canvas.clientHeight;
        if (viewW <= 0 || viewH <= 0 || b.w <= 0 || b.h <= 0) return;

        const margin = 64; // css px on each side
        const scale = Math.min((viewW - margin * 2) / b.w, (viewH - margin * 2) / b.h);
        this.zoom = Math.max(0.02, Math.min(64, scale));
        this.pan.x = (viewW - b.w * this.zoom) / 2 - b.x * this.zoom;
        this.pan.y = (viewH - b.h * this.zoom) / 2 - b.y * this.zoom;
        this.notifyViewChange();
    }

    /** Set zoom keeping the viewport center fixed. */
    setZoomCentered(newZoom: number) {
        const viewW = this.canvas.clientWidth;
        const viewH = this.canvas.clientHeight;
        const cx = viewW / 2,
            cy = viewH / 2;
        const worldX = (cx - this.pan.x) / this.zoom;
        const worldY = (cy - this.pan.y) / this.zoom;
        this.zoom = Math.max(0.01, Math.min(100, newZoom));
        this.pan.x = cx - worldX * this.zoom;
        this.pan.y = cy - worldY * this.zoom;
        this.notifyViewChange();
    }

    loop() {
        if (!this.isRunning) return;
        if (this._needsRender) {
            this._needsRender = false;
            this.render();
        }
        requestAnimationFrame(() => this.loop());
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.loop();
    }

    fitToArtboard(docW?: number, docH?: number) {
        // Fit the union of all artboards (name kept for API stability). Explicit
        // dims still override (used by callers that know the page size).
        if (docW !== undefined && docH !== undefined) {
            this.zoomToFit(docW, docH);
        } else {
            const b = this.getArtboardsBounds();
            this.zoomToFit(b.w, b.h, b.x, b.y);
        }
        this.render();
    }

    render() {
        if (!this.surface || !this.scene.engine) return;
        const canvas = this.surface.getCanvas();
        // In export mode we render into an offscreen surface at 1:1 (the export
        // scale is folded into this.zoom) with a transparent background and no
        // editor chrome (grid, artboard, selection, guides).
        const exporting = this._exporting;
        const dpr = exporting ? 1 : window.devicePixelRatio || 1;
        // Drag-layer state: `snapshotPass` while baking the below/above
        // snapshots (chrome-less, like exporting), `dragActive` while blitting
        // them and re-recording only the moving subtree.
        const snapshotPass = this._dragSnapshotPass;
        const dragActive = !exporting && snapshotPass === null && this._dragLayer !== null;

        if (exporting || snapshotPass === 'above') {
            canvas.clear(this.ck.TRANSPARENT);
        } else {
            canvas.clear(this.ck.Color(43, 43, 43, 1.0));
            // During a cached drag the grid is already in the below snapshot.
            if (!dragActive) this.drawGrid(canvas, dpr);
        }

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        if (exporting && this._exportBackground && this._exportBounds) {
            const bg = this._exportBackground;
            const eb = this._exportBounds;
            const p = new this.ck.Paint();
            p.setColor(
                this.ck.Color(
                    Math.round(bg.r * 255),
                    Math.round(bg.g * 255),
                    Math.round(bg.b * 255),
                    bg.a,
                ),
            );
            p.setStyle(this.ck.PaintStyle.Fill);
            canvas.drawRect(this.ck.LTRBRect(eb.x, eb.y, eb.x + eb.w, eb.y + eb.h), p);
            p.delete();
        }
        // Artboards live in the below snapshot during a cached drag, and must
        // stay out of the above snapshot.
        if (!exporting && snapshotPass !== 'above' && !dragActive) this.drawArtboards(canvas);
        if (dragActive && this._dragLayer?.below) {
            this.drawDragLayerImage(canvas, this._dragLayer.below);
        }

        // Compute viewport in document space for culling. Export culls to the
        // export bounds (a specific artboard, or the whole canvas) so content
        // renders regardless of screen size or artboard origin.
        let viewportMinX: number, viewportMinY: number, viewportMaxX: number, viewportMaxY: number;
        if (exporting) {
            const b = this._exportBounds ?? {
                x: 0,
                y: 0,
                w: this.scene.engine.get_document_width(),
                h: this.scene.engine.get_document_height(),
            };
            viewportMinX = b.x;
            viewportMinY = b.y;
            viewportMaxX = b.x + b.w;
            viewportMaxY = b.y + b.h;
        } else {
            viewportMinX = -this.pan.x / this.zoom;
            viewportMinY = -this.pan.y / this.zoom;
            viewportMaxX = (this.canvas.width / dpr - this.pan.x) / this.zoom;
            viewportMaxY = (this.canvas.height / dpr - this.pan.y) / this.zoom;
        }

        // Re-evaluate any Boolean Group whose operands changed since last frame,
        // so the cached outline the stream draws is current. Cheap when idle.
        this.scene.recomputeDirtyBooleanGroups(this.ck);

        // Compute the dim target once per frame. getEditingDimTarget self-heals a
        // stale id (edited node removed by undo/delete), so dimming can never stick.
        // No dimming in export output.
        const dimTarget = exporting ? null : (this.inputManager?.getEditingDimTarget() ?? null);

        // Group sprites are bypassed in export output (full-res vectors) and
        // in per-node visibility modes a baked image can't express (edit
        // dimming, pen-source hiding, inline text editing).
        const spriteMode =
            !exporting &&
            dimTarget === null &&
            this.editingTextId === null &&
            (this.inputManager?.penSourceNodeId ?? null) == null;
        // Groups drawn as a cached sprite THIS pass: a usable sprite (sharp
        // enough for the current zoom — past its texture cap it renders
        // direct), restricted to the active stream subset so a drag/snapshot
        // pass never paints a group that belongs to a different layer. The
        // engine is told to emit these groups' brackets but skip descending
        // into their subtrees (see getRenderData → update_render_buffer).
        let spriteDrawRoots: Set<number> | null = null;
        if (spriteMode && this._groupSprites.size > 0) {
            const passSubset = dragActive || snapshotPass !== null ? this._dragSubtree : null;
            spriteDrawRoots = new Set();
            for (const [rootId, s] of this._groupSprites) {
                // Sprite too low-res for this zoom → render direct (sharp).
                if (this.zoom * dpr > s.scale * Renderer.SPRITE_USABLE_UPSCALE) continue;
                if (passSubset && !passSubset.has(rootId)) continue;
                spriteDrawRoots.add(rootId);
            }
        }

        // Draw Scene Objects via binary command stream (Phase 3: No JSON Tax).
        // Hand the engine the groups it should bracket-but-not-descend (their
        // sprite is drawn here instead), so it skips walking those subtrees.
        const spriteRootsArr =
            spriteDrawRoots && spriteDrawRoots.size > 0
                ? Uint32Array.from(spriteDrawRoots)
                : undefined;

        // The bake/drag/snapshot passes need a JS-side id subset, so they query
        // the visible ids, filter, and pass the list. Ordinary frames skip all
        // that: the engine culls to the viewport internally (one tree walk, no
        // id array marshalled across the boundary).
        const needsSubset =
            this._bakeSubset != null ||
            ((dragActive || snapshotPass !== null) && this._dragSubtree != null);
        let view: DataView;
        if (needsSubset) {
            let visibleIds = this.scene.getVisibleNodes(
                viewportMinX,
                viewportMinY,
                viewportMaxX,
                viewportMaxY,
            );
            const sub = this._bakeSubset ?? this._dragSubtree!;
            const tmp = new Uint32Array(visibleIds.length);
            let n = 0;
            for (let i = 0; i < visibleIds.length; i++) {
                if (sub.has(visibleIds[i])) tmp[n++] = visibleIds[i];
            }
            visibleIds = tmp.subarray(0, n);
            view = this.scene.getRenderData(visibleIds, spriteRootsArr);
        } else {
            view = this.scene.getRenderDataCulled(
                viewportMinX,
                viewportMinY,
                viewportMaxX,
                viewportMaxY,
                spriteRootsArr,
            );
        }
        const reader = new BinaryReader(view);

        // Validate the protocol header before trusting any offsets. A magic or
        // version mismatch means the engine wasm is stale/incompatible — fail
        // loudly rather than parsing garbage.
        const magic = reader.u32();
        if (magic !== RENDER_PROTOCOL_MAGIC) {
            throw new Error(
                `Render buffer magic 0x${magic.toString(16)} != 0x${RENDER_PROTOCOL_MAGIC.toString(16)}. ` +
                    `engine/pkg is stale or corrupt — rebuild the wasm engine.`,
            );
        }
        const protocolVersion = reader.u32();
        if (protocolVersion !== EXPECTED_RENDER_PROTOCOL_VERSION) {
            throw new Error(
                `Render protocol version ${protocolVersion} != expected ${EXPECTED_RENDER_PROTOCOL_VERSION}. ` +
                    `Rebuild the wasm engine after engine/src changes, or update renderer.ts to match.`,
            );
        }

        const commandCount = reader.u32();
        // Mask spans never straddle frames; reset so a mid-frame desync can't
        // leak stale span state into the next frame.
        this._maskStack.length = 0;
        if (!this.paint) this.paint = new this.ck.Paint();
        const p = this.paint;
        // Anti-aliasing is disabled only for the supersampled export pass, where
        // the downscale supplies the AA (SSAA) and abutting fills must tile
        // exactly to avoid seams. On-screen and 1× export keep analytic AA.
        const contentAA = !this._exportNoAA;
        p.setAntiAlias(contentAA);

        // Geometric-clip masks (mask_type 2) render as real canvas clips only
        // when zoomed in enough that the alpha-mask saveLayer sandwich is the
        // dominant cost. Measured on Tux.svg (13 clip spans): at ≥24 device px
        // per unit clips cut frame time up to ~2× (no more full-viewport
        // layers), while at low zoom Skia's AA path-clip masks are *slower*
        // than the layers — so each frame picks the cheaper strategy.
        const clipMaskDevScale = this.zoom * dpr;
        const useGeometricClips = clipMaskDevScale >= 24;

        // Group nesting depth — 0 means the next START_GROUP is a root group
        // (the sprite-cache unit).
        let groupDepth = 0;
        // Stack of enclosing group nodeIds, so an in-stream Live Paint
        // face/edge command (CMD_LP_FACES/EDGES, emitted right after its
        // group's START_GROUP) can be attributed to its group. During a
        // drag/snapshot pass only the moving subtree is re-recorded; the engine
        // still emits every group's bracket + LP faces unconditionally (only
        // LEAF draws honor the visible-id subset), so without this the moving
        // group's fills bake into the static snapshot at their rest position
        // and stay behind as a ghost when the group moves.
        const groupIdStack: number[] = [];
        // Non-null only on a subset pass (sprite bake, or drag/snapshot): LP
        // faces/edges whose enclosing group is outside the re-recorded subset
        // must be skipped, or they leak into that pass's output (a sprite/
        // snapshot bitmap) at their rest position. Mirrors the `needsSubset`
        // active-subset selection below.
        const lpPassSubset =
            this._bakeSubset ?? (dragActive || snapshotPass !== null ? this._dragSubtree : null);

        for (let i = 0; i < commandCount; i++) {
            const recordLen = reader.u32();
            const recordStart = reader.offset;
            const cmdType = reader.u32();
            const nodeId = reader.u32();

            if (cmdType === 1) {
                // CMD_START_GROUP
                const isRootLevel = groupDepth === 0;
                groupDepth++;
                groupIdStack.push(nodeId);
                // A group arriving as a geometric clip's mask node can't be
                // captured as a single clip path — convert the span back to
                // the alpha saveLayer protocol before the group renders. A
                // group as an alpha/luma mask node likewise opens its pending
                // layers unbounded (its extent isn't known without recursing).
                const groupSpan = this._maskStack[this._maskStack.length - 1];
                if (groupSpan && groupSpan.mode === 2 && groupSpan.pendingClip) {
                    groupSpan.pendingClip = false;
                    groupSpan.converted = true;
                    canvas.saveLayer();
                } else if (groupSpan?.pendingLayer) {
                    this.openMaskLayers(canvas, groupSpan, null);
                }
                const opacity = reader.f32();
                const groupFlags = reader.u32();
                const groupBlend = (groupFlags >>> 16) & 0xff;
                // A non-Normal blend mode requires an isolation layer so the
                // group composites as a single unit against the backdrop (like
                // opacity does), otherwise the group's blend would never apply.
                if (nodeId === this._spriteBakeRootId) {
                    // Sprite bake: the root's own opacity/blend are applied at
                    // draw time (the stream carries them every frame) — baking
                    // them in would double-apply.
                    canvas.save();
                } else if (opacity < 1.0 || groupBlend > 0) {
                    p.setAlphaf(opacity);
                    const bm = this.ckBlendModes();
                    if (groupBlend > 0 && groupBlend < bm.length) p.setBlendMode(bm[groupBlend]);
                    canvas.saveLayer(p);
                    p.setAlphaf(1.0);
                    p.setBlendMode(this.ck.BlendMode.SrcOver);
                } else {
                    canvas.save();
                }

                // Group sprite: a cached root group in spriteDrawRoots draws as
                // one baked image (the engine emitted only its bracket, having
                // skipped the subtree). Root groups NOT drawn as a sprite this
                // pass are queued: an eligibility check + first bake when
                // uncached, or a re-bake toward the texture cap when the current
                // sprite is too low-res for the zoom.
                if (isRootLevel && spriteMode) {
                    const drawSprite = spriteDrawRoots?.has(nodeId) ?? false;
                    const sprite = this._groupSprites.get(nodeId);
                    if (drawSprite && sprite) {
                        this.drawGroupSprite(canvas, nodeId, sprite, clipMaskDevScale);
                    } else if (sprite) {
                        // Rendered direct because the sprite is too low-res for
                        // this zoom: queue a re-bake at the achievable scale so it
                        // becomes usable again once the view settles. Threshold
                        // just above the usable factor so a settled zoom always
                        // converges back to the (fast) sprite path.
                        const target = Math.min(
                            clipMaskDevScale,
                            this.spriteMaxScale(sprite.w, sprite.h),
                        );
                        if (target / sprite.scale > 1.05) this._spriteWanted.add(nodeId);
                    } else if (!this._spriteIneligible.has(nodeId)) {
                        this._spriteWanted.add(nodeId);
                    }
                }
            } else if (cmdType === 3) {
                // CMD_END_GROUP
                groupDepth--;
                groupIdStack.pop();
                canvas.restore();
            } else if (cmdType === 4) {
                // CMD_BEGIN_MASK
                // Read mask_type: 0 = alpha, 1 = luminance, 2 = geometric clip.
                // Clip-eligible masks fall back to the alpha protocol at low
                // zoom, where layers are cheaper than AA path clips.
                let maskType = reader.u32();
                if (maskType === 2 && !useGeometricClips) maskType = 0;
                this._maskStack.push({
                    mode: maskType,
                    pendingClip: maskType === 2,
                    // Alpha/luma layers are opened lazily at the mask shape's
                    // DRAW_NODE record, where its geometry bounds are known —
                    // see openMaskLayers().
                    pendingLayer: maskType !== 2,
                    converted: false,
                    bounds: null,
                });
                if (maskType === 2) {
                    // Geometric clip fast path: the mask shape becomes a plain
                    // canvas clip — no saveLayer sandwich, so no full-viewport
                    // offscreen layers (which dominate frame cost at high
                    // zoom). The next DRAW_NODE record is captured as the clip
                    // path instead of being drawn; if the mask node turns out
                    // not to be a plain shape, the span converts itself back
                    // to the alpha protocol (see `converted`).
                    canvas.save();
                }
            } else if (cmdType === 5) {
                // CMD_BEGIN_MASKED_CONTENT
                const span = this._maskStack[this._maskStack.length - 1];
                const maskType = span ? span.mode : 0;
                if (maskType === 2 && span && !span.converted) {
                    // Clip mode: content draws directly under the clip — no
                    // layers. If the clip shape never arrived (culled while
                    // offscreen), clip to nothing so the content is hidden,
                    // matching what an empty alpha mask produces.
                    if (span.pendingClip) {
                        span.pendingClip = false;
                        canvas.clipRect(
                            this.ck.LTRBRect(0, 0, 0, 0),
                            this.ck.ClipOp.Intersect,
                            false,
                        );
                    }
                } else {
                    // Mask node never arrived (culled offscreen): open the
                    // layers now so the restore counts stay balanced — the
                    // empty mask hides the content, as before.
                    if (span?.pendingLayer) this.openMaskLayers(canvas, span, null);
                    if (maskType === 1) {
                        // Restore the luma layer: mask shapes are composited through
                        // the luminance→alpha filter into the outer layer.
                        canvas.restore();
                    }
                    // Content layer: on restore it composites into the mask/outer
                    // layer with SrcIn, so content survives only where the mask has
                    // coverage (alpha for alpha-masks, luminance-derived alpha for
                    // luminance masks). Content outside the mask's bounds is
                    // discarded by SrcIn anyway, so the mask bounds bound this
                    // layer too.
                    if (!this._maskPaint) this._maskPaint = new this.ck.Paint();
                    this._maskPaint.setBlendMode(this.ck.BlendMode.SrcIn);
                    canvas.saveLayer(this._maskPaint, span?.bounds ?? undefined);
                }
            } else if (cmdType === 6) {
                // CMD_END_MASK
                const span = this._maskStack.pop();
                if (span && span.mode === 2 && !span.converted) {
                    canvas.restore(); // pops the clip scope save
                } else {
                    canvas.restore(); // content → mask/outer layer (SrcIn)
                    canvas.restore(); // masked result → canvas
                    // A converted clip span opened an extra clip-scope save
                    // before falling back to the alpha protocol.
                    if (span && span.mode === 2 && span.converted) canvas.restore();
                }
            } else if (cmdType === 7) {
                // CMD_LP_FACES (Live Paint face fills). On a drag/snapshot pass,
                // skip drawing (but still read, to stay frame-aligned) when the
                // enclosing group isn't in the re-recorded subset — otherwise
                // the moving group's fills bake into the static snapshot and
                // ghost behind the moved shapes.
                const lpSkip =
                    lpPassSubset !== null &&
                    !lpPassSubset.has(groupIdStack[groupIdStack.length - 1]);
                const faceCount = reader.u32();
                p.setStyle(this.ck.PaintStyle.Fill);
                p.setShader(null);
                p.setAntiAlias(contentAA);
                for (let fi = 0; fi < faceCount; fi++) {
                    const r = reader.f32(),
                        gg = reader.f32(),
                        bb = reader.f32(),
                        aa = reader.f32();
                    const path = this.readOutlinePath(reader, true);
                    if (!lpSkip) {
                        p.setColor(this.ck.Color4f(r, gg, bb, aa));
                        canvas.drawPath(path, p);
                    }
                    path.delete();
                }
            } else if (cmdType === 8) {
                // CMD_LP_EDGES (Live Paint painted edges). Same drag/snapshot
                // subset gate as CMD_LP_FACES above.
                const lpSkip =
                    lpPassSubset !== null &&
                    !lpPassSubset.has(groupIdStack[groupIdStack.length - 1]);
                const edgeCount = reader.u32();
                p.setStyle(this.ck.PaintStyle.Stroke);
                p.setShader(null);
                p.setAntiAlias(contentAA);
                p.setStrokeCap(this.ck.StrokeCap.Round);
                p.setStrokeJoin(this.ck.StrokeJoin.Round);
                for (let ei = 0; ei < edgeCount; ei++) {
                    const r = reader.f32(),
                        gg = reader.f32(),
                        bb = reader.f32(),
                        aa = reader.f32();
                    const width = reader.f32();
                    const path = this.readOutlinePath(reader, false);
                    if (!lpSkip) {
                        p.setColor(this.ck.Color4f(r, gg, bb, aa));
                        p.setStrokeWidth(width > 0 ? width : 2);
                        canvas.drawPath(path, p);
                    }
                    path.delete();
                }
                p.setStrokeCap(this.ck.StrokeCap.Butt);
                p.setStrokeJoin(this.ck.StrokeJoin.Miter);
            } else if (cmdType === 2) {
                // CMD_DRAW_NODE
                const nodeType = reader.u32();
                const matrix = reader.f32Array(9);

                // Dim non-edited nodes in path edit mode. While the pen tool is
                // extending an existing open path (endpoint continuation), hide the
                // source node entirely — the blue pen preview stands in for it, so
                // it isn't doubled.
                const nodeAlpha =
                    this.inputManager?.penSourceNodeId === nodeId
                        ? 0
                        : dimTarget !== null && nodeId !== dimTarget
                          ? 0.3
                          : 1.0;

                // ─── Read Fills ─────────────────
                const fillCount = reader.u32();
                const fills: any[] = [];
                for (let i = 0; i < fillCount; i++) {
                    const fillType = reader.u32();
                    if (fillType === 1) {
                        // Solid
                        fills.push({
                            type: 1,
                            r: reader.f32(),
                            g: reader.f32(),
                            b: reader.f32(),
                            a: reader.f32(),
                        });
                    } else if (fillType === 2 || fillType === 3) {
                        // Gradient
                        const stopCount = reader.u32();
                        const stops = [];
                        for (let s = 0; s < stopCount; s++) {
                            stops.push({
                                offset: reader.f32(),
                                r: reader.f32(),
                                g: reader.f32(),
                                b: reader.f32(),
                                a: reader.f32(),
                            });
                        }
                        fills.push({
                            type: fillType,
                            stops,
                            start: [reader.f32(), reader.f32()],
                            end: [reader.f32(), reader.f32()],
                            spread: reader.u32(),
                            focal: [reader.f32(), reader.f32(), reader.f32()], // fx, fy, fr
                            // v11: optional gradient→local affine (elliptical radial).
                            transform: reader.u32()
                                ? [
                                      reader.f32(),
                                      reader.f32(),
                                      reader.f32(),
                                      reader.f32(),
                                      reader.f32(),
                                      reader.f32(),
                                  ]
                                : null,
                        });
                    } else if (fillType === 4) {
                        // Pattern
                        fills.push({
                            type: 4,
                            imageId: reader.u32(),
                            width: reader.f32(),
                            height: reader.f32(),
                            transform: [
                                reader.f32(),
                                reader.f32(),
                                reader.f32(),
                                reader.f32(),
                                reader.f32(),
                                reader.f32(),
                            ],
                        });
                    } else {
                        fills.push({ type: 0 });
                    }
                }

                // ─── Read Strokes ───────────────
                const strokeCount = reader.u32();
                const strokes: any[] = [];
                for (let i = 0; i < strokeCount; i++) {
                    const strokeType = reader.u32();
                    let paint: any = { type: 0 };
                    if (strokeType === 1) {
                        // Solid
                        paint = {
                            type: 1,
                            r: reader.f32(),
                            g: reader.f32(),
                            b: reader.f32(),
                            a: reader.f32(),
                        };
                    } else if (strokeType === 2 || strokeType === 3) {
                        // Gradient
                        const stopCount = reader.u32();
                        const stops = [];
                        for (let s = 0; s < stopCount; s++) {
                            stops.push({
                                offset: reader.f32(),
                                r: reader.f32(),
                                g: reader.f32(),
                                b: reader.f32(),
                                a: reader.f32(),
                            });
                        }
                        paint = {
                            type: strokeType,
                            stops,
                            start: [reader.f32(), reader.f32()],
                            end: [reader.f32(), reader.f32()],
                            spread: reader.u32(),
                            focal: [reader.f32(), reader.f32(), reader.f32()], // fx, fy, fr
                            // v11: optional gradient→local affine (elliptical radial).
                            transform: reader.u32()
                                ? [
                                      reader.f32(),
                                      reader.f32(),
                                      reader.f32(),
                                      reader.f32(),
                                      reader.f32(),
                                      reader.f32(),
                                  ]
                                : null,
                        };
                    } else if (strokeType === 4) {
                        // Pattern
                        paint = {
                            type: 4,
                            imageId: reader.u32(),
                            width: reader.f32(),
                            height: reader.f32(),
                            transform: [
                                reader.f32(),
                                reader.f32(),
                                reader.f32(),
                                reader.f32(),
                                reader.f32(),
                                reader.f32(),
                            ],
                        };
                    }
                    strokes.push({
                        paint,
                        width: reader.f32(),
                        cap: reader.u32(),
                        join: reader.u32(),
                        dashOn: reader.f32(),
                        dashOff: reader.f32(),
                        dashPhase: reader.f32(),
                        miterLimit: reader.f32(),
                        alignment: reader.u32(),
                    });
                }

                const cornerRadius = reader.f32();
                const styleFlags = reader.u32();
                const blendMode = (styleFlags >>> 16) & 0xff;
                const fillRule = (styleFlags >>> 24) & 0xff;

                // Effects block: count + self-describing records (payload size
                // fixed per kind). Read before geometry so offsets stay aligned.
                const effectCount = reader.u32();
                const effects: EffectRecord[] = [];
                for (let e = 0; e < effectCount; e++) {
                    const kind = reader.u32();
                    if (kind === 0) {
                        // Blur: radius_x, radius_y (v11 — anisotropic)
                        const radius = reader.f32();
                        const radiusY = reader.f32();
                        effects.push({
                            kind,
                            radius,
                            radiusY,
                            dx: 0,
                            dy: 0,
                            r: 0,
                            g: 0,
                            b: 0,
                            a: 0,
                        });
                    } else if (kind === 1) {
                        // DropShadow: dx,dy,blur,r,g,b,a
                        const dx = reader.f32(),
                            dy = reader.f32(),
                            radius = reader.f32();
                        effects.push({
                            kind,
                            radius,
                            radiusY: radius,
                            dx,
                            dy,
                            r: reader.f32(),
                            g: reader.f32(),
                            b: reader.f32(),
                            a: reader.f32(),
                        });
                    } else if (kind === 2) {
                        // ColorMatrix: 20 floats + 1 u32 (linearRGB flag)
                        const matrix: number[] = [];
                        for (let i = 0; i < 20; i++) matrix.push(reader.f32());
                        const linearRGB = reader.u32() !== 0;
                        effects.push({
                            kind,
                            radius: 0,
                            radiusY: 0,
                            dx: 0,
                            dy: 0,
                            r: 0,
                            g: 0,
                            b: 0,
                            a: 0,
                            matrix,
                            linearRGB,
                        });
                    }
                }

                // Clip-capture: this DRAW_NODE is the mask shape of a geometric
                // clip span (mask_type 2) — apply its geometry as a canvas clip
                // instead of drawing it. The record is length-framed, so the
                // remainder (its geometry was consumed to build the path) can
                // be skipped exactly.
                const clipSpan = this._maskStack[this._maskStack.length - 1];
                if (clipSpan && clipSpan.mode === 2 && clipSpan.pendingClip) {
                    clipSpan.pendingClip = false;
                    let clipped = false;
                    if (nodeType === 0 || nodeType === 1 || nodeType === 2) {
                        // Reuse the node-transformed clip path across frames;
                        // rebuilding costs a wasm path copy + transform per
                        // span per frame.
                        const key = `${fillRule}|${matrix.join(',')}`;
                        let entry = this._clipPathCache.get(nodeId);
                        if (!entry || entry.key !== key) {
                            const p = this.getBinaryGeometryPath(
                                nodeType,
                                reader,
                                cornerRadius,
                                nodeId,
                            );
                            if (p) {
                                p.setFillType(
                                    fillRule === 1
                                        ? this.ck.FillType.EvenOdd
                                        : this.ck.FillType.Winding,
                                );
                                p.transform(matrix);
                                if (entry) entry.path.delete();
                                entry = { path: p, key };
                                this._clipPathCache.set(nodeId, entry);
                            }
                        }
                        if (entry) {
                            // AA matches the content AA (off only in the
                            // supersampled export pass, where the downscale
                            // supplies it).
                            canvas.clipPath(entry.path, this.ck.ClipOp.Intersect, contentAA);
                            clipped = true;
                        }
                    }
                    if (!clipped) {
                        // Unclippable geometry (text/image) — hide the span,
                        // matching what an empty alpha mask would produce.
                        canvas.clipRect(
                            this.ck.LTRBRect(0, 0, 0, 0),
                            this.ck.ClipOp.Intersect,
                            false,
                        );
                    }
                    reader.offset = recordStart + recordLen;
                    continue;
                }

                // Deferred mask layers: this DRAW_NODE is the mask shape of an
                // alpha/luma span — open the span's layers bounded to this
                // shape's extent (geometry + stroke + filter spill, mapped by
                // its matrix) before it draws its coverage into them.
                if (clipSpan?.pendingLayer) {
                    let maskBounds: ReturnType<CanvasKit['LTRBRect']> | null = null;
                    // A ColorMatrix effect can tint fully-transparent pixels,
                    // giving the mask coverage beyond its geometry — keep the
                    // layer unbounded in that case.
                    if (effects.every((e) => e.kind === 0 || e.kind === 1)) {
                        const gb = this.peekGeometryBounds(nodeType, reader, cornerRadius, nodeId);
                        if (gb) {
                            let pad = 2 / clipMaskDevScale; // AA fringe
                            for (const st of strokes)
                                if (st.paint.type !== 0) pad = Math.max(pad, st.width);
                            for (const e of effects) {
                                if (e.kind === 0) {
                                    pad += 3 * Math.max(e.radius, e.radiusY);
                                } else {
                                    pad += 3 * e.radius + Math.max(Math.abs(e.dx), Math.abs(e.dy));
                                }
                            }
                            const l = gb[0] - pad;
                            const t = gb[1] - pad;
                            const rt = gb[2] + pad;
                            const bt = gb[3] + pad;
                            let minX = Infinity;
                            let minY = Infinity;
                            let maxX = -Infinity;
                            let maxY = -Infinity;
                            for (const [x, y] of [
                                [l, t],
                                [rt, t],
                                [l, bt],
                                [rt, bt],
                            ]) {
                                const mx = matrix[0] * x + matrix[1] * y + matrix[2];
                                const my = matrix[3] * x + matrix[4] * y + matrix[5];
                                if (mx < minX) minX = mx;
                                if (mx > maxX) maxX = mx;
                                if (my < minY) minY = my;
                                if (my > maxY) maxY = my;
                            }
                            maskBounds = this.ck.LTRBRect(minX, minY, maxX, maxY);
                        }
                    }
                    this.openMaskLayers(canvas, clipSpan, maskBounds);
                }

                canvas.save();
                canvas.concat(matrix);

                // Wrap the node's drawing in a filtered layer so blur/shadow
                // apply to the composited result (fills + strokes + image).
                let effectLayerOpen = false;
                if (effects.length > 0) {
                    const filter = this.getEffectFilter(effects);
                    if (filter) {
                        if (!this._effectPaint) this._effectPaint = new this.ck.Paint();
                        this._effectPaint.setImageFilter(filter);
                        // Bound the filtered layer to the node's geometry plus
                        // the filter spill (3σ covers a gaussian's visible
                        // extent) and stroke width. An unbounded saveLayer
                        // allocates a full-viewport texture per filtered node
                        // — that, times every blurred node, dominates frame
                        // time at high zoom. ColorMatrix effects can tint
                        // fully-transparent pixels, so only pure blur/shadow
                        // stacks are bounded.
                        let layerBounds: ReturnType<CanvasKit['LTRBRect']> | undefined;
                        if (effects.every((e) => e.kind === 0 || e.kind === 1)) {
                            const gb = this.peekGeometryBounds(
                                nodeType,
                                reader,
                                cornerRadius,
                                nodeId,
                            );
                            if (gb) {
                                let pad = 0;
                                for (const st of strokes)
                                    if (st.paint.type !== 0) pad = Math.max(pad, st.width);
                                let spill = 0;
                                for (const e of effects) {
                                    if (e.kind === 0) {
                                        spill = Math.max(spill, 3 * Math.max(e.radius, e.radiusY));
                                    } else {
                                        spill = Math.max(
                                            spill,
                                            3 * e.radius + Math.max(Math.abs(e.dx), Math.abs(e.dy)),
                                        );
                                    }
                                }
                                pad += spill;
                                layerBounds = this.ck.LTRBRect(
                                    gb[0] - pad,
                                    gb[1] - pad,
                                    gb[2] + pad,
                                    gb[3] + pad,
                                );
                            }
                        }
                        canvas.saveLayer(this._effectPaint, layerBounds);
                        effectLayerOpen = true;
                    }
                }

                const startGeoOffset = reader.offset;
                const geoSize = reader.view.getUint32(startGeoOffset, true);

                // Apply blend mode (shared across fill + stroke passes)
                const ckBlendModes = this.ckBlendModes();
                if (blendMode > 0 && blendMode < ckBlendModes.length) {
                    p.setBlendMode(ckBlendModes[blendMode]);
                }

                // Image nodes (type 5) carry no fills/strokes — draw the raster
                // and skip the fill/stroke passes.
                if (nodeType === 5) {
                    reader.offset = startGeoOffset + 4; // skip the geometry size u32
                    const iw = reader.f32();
                    const ih = reader.f32();
                    const imageId = reader.u32();
                    this.drawImageNode(canvas, imageId, iw, ih, nodeAlpha);
                    reader.offset = startGeoOffset + 4 + geoSize;
                }
                // Fill Pass(es)
                else if (fills.length === 0 && strokes.length === 0) {
                    reader.offset += 4 + geoSize; // Skip geometry if totally invisible
                } else {
                    for (const fill of fills) {
                        if (fill.type === 0) continue;
                        reader.offset = startGeoOffset; // Rewind geometry reader
                        if (fill.type === 1) {
                            p.setColor(this.ck.Color4f(fill.r, fill.g, fill.b, fill.a * nodeAlpha));
                            p.setShader(null);
                        } else if (fill.type === 2 || fill.type === 3) {
                            const fillShader = this.getOrCreateGradientShader(
                                fill.type,
                                fill.stops,
                                fill.start,
                                fill.end,
                                nodeAlpha,
                                fill.spread,
                                fill.focal,
                                fill.transform,
                            );
                            // A shader is still modulated by the paint's alpha,
                            // and a prior solid/semi-transparent fill may have
                            // left it < 1 (e.g. an opacity-folded shadow drawn
                            // just before). nodeAlpha is already baked into the
                            // shader's stop colors, so force the paint opaque or
                            // the gradient renders washed out.
                            p.setAlphaf(1);
                            p.setShader(fillShader);
                        } else if (fill.type === 4) {
                            p.setColor(this.ck.Color4f(1, 1, 1, nodeAlpha)); // alpha via color
                            p.setShader(
                                this.getPatternShader(
                                    fill.imageId,
                                    fill.width,
                                    fill.height,
                                    fill.transform,
                                ),
                            );
                        }
                        p.setStyle(this.ck.PaintStyle.Fill);
                        this.drawBinaryGeometry(
                            canvas,
                            nodeType,
                            reader,
                            p,
                            cornerRadius,
                            fillRule,
                            nodeId,
                        );
                        p.setShader(null);
                    }
                    if (fills.length === 0) {
                        // Skip geometry once if there were no fills, so strokes can rewind
                        reader.offset += 4 + geoSize;
                    }

                    // Stroke Pass(es)
                    const ckCaps = [
                        this.ck.StrokeCap.Butt,
                        this.ck.StrokeCap.Round,
                        this.ck.StrokeCap.Square,
                    ];
                    const ckJoins = [
                        this.ck.StrokeJoin.Miter,
                        this.ck.StrokeJoin.Round,
                        this.ck.StrokeJoin.Bevel,
                    ];

                    for (const st of strokes) {
                        if (st.paint.type === 0 || st.width <= 0) continue;
                        reader.offset = startGeoOffset; // Rewind geometry reader

                        if (st.paint.type === 1) {
                            p.setColor(
                                this.ck.Color4f(
                                    st.paint.r,
                                    st.paint.g,
                                    st.paint.b,
                                    st.paint.a * nodeAlpha,
                                ),
                            );
                            p.setShader(null);
                        } else if (st.paint.type === 2 || st.paint.type === 3) {
                            const strokeShader = this.getOrCreateGradientShader(
                                st.paint.type,
                                st.paint.stops,
                                st.paint.start,
                                st.paint.end,
                                nodeAlpha,
                                st.paint.spread,
                                st.paint.focal,
                                st.paint.transform,
                            );
                            // Reset any leftover paint alpha (see fill gradient).
                            p.setAlphaf(1);
                            p.setShader(strokeShader);
                        } else if (st.paint.type === 4) {
                            p.setColor(this.ck.Color4f(1, 1, 1, nodeAlpha));
                            p.setShader(
                                this.getPatternShader(
                                    st.paint.imageId,
                                    st.paint.width,
                                    st.paint.height,
                                    st.paint.transform,
                                ),
                            );
                        }

                        p.setStyle(this.ck.PaintStyle.Stroke);

                        // 0: Center, 1: Inner, 2: Outer
                        if (st.alignment === 0) {
                            p.setStrokeWidth(st.width);
                        } else {
                            // Multiply by 2 because clip will hide half of it
                            p.setStrokeWidth(st.width * 2);
                        }

                        p.setStrokeCap(ckCaps[st.cap] ?? this.ck.StrokeCap.Butt);
                        p.setStrokeJoin(ckJoins[st.join] ?? this.ck.StrokeJoin.Miter);
                        p.setStrokeMiter(st.miterLimit);

                        let dashEffect = null;
                        if (st.dashOn > 0) {
                            dashEffect = this.ck.PathEffect.MakeDash(
                                [st.dashOn, st.dashOff],
                                st.dashPhase,
                            );
                            p.setPathEffect(dashEffect);
                        }

                        if (st.alignment === 1 || st.alignment === 2) {
                            // Need to parse geometry path to clip
                            const tempPath = this.getBinaryGeometryPath(
                                nodeType,
                                reader,
                                cornerRadius,
                                nodeId,
                            );
                            if (tempPath) {
                                canvas.save();
                                if (st.alignment === 1) {
                                    // Inner
                                    canvas.clipPath(tempPath, this.ck.ClipOp.Intersect, true);
                                } else if (st.alignment === 2) {
                                    // Outer
                                    canvas.clipPath(tempPath, this.ck.ClipOp.Difference, true);
                                }
                                canvas.drawPath(tempPath, p);
                                canvas.restore();
                                tempPath.delete();
                            }
                        } else {
                            // Standard draw
                            this.drawBinaryGeometry(
                                canvas,
                                nodeType,
                                reader,
                                p,
                                cornerRadius,
                                undefined,
                                nodeId,
                            );
                        }

                        if (dashEffect) {
                            p.setPathEffect(null);
                            dashEffect.delete();
                        }
                        p.setShader(null);
                    }

                    // Arrowhead / line-ending markers (on top of the stroke, in
                    // the node's local space — so they export with the artwork).
                    this.drawNodeMarkers(canvas, nodeId, strokes);

                    if (strokes.length === 0 && fills.length > 0) {
                        // Keep reader at the end of geometry
                        reader.offset = startGeoOffset + 4 + geoSize;
                    } else if (strokes.length > 0) {
                        // After last stroke, reader is already at the end of geometry
                        reader.offset = startGeoOffset + 4 + geoSize;
                    }
                }

                // Reset blend mode after all passes
                if (blendMode > 0) {
                    p.setBlendMode(this.ck.BlendMode.SrcOver);
                }

                if (effectLayerOpen) canvas.restore(); // composite the filtered layer
                canvas.restore();
            }

            // Framing check: every record declared its own byte length. If the
            // reader didn't consume exactly that, writer/reader layouts have
            // skewed (usually a stale engine/pkg). Report once, then resync to
            // the declared record boundary so the rest of the frame still draws.
            const consumed = reader.offset - recordStart;
            if (consumed !== recordLen) {
                if (!this._protocolDesyncWarned) {
                    console.error(
                        `Render protocol desync at command ${i} (cmdType=${cmdType}, node=${nodeId}): ` +
                            `consumed ${consumed} bytes but record declared ${recordLen}. ` +
                            `Writer/reader layout skew — engine/pkg is likely stale.`,
                    );
                    this._protocolDesyncWarned = true;
                }
                reader.offset = recordStart + recordLen;
            }
        }

        // Live Paint faces/edges are no longer drawn here — they're emitted
        // in-stream at the group's z (CMD_LP_FACES/EDGES) so members' strokes
        // sit on top, like Illustrator.

        // Kick off any sprite bakes queued during this frame (debounced until
        // the view settles; skipped inside export/bake passes). Also self-heal
        // a stranded tile queue: a schedule request during a busy drain is
        // dropped, so re-arm it from the frame loop.
        if (!exporting && snapshotPass === null) {
            if (this._spriteWanted.size > 0) this.scheduleSpriteBakes();
            if (this._tileBakeQueue.size > 0) this.scheduleTileBakes();
        }

        // Static content above the moving nodes, blitted over them so z-order
        // holds during a cached drag (still under the editor overlays below).
        if (dragActive && this._dragLayer?.above) {
            this.drawDragLayerImage(canvas, this._dragLayer.above);
        }

        // Editor overlays — never part of exported output or drag snapshots.
        if (!exporting && snapshotPass === null) {
            // Draw live preview shape (while user is dragging to create)
            this.drawPreview(canvas);
            // Draw the parametric-action preview (ghost of Offset/Simplify/Blend)
            this.drawShapePreview(canvas);
            // Draw pen tool in-progress path
            this.drawPenPreview(canvas);
            // Draw paint bucket hover preview
            this.drawPaintBucketHover(canvas);
            // Draw marquee selection rectangle
            this.drawMarquee(canvas);
            // Draw persistent ruler guides (under the transient snap guides)
            this.drawGuides(canvas, viewportMinX, viewportMinY, viewportMaxX, viewportMaxY);
            // Draw snapping alignment guides
            this.drawSnapGuides(canvas, viewportMinX, viewportMinY, viewportMaxX, viewportMaxY);
            // Draw smart measurements (selection ↔ hovered object distances)
            this.drawMeasurements(canvas);
        }

        canvas.restore();

        if (!exporting && snapshotPass === null) {
            // Draw hover outline (shape under cursor, selection tool)
            this.drawHoverOutline(canvas, dpr);
            // Draw selection overlay
            this.renderSelectionOverlay(canvas, dpr);
            // Draw gradient editing handles (axis + stops on the shape)
            this.drawGradientOverlay(canvas, dpr);
            // Draw direct selection edit handles
            this.drawDirectEditHandles(canvas, dpr);
            // Draw scissors / add-point hover dot
            this.drawScissorsPreview(canvas, dpr);
        }

        this.surface.flush();

        // Keep the ruler strips in step with the current pan/zoom.
        if (!exporting && snapshotPass === null) this.guidesController?.syncRulers();
    }

    /**
     * Render the whole document to a PNG at `scale`× (1 world unit → `scale`
     * pixels). Renders into an offscreen raster surface with a transparent
     * background and no editor chrome, reusing the normal draw path via the
     * `_exporting` flag. Returns a PNG Blob (or null if the surface can't be
     * created).
     *
     * The content is rendered SUPERSAMPLED with fill anti-aliasing disabled,
     * then downscaled with a high-quality cubic filter (SSAA). This is what a
     * plain 1-sample raster can't do: two shapes sharing a border tile exactly
     * at the supersampled resolution (no per-shape AA coverage deficit), so the
     * downscale produces a clean, fully-opaque edge with no hairline seam —
     * matching what the GPU-anti-aliased on-screen canvas shows.
     */
    exportPNG(
        scale = 2,
        bounds?: { x: number; y: number; w: number; h: number },
        background?: { r: number; g: number; b: number; a: number },
        outSize?: { w: number; h: number },
    ): Blob | null {
        if (!this.scene.engine || !this.surface) return null;
        const b = bounds ?? {
            x: 0,
            y: 0,
            w: this.scene.engine.get_document_width(),
            h: this.scene.engine.get_document_height(),
        };

        const MAX_DIM = 8192;
        const MAX_PIXELS = 40_000_000;

        // Target output pixels. An explicit outSize wins over the scale factor
        // and may carry a different aspect ratio than the source (ratio unlocked).
        const W = Math.max(1, Math.min(MAX_DIM, Math.round(outSize ? outSize.w : b.w * scale)));
        const H = Math.max(1, Math.min(MAX_DIM, Math.round(outSize ? outSize.h : b.h * scale)));

        // Per-axis output scale (px per source unit). Equal on the scale path;
        // may differ for a custom size with the ratio unlocked.
        const sx = W / b.w;
        const sy = H / b.h;
        // Render uniformly at the finer axis so neither is under-sampled, then
        // resample to exactly W×H in one cubic step (stretches when non-uniform).
        const renderScale = Math.max(sx, sy);
        const renderW = Math.max(1, Math.round(b.w * renderScale));
        const renderH = Math.max(1, Math.round(b.h * renderScale));

        // Pick the largest supersample factor that stays within sane surface
        // limits (memory + max dimension). Falls back to 1× (no supersampling,
        // analytic AA) for very large exports.
        let ss = 4;
        while (
            ss > 1 &&
            (renderW * ss > MAX_DIM ||
                renderH * ss > MAX_DIM ||
                renderW * ss * (renderH * ss) > MAX_PIXELS)
        ) {
            ss--;
        }

        const bigW = renderW * ss;
        const bigH = renderH * ss;
        const bigSurface = this.ck.MakeSurface(bigW, bigH);
        if (!bigSurface) return null;

        // Swap in export state and reuse render(), then restore. The pan offsets
        // the export origin so an off-origin artboard is cropped correctly.
        const savedSurface = this.surface;
        const savedZoom = this.zoom;
        const savedPan = { x: this.pan.x, y: this.pan.y };
        this.surface = bigSurface as unknown as Surface;
        this.zoom = renderScale * ss;
        this.pan = { x: -b.x * renderScale * ss, y: -b.y * renderScale * ss };
        this._exporting = true;
        this._exportBounds = b;
        this._exportBackground = background ?? null;
        this._exportNoAA = ss > 1; // AA off only when the downscale will restore it

        let blob: Blob | null = null;
        try {
            this.render();

            // Resample the supersampled render to the exact target with a
            // Mitchell cubic filter. Straight copy only when the dimensions
            // already match (uniform scale, ss === 1).
            const bigImg = bigSurface.makeImageSnapshot();
            let bytes: Uint8Array | null;
            if (bigW !== W || bigH !== H) {
                const dstSurface = this.ck.MakeSurface(W, H);
                if (!dstSurface) {
                    bigImg.delete();
                    return null;
                }
                const dcanvas = dstSurface.getCanvas();
                dcanvas.clear(this.ck.TRANSPARENT);
                const dpaint = new this.ck.Paint();
                dcanvas.drawImageRectCubic(
                    bigImg,
                    this.ck.LTRBRect(0, 0, bigW, bigH),
                    this.ck.LTRBRect(0, 0, W, H),
                    1 / 3,
                    1 / 3,
                    dpaint,
                );
                const outImg = dstSurface.makeImageSnapshot();
                bytes = outImg.encodeToBytes(); // defaults to PNG
                outImg.delete();
                dpaint.delete();
                dstSurface.delete();
            } else {
                bytes = bigImg.encodeToBytes();
            }
            bigImg.delete();
            // Cast: CanvasKit's Uint8Array<ArrayBufferLike> isn't inferred as a
            // BlobPart under newer TS libs, but it is a valid one at runtime.
            if (bytes) blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' });
        } finally {
            this._exporting = false;
            this._exportBounds = null;
            this._exportBackground = null;
            this._exportNoAA = false;
            this.surface = savedSurface;
            this.zoom = savedZoom;
            this.pan = savedPan;
            bigSurface.delete();
            this.requestRender(); // repaint the on-screen surface
        }
        return blob;
    }

    /** Build a cache key for a gradient and return a cached or newly created shader. */
    private getOrCreateGradientShader(
        gradType: number,
        stops: { offset: number; r: number; g: number; b: number; a: number }[],
        start: [number, number],
        end: [number, number],
        nodeAlpha: number = 1.0,
        /** spreadMethod: 0 = pad, 1 = repeat, 2 = reflect. */
        spread: number = 0,
        /** Radial focal point [fx, fy, fr]; defaults to the center circle. */
        focal: [number, number, number] = [start[0], start[1], 0],
        /** Gradient→local affine [a,b,c,d,e,f] for rotated/elliptical radials;
         *  null = none (start/end/focal are already in node-local space). */
        transform: number[] | null = null,
    ): ReturnType<CanvasKit['Shader']['MakeLinearGradient']> {
        // Stops are stored in insertion order (the editor appends new stops and
        // mutates offsets in place without re-sorting). Skia's gradient builders
        // require monotonically non-decreasing offsets, so sort a copy here —
        // matching the sorted preview in the fill panel.
        stops = [...stops].sort((a, b) => a.offset - b.offset);

        // Build a compact cache key from gradient parameters
        let key = `${gradType}|${start[0]},${start[1]}|${end[0]},${end[1]}|${nodeAlpha}|${spread}|${focal.join(',')}|${transform?.join(',') ?? ''}`;
        for (const s of stops) {
            key += `|${s.offset},${s.r},${s.g},${s.b},${s.a}`;
        }
        const cached = this._gradientCache.get(key);
        if (cached) return cached;

        // spreadMethod → Skia TileMode: pad→Clamp, repeat→Repeat, reflect→Mirror.
        const tileMode =
            spread === 1
                ? this.ck.TileMode.Repeat
                : spread === 2
                  ? this.ck.TileMode.Mirror
                  : this.ck.TileMode.Clamp;
        const colors = stops.map((s) => this.ck.Color4f(s.r, s.g, s.b, s.a * nodeAlpha));
        const offsets = stops.map((s) => s.offset);
        // For a rotated / non-uniform (elliptical) radial, the gradient is
        // defined in raw gradient space and mapped to node-local space by this
        // affine, passed as Skia's local matrix (row-major 3×3). The SVG affine
        // [a,b,c,d,e,f] (x'=a·x+c·y+e) becomes [a,c,e, b,d,f, 0,0,1].
        const localMatrix = transform
            ? [
                  transform[0],
                  transform[2],
                  transform[4],
                  transform[1],
                  transform[3],
                  transform[5],
                  0,
                  0,
                  1,
              ]
            : null;
        let shader: ReturnType<CanvasKit['Shader']['MakeLinearGradient']>;
        if (gradType === 2) {
            // Linear
            shader = this.ck.Shader.MakeLinearGradient(
                start,
                end,
                colors,
                offsets,
                tileMode,
                localMatrix ?? undefined,
            );
        } else {
            // Radial — focal point is the start circle (fx, fy, fr), the
            // center circle is (start, radius). Concentric when focal = center.
            const radius = Math.hypot(end[0] - start[0], end[1] - start[1]);
            shader = this.ck.Shader.MakeTwoPointConicalGradient(
                [focal[0], focal[1]],
                focal[2],
                start,
                radius,
                colors,
                offsets,
                tileMode,
                localMatrix ?? undefined,
            );
        }
        this._gradientCache.set(key, shader);
        return shader;
    }

    /** Peek the local-space bounds of the record's geometry without drawing,
     *  leaving the reader where it started. Cached paths answer without any
     *  allocation. Returns [l,t,r,b], or null for unbounded/unknown geometry. */
    private peekGeometryBounds(
        type: number,
        reader: BinaryReader,
        cornerRadius: number,
        nodeId: number,
    ): [number, number, number, number] | null {
        const start = reader.offset;
        try {
            if (type === 1) {
                reader.u32(); // size
                const w = reader.f32();
                const h = reader.f32();
                return [0, 0, w, h];
            }
            if (type === 2) {
                reader.u32(); // size
                const rx = reader.f32();
                const ry = reader.f32();
                return [-rx, -ry, rx, ry];
            }
            if (type === 0) {
                const cached = this._pathCache.get(nodeId);
                if (cached && nodeId > 0) {
                    const b = cached.path.getBounds();
                    return [b[0], b[1], b[2], b[3]];
                }
                const p = this.getBinaryGeometryPath(type, reader, cornerRadius, nodeId);
                if (!p) return null;
                const b = p.getBounds();
                p.delete();
                return [b[0], b[1], b[2], b[3]];
            }
            return null;
        } finally {
            reader.offset = start;
        }
    }

    private getBinaryGeometryPath(
        type: number,
        reader: BinaryReader,
        cornerRadius: number = 0,
        nodeId: number = 0,
    ) {
        const path = new this.ck.Path();
        reader.u32(); // skip size

        if (type === 1) {
            // Rect
            const w = reader.f32();
            const h = reader.f32();
            if (cornerRadius > 0) {
                const r = Math.min(cornerRadius, w / 2, h / 2);
                path.addRRect(this.ck.RRectXY(this.ck.LTRBRect(0, 0, w, h), r, r));
            } else {
                path.addRect(this.ck.LTRBRect(0, 0, w, h));
            }
        } else if (type === 2) {
            // Ellipse
            const rx = reader.f32();
            const ry = reader.f32();
            path.addOval(this.ck.LTRBRect(-rx, -ry, rx, ry));
        } else if (type === 0) {
            // Path
            const numSubpaths = reader.u32();

            // Check cache
            const cached = this._pathCache.get(nodeId);
            if (cached && nodeId > 0) {
                for (let s = 0; s < numSubpaths; s++) {
                    reader.u32(); // closed
                    const numPoints = reader.u32();
                    reader.offset += numPoints * 6 * 4;
                }
                path.delete();
                return cached.path.copy();
            }

            for (let s = 0; s < numSubpaths; s++) {
                const closed = reader.u32() === 1;
                const numPoints = reader.u32();
                let prevCP2: [number, number] | null = null;
                let firstX = 0,
                    firstY = 0,
                    firstCP1: [number, number] = [0, 0];

                for (let p = 0; p < numPoints; p++) {
                    const x = reader.f32();
                    const y = reader.f32();
                    const cp1x = reader.f32();
                    const cp1y = reader.f32();
                    const cp2x = reader.f32();
                    const cp2y = reader.f32();

                    if (p === 0) {
                        path.moveTo(x, y);
                        firstX = x;
                        firstY = y;
                        firstCP1 = [cp1x, cp1y];
                    } else if (prevCP2) {
                        path.cubicTo(prevCP2[0], prevCP2[1], cp1x, cp1y, x, y);
                    }
                    prevCP2 = [cp2x, cp2y];
                }
                if (closed && numPoints >= 2 && prevCP2) {
                    path.cubicTo(prevCP2[0], prevCP2[1], firstCP1[0], firstCP1[1], firstX, firstY);
                    path.close();
                } else if (closed) {
                    path.close();
                }
            }
        } else if (type === 4) {
            // Text
            reader.f32(); // fontSize
            reader.u32(); // textAlign
            reader.f32(); // lineHeight
            reader.u32(); // fontWeight
            reader.u32(); // italic
            reader.f32(); // letterSpacing
            reader.string(); // fontFamily
            reader.string(); // content
            path.delete();
            return null;
        }
        return path;
    }

    private drawBinaryGeometry(
        canvas: Canvas,
        type: number,
        reader: BinaryReader,
        paint: Paint,
        cornerRadius: number = 0,
        fillRule: number = 0,
        nodeId: number = 0,
    ) {
        reader.u32(); // skip size

        if (type === 1) {
            // Rect
            const w = reader.f32();
            const h = reader.f32();
            if (cornerRadius > 0) {
                // Clamp the radius so opposite corners never overlap
                const r = Math.min(cornerRadius, w / 2, h / 2);
                canvas.drawRRect(this.ck.RRectXY(this.ck.LTRBRect(0, 0, w, h), r, r), paint);
            } else {
                canvas.drawRect(this.ck.LTRBRect(0, 0, w, h), paint);
            }
        } else if (type === 2) {
            // Ellipse
            const rx = reader.f32();
            const ry = reader.f32();
            canvas.drawOval(this.ck.LTRBRect(-rx, -ry, rx, ry), paint);
        } else if (type === 0) {
            // Path
            const numSubpaths = reader.u32();

            // Check path cache first
            const cached = this._pathCache.get(nodeId);
            if (cached && nodeId > 0) {
                // Skip past the binary path data (we already have the cached CK path)
                for (let s = 0; s < numSubpaths; s++) {
                    reader.u32(); // closed
                    const numPoints = reader.u32();
                    reader.offset += numPoints * 6 * 4; // 6 floats per point × 4 bytes
                }
                // Apply fill rule if it changed
                if (fillRule !== cached.fillRule) {
                    cached.path.setFillType(
                        fillRule === 1 ? this.ck.FillType.EvenOdd : this.ck.FillType.Winding,
                    );
                    cached.fillRule = fillRule;
                }
                canvas.drawPath(cached.path, paint);
                return;
            }

            const path = new this.ck.Path();
            for (let s = 0; s < numSubpaths; s++) {
                const closed = reader.u32() === 1;
                const numPoints = reader.u32();
                let prevCP2: [number, number] | null = null;
                let firstX = 0,
                    firstY = 0,
                    firstCP1: [number, number] = [0, 0];

                for (let p = 0; p < numPoints; p++) {
                    const x = reader.f32();
                    const y = reader.f32();
                    const cp1x = reader.f32();
                    const cp1y = reader.f32();
                    const cp2x = reader.f32();
                    const cp2y = reader.f32();

                    if (p === 0) {
                        path.moveTo(x, y);
                        firstX = x;
                        firstY = y;
                        firstCP1 = [cp1x, cp1y];
                    } else if (prevCP2) {
                        path.cubicTo(prevCP2[0], prevCP2[1], cp1x, cp1y, x, y);
                    }
                    prevCP2 = [cp2x, cp2y];
                }
                if (closed && numPoints >= 2 && prevCP2) {
                    path.cubicTo(prevCP2[0], prevCP2[1], firstCP1[0], firstCP1[1], firstX, firstY);
                    path.close();
                } else if (closed) {
                    path.close();
                }
            }
            // Apply fill rule (EvenOdd vs NonZero/Winding)
            if (fillRule === 1) {
                path.setFillType(this.ck.FillType.EvenOdd);
            }
            canvas.drawPath(path, paint);

            // Cache the path for future frames (copy so it survives reuse)
            if (nodeId > 0) {
                this._pathCache.set(nodeId, { path: path.copy(), fillRule });
            }
            path.delete();
        } else if (type === 4) {
            // Text
            const fontSize = reader.f32();
            const textAlign = reader.u32(); // 0=Left, 1=Center, 2=Right
            const lineHeight = reader.f32(); // multiplier
            const fontWeight = reader.u32(); // 100–900
            const italic = reader.u32() !== 0;
            const letterSpacing = reader.f32();
            const fontFamily = reader.string();
            const content = reader.string();

            // While a text node is being edited inline, the HTML overlay stands
            // in for it — skip drawing the underlying node so it isn't doubled.
            if (this._editingTextId === nodeId) return;

            // Text on a path: flow the glyphs along the linked path (the text
            // node's transform is identity, so we draw in world space directly).
            const onPathId = this.scene.getTextPath(nodeId);
            if (onPathId != null && this.scene.getNode(onPathId)) {
                this.drawTextOnPath(canvas, nodeId, content, fontSize, fontFamily, onPathId, paint);
                return;
            }

            // Map text_align to CanvasKit TextAlign enum
            const ckTextAlign =
                textAlign === 1
                    ? this.ck.TextAlign.Center
                    : textAlign === 2
                      ? this.ck.TextAlign.Right
                      : this.ck.TextAlign.Left;

            // Map font weight/style to CanvasKit enums (falls back gracefully
            // when the loaded font lacks the requested variant).
            const ckWeight =
                fontWeight >= 700
                    ? this.ck.FontWeight.Bold
                    : fontWeight >= 600
                      ? this.ck.FontWeight.SemiBold
                      : fontWeight >= 500
                        ? this.ck.FontWeight.Medium
                        : fontWeight <= 300
                          ? this.ck.FontWeight.Light
                          : this.ck.FontWeight.Normal;
            const ckSlant = italic ? this.ck.FontSlant.Italic : this.ck.FontSlant.Upright;

            // Extract current fill color from paint for the paragraph text style
            const paintColor = paint.getColor();

            // Try Paragraph API for rich text rendering
            const fontProvider = buildFontProvider(this.ck);
            const fontFamilies = fontFamily ? [fontFamily, 'sans-serif'] : ['sans-serif'];

            try {
                const paraStyle = new this.ck.ParagraphStyle({
                    textStyle: {
                        color: this.ck.Color4f(
                            paintColor[0],
                            paintColor[1],
                            paintColor[2],
                            paintColor[3],
                        ),
                        fontSize: fontSize,
                        fontFamilies: fontFamilies,
                        heightMultiplier: lineHeight,
                        fontStyle: { weight: ckWeight, slant: ckSlant },
                        letterSpacing: letterSpacing,
                    },
                    textAlign: ckTextAlign,
                });

                if (!fontProvider) {
                    // No fonts are loaded, and CanvasKit 0.39 exposes no default
                    // FontMgr, so the Paragraph API can't be used here. Defer to
                    // the TextBlob fallback below.
                    throw new Error('no font provider available');
                }
                // The paraStyle already lists a 'sans-serif' fallback, so the
                // provider handles missing/empty font families gracefully.
                const builder = this.ck.ParagraphBuilder.MakeFromFontProvider(
                    paraStyle,
                    fontProvider,
                );

                builder.addText(content);
                const para = builder.build();
                // Layout with a generous max width; for left/center/right to matter,
                // we use approx width based on content length (or a fixed large width).
                const layoutWidth = content.includes('\n') ? content.length * fontSize * 0.6 : 1e5;
                para.layout(layoutWidth);

                canvas.drawParagraph(para, 0, -fontSize);

                para.delete();
                builder.delete();
            } catch {
                // Fallback: use simple TextBlob if Paragraph API fails
                const font = new this.ck.Font(null, fontSize);
                const blob = this.ck.TextBlob.MakeFromText(content, font);
                if (blob) {
                    canvas.drawTextBlob(blob, 0, 0, paint);
                    blob.delete();
                }
                font.delete();
            }

            // Trigger lazy font loading if font isn't cached yet
            if (fontFamily && !isFontLoaded(fontFamily)) {
                loadGoogleFontData(fontFamily); // fire-and-forget; repaint via callback
            }
            // Clean up font provider
            if (fontProvider) fontProvider.delete();
        }
    }

    /** Light outline around the node under the cursor (Figma-style hover). */
    private drawHoverOutline(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (!im || im.isMouseDown || im.hoverNodeId === null) return;
        const id = im.hoverNodeId;
        // Skip if already selected — the selection overlay covers it
        if (this.scene.getSelection().includes(id)) return;

        const b = this.scene.getNodeBounds(id);
        if (b[2] <= b[0] || b[3] <= b[1]) return;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const op = this.ensureOverlayPaints();
        op.hoverOutline.setStrokeWidth(1.5 / this.zoom);
        canvas.drawRect(this.ck.LTRBRect(b[0], b[1], b[2], b[3]), op.hoverOutline);
        canvas.restore();
    }

    private renderSelectionOverlay(canvas: Canvas, dpr: number) {
        // The transform box + resize handles are a selection-tool affordance.
        // Hide them for creation/editing tools (pen, rect, direct, …) so a
        // still-selected shape doesn't keep showing handles while you draw.
        if (this.inputManager && this.inputManager.ui.activeTool !== 'selection') return;
        const selection = this.scene.getSelection();
        if (selection.length === 0) return;

        const live = this.inputManager?.liveResizeBounds ?? this.inputManager?.liveFrame;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const op = this.ensureOverlayPaints();
        op.selOutline.setStrokeWidth(1.0 / this.zoom);

        let totalMinX = Infinity,
            totalMinY = Infinity,
            totalMaxX = -Infinity,
            totalMaxY = -Infinity;

        // Draw individual outlines
        for (const id of selection) {
            const nodeTypeNum = this.scene.getNodeType(id);
            if (nodeTypeNum === undefined) continue;

            const bounds = this.scene.getNodeBounds(id);
            totalMinX = Math.min(totalMinX, bounds[0]);
            totalMinY = Math.min(totalMinY, bounds[1]);
            totalMaxX = Math.max(totalMaxX, bounds[2]);
            totalMaxY = Math.max(totalMaxY, bounds[3]);

            // Skip individual outlines for multi-selection to avoid clutter/lag
            if (selection.length > 5 && !live) continue;

            if (nodeTypeNum === 3) {
                // Group: draw the outline oriented under the group's own
                // transform (its local-bounds rect), so it rotates/skews with
                // the group like every other node type — matching the handles,
                // which come from the oriented selection frame. Falling back to
                // the axis-aligned world bounds would make the box "adapt"
                // instead of rotate.
                const lb = this.inputManager?.getNodeLocalBounds(id);
                if (lb) {
                    const transform = this.scene.getTransform(id);
                    canvas.save();
                    canvas.concat(transform);
                    canvas.drawRect(
                        this.ck.LTRBRect(lb.x, lb.y, lb.x + lb.w, lb.y + lb.h),
                        op.selOutline,
                    );
                    canvas.restore();
                } else {
                    const [gMinX, gMinY, gMaxX, gMaxY] = bounds;
                    canvas.drawRect(this.ck.LTRBRect(gMinX, gMinY, gMaxX, gMaxY), op.selOutline);
                }
            } else {
                const transform = this.scene.getTransform(id);
                canvas.save();
                canvas.concat(transform);

                const geo = this.scene.getNodeGeometry(id);
                if (geo.Rect) {
                    canvas.drawRect(
                        this.ck.LTRBRect(0, 0, geo.Rect.width, geo.Rect.height),
                        op.selOutline,
                    );
                } else if (geo.Ellipse) {
                    canvas.drawOval(
                        this.ck.LTRBRect(
                            -geo.Ellipse.radius_x,
                            -geo.Ellipse.radius_y,
                            geo.Ellipse.radius_x,
                            geo.Ellipse.radius_y,
                        ),
                        op.selOutline,
                    );
                } else if (geo.Path) {
                    // Use the resolved (corner-radius-rounded) outline so the
                    // outline matches the rendered shape and the resize handles.
                    const resolved = this.scene.getResolvedSubpaths(id);
                    const pathBounds = this.calculatePathBounds({ subpaths: resolved });
                    canvas.drawRect(
                        this.ck.LTRBRect(
                            pathBounds.minX,
                            pathBounds.minY,
                            pathBounds.maxX,
                            pathBounds.maxY,
                        ),
                        op.selOutline,
                    );
                } else if (geo.Text) {
                    const approxW = geo.Text.content.length * geo.Text.font_size * 0.6;
                    canvas.drawRect(
                        this.ck.LTRBRect(0, -geo.Text.font_size, approxW, 0),
                        op.selOutline,
                    );
                }
                canvas.restore();
            }
        }

        // Selection frame: oriented box for a single node (rotates/skews with
        // the shape), axis-aligned union for multi-selection. During drags the
        // input manager returns the live frame for zero-lag feedback.
        let frame = this.inputManager?.getSelectionFrame() ?? null;
        if (!frame && totalMaxX > totalMinX && totalMaxY > totalMinY) {
            frame = {
                w: totalMaxX - totalMinX,
                h: totalMaxY - totalMinY,
                m: { a: 1, b: 0, c: 0, d: 1, e: totalMinX, f: totalMinY },
            };
        }

        // Draw frame box and handles (skip in node-editing mode — anchors replace resize handles)
        const isNodeEditing = this.inputManager?.editingNodeId != null;
        if (frame && frame.w > 0 && frame.h > 0 && !isNodeEditing) {
            const m = frame.m;
            const pt = (fx: number, fy: number) => ({
                x: m.a * fx + m.c * fy + m.e,
                y: m.b * fx + m.d * fy + m.f,
            });
            const corners = [pt(0, 0), pt(frame.w, 0), pt(frame.w, frame.h), pt(0, frame.h)];

            if (selection.length > 1 || live) {
                const box = new this.ck.Path();
                box.moveTo(corners[0].x, corners[0].y);
                for (let i = 1; i < 4; i++) box.lineTo(corners[i].x, corners[i].y);
                box.close();
                canvas.drawPath(box, op.selOutline);
                box.delete();
            }

            const hSize = 4 / this.zoom;
            const midW = frame.w / 2,
                midH = frame.h / 2;
            const handlePositions = [
                pt(0, 0),
                pt(midW, 0),
                pt(frame.w, 0),
                pt(0, midH),
                pt(frame.w, midH),
                pt(0, frame.h),
                pt(midW, frame.h),
                pt(frame.w, frame.h),
            ];
            // Handle squares tilt with the frame
            const angleDeg = Math.atan2(m.b, m.a) * (180 / Math.PI);

            op.selHandleStroke.setStrokeWidth(1.0 / this.zoom);

            for (const { x: hx, y: hy } of handlePositions) {
                canvas.save();
                canvas.rotate(angleDeg, hx, hy);
                canvas.drawRect(
                    this.ck.LTRBRect(hx - hSize, hy - hSize, hx + hSize, hy + hSize),
                    op.selHandleFill,
                );
                canvas.drawRect(
                    this.ck.LTRBRect(hx - hSize, hy - hSize, hx + hSize, hy + hSize),
                    op.selHandleStroke,
                );
                canvas.restore();
            }
        }

        // Draw corner radius handles for single selection (Rect only — skip in node-editing mode)
        if (selection.length === 1 && !live && !isNodeEditing) {
            const id = selection[0];
            const node = this.scene.getNode(id);
            // Only real rectangles get corner-radius handles. Groups (and other
            // container nodes) report a placeholder Rect{0,0}; guarding on
            // positive dimensions stops that empty rect from drawing a phantom
            // handle stack at the frame's top-left corner.
            if (
                node?.geometry.Rect &&
                node.geometry.Rect.width > 0 &&
                node.geometry.Rect.height > 0
            ) {
                const style = node.style;
                const rect = node.geometry.Rect;
                const radius = style.corner_radius || 0;
                const transform = this.scene.getTransform(id);

                canvas.save();
                canvas.concat(transform);

                // Draw 4 handles inside the corners
                // Use a minimum visual offset so they are always draggable
                const visualMin = 14 / this.zoom;
                const rx = Math.min(Math.max(radius, visualMin), rect.width / 2);
                const ry = Math.min(Math.max(radius, visualMin), rect.height / 2);

                const handlePos = [
                    [rx, ry],
                    [rect.width - rx, ry],
                    [rect.width - rx, rect.height - ry],
                    [rx, rect.height - ry],
                ];

                const hSize = 3.5 / this.zoom;
                for (const [hx, hy] of handlePos) {
                    canvas.drawCircle(hx, hy, hSize, op.selHandleFill);
                    canvas.drawCircle(hx, hy, hSize, op.selHandleStroke);
                }
                canvas.restore();
            }
        }

        canvas.restore();
    }

    /**
     * On-canvas gradient editing overlay (Figma-style): the gradient axis with
     * a start ring, an end square, and color-filled stop dots along the line.
     * Radial gradients additionally show the radius circle in node space.
     * State lives in ui.gradientEdit; only drawn for the selection tool.
     */
    private drawGradientOverlay(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (im?.ui.activeTool !== 'selection' || im.editingNodeId !== null) return;
        const ge = im.ui.gradientEdit;
        if (!ge?.isActive()) return;
        const selection = this.scene.getSelection();
        if (selection.length !== 1 || selection[0] !== ge.nodeId) return;
        const grad = ge.gradient();
        if (!grad) return;

        const { p0, p1 } = ge.endpoints(grad);
        const z = this.zoom;
        const ck = this.ck;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(z, z);

        const halo = new ck.Paint();
        halo.setColor(ck.Color(0, 0, 0, 0.35));
        halo.setStyle(ck.PaintStyle.Stroke);
        halo.setAntiAlias(true);

        const white = new ck.Paint();
        white.setColor(ck.Color(255, 255, 255, 1));
        white.setStyle(ck.PaintStyle.Stroke);
        white.setAntiAlias(true);

        const fill = new ck.Paint();
        fill.setStyle(ck.PaintStyle.Fill);
        fill.setAntiAlias(true);

        const accent = new ck.Paint();
        accent.setColor(ck.Color(0, 162, 255, 1));
        accent.setStyle(ck.PaintStyle.Stroke);
        accent.setAntiAlias(true);

        // Radius circle for radial gradients — drawn in node space so it
        // follows the node's rotation/scale.
        if (grad.gradient_type === 'Radial') {
            const t = this.scene.getTransform(ge.nodeId!);
            const r = Math.hypot(grad.end_x - grad.start_x, grad.end_y - grad.start_y);
            if (r > 1e-6) {
                canvas.save();
                canvas.concat(t);
                // Approximate screen-constant stroke width in node space
                const sx = Math.hypot(t[0], t[3]) || 1;
                halo.setStrokeWidth(2.5 / (z * sx));
                white.setStrokeWidth(1 / (z * sx));
                canvas.drawCircle(grad.start_x, grad.start_y, r, halo);
                canvas.drawCircle(grad.start_x, grad.start_y, r, white);
                canvas.restore();
            }
        }

        // Axis line
        halo.setStrokeWidth(3 / z);
        white.setStrokeWidth(1.5 / z);
        canvas.drawLine(p0.x, p0.y, p1.x, p1.y, halo);
        canvas.drawLine(p0.x, p0.y, p1.x, p1.y, white);

        // Stop dots: white backing disc + stop color + dark outline
        halo.setStrokeWidth(1 / z);
        for (let i = 0; i < grad.stops.length; i++) {
            const s = grad.stops[i];
            const x = p0.x + (p1.x - p0.x) * s.offset;
            const y = p0.y + (p1.y - p0.y) * s.offset;
            const selected = i === ge.stopIndex;
            const r = (selected ? 5.5 : 4.5) / z;
            fill.setColor(ck.Color4f(1, 1, 1, 1));
            canvas.drawCircle(x, y, r, fill);
            fill.setColor(ck.Color4f(s.color.r, s.color.g, s.color.b, s.color.a ?? 1));
            canvas.drawCircle(x, y, r, fill);
            canvas.drawCircle(x, y, r, halo);
            if (selected) {
                accent.setStrokeWidth(1.5 / z);
                canvas.drawCircle(x, y, r + 1.5 / z, accent);
            }
        }

        // Start handle: larger ring (radial: the center)
        white.setStrokeWidth(2 / z);
        halo.setStrokeWidth(3.5 / z);
        canvas.drawCircle(p0.x, p0.y, 8 / z, halo);
        canvas.drawCircle(p0.x, p0.y, 8 / z, white);

        // End handle: square, rotated to the axis (radial: the radius handle)
        const angleDeg = (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI;
        const hs = 6 / z;
        canvas.save();
        canvas.rotate(angleDeg, p1.x, p1.y);
        canvas.drawRect(ck.LTRBRect(p1.x - hs, p1.y - hs, p1.x + hs, p1.y + hs), halo);
        canvas.drawRect(ck.LTRBRect(p1.x - hs, p1.y - hs, p1.x + hs, p1.y + hs), white);
        canvas.restore();

        halo.delete();
        white.delete();
        fill.delete();
        accent.delete();

        canvas.restore();
    }

    calculatePathBounds(path: {
        subpaths: Array<{
            points: Array<{ x: number; y: number; cp1: [number, number]; cp2: [number, number] }>;
            closed: boolean;
        }>;
    }) {
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
        let hasPoints = false;
        for (const sp of path.subpaths) {
            const pts = sp.points;
            const n = pts.length;
            if (n === 0) continue;
            // Include the first anchor
            hasPoints = true;
            minX = Math.min(minX, pts[0].x);
            minY = Math.min(minY, pts[0].y);
            maxX = Math.max(maxX, pts[0].x);
            maxY = Math.max(maxY, pts[0].y);
            // Flatten each cubic segment and include sampled points
            for (let i = 1; i < n; i++) {
                const a = pts[i - 1];
                const b = pts[i];
                this.flattenCubicBounds(
                    a.x,
                    a.y,
                    a.cp2[0],
                    a.cp2[1],
                    b.cp1[0],
                    b.cp1[1],
                    b.x,
                    b.y,
                    (x, y) => {
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                    },
                );
            }
            if (sp.closed && n >= 2) {
                const a = pts[n - 1];
                const b = pts[0];
                this.flattenCubicBounds(
                    a.x,
                    a.y,
                    a.cp2[0],
                    a.cp2[1],
                    b.cp1[0],
                    b.cp1[1],
                    b.x,
                    b.y,
                    (x, y) => {
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                    },
                );
            }
        }
        return hasPoints ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }

    /** Subdivide a cubic Bézier and call cb for sampled points along the curve. */
    private flattenCubicBounds(
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        x3: number,
        y3: number,
        cb: (x: number, y: number) => void,
    ) {
        // Adaptive subdivision: split until segments are flat enough
        const stack: [number, number, number, number, number, number, number, number][] = [
            [x0, y0, x1, y1, x2, y2, x3, y3],
        ];
        const tolerance = 0.5;
        while (stack.length > 0) {
            const [ax, ay, bx, by, cx, cy, dx, dy] = stack.pop()!;
            // Flatness test: max distance of control points from the line a→d
            const ux = 3 * bx - 2 * ax - dx;
            const uy = 3 * by - 2 * ay - dy;
            const vx = 3 * cx - ax - 2 * dx;
            const vy = 3 * cy - ay - 2 * dy;
            const maxDist = Math.max(ux * ux, vx * vx) + Math.max(uy * uy, vy * vy);
            if (maxDist <= 16 * tolerance * tolerance) {
                cb(dx, dy);
            } else {
                // De Casteljau split at t=0.5
                const abx = (ax + bx) / 2,
                    aby = (ay + by) / 2;
                const bcx = (bx + cx) / 2,
                    bcy = (by + cy) / 2;
                const cdx = (cx + dx) / 2,
                    cdy = (cy + dy) / 2;
                const abcx = (abx + bcx) / 2,
                    abcy = (aby + bcy) / 2;
                const bcdx = (bcx + cdx) / 2,
                    bcdy = (bcy + cdy) / 2;
                const mx = (abcx + bcdx) / 2,
                    my = (abcy + bcdy) / 2;
                // Push second half first so first half is processed next
                stack.push([mx, my, bcdx, bcdy, cdx, cdy, dx, dy]);
                stack.push([ax, ay, abx, aby, abcx, abcy, mx, my]);
            }
        }
    }

    private drawGrid(canvas: Canvas, dpr: number) {
        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const op = this.ensureOverlayPaints();
        op.gridPaint.setStrokeWidth(0.5 / this.zoom);

        // Compute visible area in world coords
        const w = this.canvas.width / dpr;
        const h = this.canvas.height / dpr;
        const startX = Math.floor(-this.pan.x / this.zoom / 50) * 50;
        const startY = Math.floor(-this.pan.y / this.zoom / 50) * 50;
        const endX = startX + w / this.zoom + 100;
        const endY = startY + h / this.zoom + 100;

        for (let x = startX; x <= endX; x += 50) {
            canvas.drawLine(x, startY, x, endY, op.gridPaint);
        }
        for (let y = startY; y <= endY; y += 50) {
            canvas.drawLine(startX, y, endX, y, op.gridPaint);
        }

        canvas.restore();
    }

    /** Screen-constant size (world units) for artboard resize handles. */
    private artboardHandleWorld(): number {
        return 4 / this.zoom;
    }

    drawArtboards(canvas: Canvas) {
        const op = this.ensureOverlayPaints();
        const artboards = this.scene.getArtboards();

        for (const ab of artboards) {
            // Background fill (per-artboard color).
            op.artboardFill.setColor(
                this.ck.Color(
                    Math.round(ab.background.r * 255),
                    Math.round(ab.background.g * 255),
                    Math.round(ab.background.b * 255),
                    ab.background.a,
                ),
            );
            canvas.drawRect(
                this.ck.LTRBRect(ab.x, ab.y, ab.x + ab.w, ab.y + ab.h),
                op.artboardFill,
            );

            // Border — accent when selected, gray otherwise.
            const selected = ab.id === this.selectedArtboardId;
            const border = selected ? op.selOutline : op.artboardStroke;
            border.setStrokeWidth(1 / this.zoom);
            canvas.drawRect(this.ck.LTRBRect(ab.x, ab.y, ab.x + ab.w, ab.y + ab.h), border);

            // Name label above the top-left corner, at screen-constant size.
            this.drawArtboardLabel(canvas, ab, selected);

            // Resize handles when selected.
            if (selected) this.drawArtboardHandles(canvas, ab);
        }
    }

    /** A real typeface for `family` (from loaded font bytes), or null to fall
     *  back to CanvasKit's default face. Cached. */
    private getTypeface(family: string) {
        if (this._typefaceCache.has(family)) return this._typefaceCache.get(family) ?? null;
        let tf: ReturnType<CanvasKit['Typeface']['MakeFreeTypeFaceFromData']> | null = null;
        const data = getFontData(family);
        if (data) {
            try {
                tf = this.ck.Typeface.MakeFreeTypeFaceFromData(data);
            } catch {
                tf = null;
            }
        }
        this._typefaceCache.set(family, tf);
        return tf;
    }

    /**
     * Render `content` with its baseline flowing along the world outline of the
     * `pathId` node. Glyphs are placed by arc length via ContourMeasure and
     * rotated to the path tangent with per-glyph RSXforms. The text node's own
     * transform (which keeps its bounds over the path for culling) is undone
     * first so the glyphs land in world space along the path.
     */
    private drawTextOnPath(
        canvas: Canvas,
        textId: number,
        content: string,
        fontSize: number,
        fontFamily: string,
        pathId: number,
        paint: Paint,
    ) {
        const worldPath = nodeToWorldPath(this.ck, this.scene, pathId);
        if (!worldPath) return;

        // The text node has a transform (kept so its bounds overlap the path and
        // it isn't culled). Undo it so we can place glyphs in world space along
        // the path's world outline.
        const inv = invertAffine(this.scene.getTransform(textId));
        canvas.save();
        if (inv) canvas.concat(inv);
        const iter = new this.ck.ContourMeasureIter(worldPath, false, 1);
        const measure = iter.next();
        if (!measure) {
            canvas.restore();
            worldPath.delete();
            return;
        }
        const len = measure.length();

        const font = new this.ck.Font(this.getTypeface(fontFamily), fontSize);
        const text = content.replace(/\n/g, ' ');
        const glyphIDs = font.getGlyphIDs(text);
        const widths = font.getGlyphWidths(glyphIDs);

        const glyphs: number[] = [];
        const xforms: number[] = [];
        let d = 0;
        for (let i = 0; i < glyphIDs.length; i++) {
            const gw = widths[i];
            const center = d + gw / 2;
            d += gw;
            if (center > len) break; // ran off the end of the path
            const pt = measure.getPosTan(center); // [px, py, tanx, tany] (unit tangent)
            const scos = pt[2];
            const ssin = pt[3];
            // Place the glyph so its horizontal midpoint sits on the path point,
            // rotated to the tangent (baseline on the curve).
            glyphs.push(glyphIDs[i]);
            xforms.push(scos, ssin, pt[0] - scos * (gw / 2), pt[1] - ssin * (gw / 2));
        }

        if (glyphs.length > 0) {
            const blob = this.ck.TextBlob.MakeFromRSXformGlyphs(glyphs, xforms, font);
            if (blob) {
                canvas.drawTextBlob(blob, 0, 0, paint);
                blob.delete();
            }
        }
        canvas.restore();
        font.delete();
        measure.delete();
        worldPath.delete();
    }

    /** Draw arrowhead / line-ending markers at an open subpath's ends, in the
     *  node's local space (so they export with the artwork), using the stroke
     *  color and width. Cheap when the node has no markers (map lookup + return). */
    private drawNodeMarkers(
        canvas: Canvas,
        nodeId: number,
        strokes: {
            paint?: { type: number; r: number; g: number; b: number; a: number };
            width: number;
        }[],
    ) {
        const markers = this.scene.getNodeMarkers(nodeId);
        if (!markers || (!markers.start && !markers.end)) return;
        const st =
            strokes.find((s) => s.paint?.type === 1 && s.width > 0) ??
            strokes.find((s) => s.width > 0);
        if (!st) return;
        const sp = this.scene
            .getResolvedSubpaths(nodeId)
            .find((s) => !s.closed && s.points.length >= 2);
        if (!sp) return;
        const pts = sp.points;
        const w = st.width;

        const paint = new this.ck.Paint();
        paint.setStyle(this.ck.PaintStyle.Fill);
        paint.setAntiAlias(true);
        paint.setColor(
            st.paint && st.paint.type === 1
                ? this.ck.Color4f(st.paint.r, st.paint.g, st.paint.b, st.paint.a)
                : this.ck.Color4f(0, 0, 0, 1),
        );

        const norm = (x: number, y: number): [number, number] => {
            const len = Math.hypot(x, y) || 1;
            return [x / len, y / len];
        };
        if (markers.start && markers.start !== 'none') {
            const a = pts[0];
            const cx = a.cp2[0] !== a.x || a.cp2[1] !== a.y ? a.cp2 : [pts[1].x, pts[1].y];
            const [dx, dy] = norm(a.x - cx[0], a.y - cx[1]);
            this.drawMarker(canvas, paint, markers.start, a.x, a.y, dx, dy, w);
        }
        if (markers.end && markers.end !== 'none') {
            const a = pts[pts.length - 1];
            const prev = pts[pts.length - 2];
            const cx = a.cp1[0] !== a.x || a.cp1[1] !== a.y ? a.cp1 : [prev.x, prev.y];
            const [dx, dy] = norm(a.x - cx[0], a.y - cx[1]);
            this.drawMarker(canvas, paint, markers.end, a.x, a.y, dx, dy, w);
        }
        paint.delete();
    }

    /** One marker at (x,y) with outward unit direction (dx,dy), sized to stroke w. */
    private drawMarker(
        canvas: Canvas,
        paint: Paint,
        kind: 'none' | 'arrow' | 'circle' | 'square',
        x: number,
        y: number,
        dx: number,
        dy: number,
        w: number,
    ) {
        if (kind === 'circle') {
            canvas.drawCircle(x, y, w * 1.9, paint);
            return;
        }
        if (kind === 'square') {
            const h = w * 1.7;
            canvas.drawRect(this.ck.LTRBRect(x - h, y - h, x + h, y + h), paint);
            return;
        }
        // Arrow: a triangle with its tip at the end pointing outward.
        const size = w * 3.4;
        const half = w * 2.1;
        const px = -dy;
        const py = dx;
        const tri = new this.ck.Path();
        tri.moveTo(x + dx * w * 0.8, y + dy * w * 0.8); // tip just past the endpoint
        tri.lineTo(x - dx * size + px * half, y - dy * size + py * half);
        tri.lineTo(x - dx * size - px * half, y - dy * size - py * half);
        tri.close();
        canvas.drawPath(tri, paint);
        tri.delete();
    }

    private drawArtboardLabel(canvas: Canvas, ab: Artboard, selected: boolean) {
        const px = 11;
        const size = px / this.zoom;
        const font = new this.ck.Font(null, size);
        const paint = new this.ck.Paint();
        paint.setColor(
            selected ? this.ck.Color(0, 162, 255, 1.0) : this.ck.Color(150, 150, 150, 1.0),
        );
        paint.setAntiAlias(true);
        const blob = this.ck.TextBlob.MakeFromText(ab.name, font);
        if (blob) {
            canvas.drawTextBlob(blob, ab.x, ab.y - 5 / this.zoom, paint);
            blob.delete();
        }
        font.delete();
        paint.delete();
    }

    private drawArtboardHandles(canvas: Canvas, ab: Artboard) {
        const op = this.ensureOverlayPaints();
        const s = this.artboardHandleWorld();
        op.selHandleStroke.setStrokeWidth(1 / this.zoom);
        for (const [hx, hy] of this.artboardHandlePositions(ab)) {
            const r = this.ck.LTRBRect(hx - s, hy - s, hx + s, hy + s);
            canvas.drawRect(r, op.selHandleFill);
            canvas.drawRect(r, op.selHandleStroke);
        }
    }

    /** The 8 resize-handle centers (world space): NW,N,NE,E,SE,S,SW,W. */
    private artboardHandlePositions(ab: Artboard): [number, number][] {
        const { x, y, w, h } = ab;
        const cx = x + w / 2,
            cy = y + h / 2;
        return [
            [x, y],
            [cx, y],
            [x + w, y],
            [x + w, cy],
            [x + w, y + h],
            [cx, y + h],
            [x, y + h],
            [x, cy],
        ];
    }

    private static HANDLE_DIRS: ArtboardHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

    /** Hit-test the resize handles of the selected artboard. */
    artboardHandleHitTest(wx: number, wy: number): { id: number; handle: ArtboardHandle } | null {
        if (this.selectedArtboardId === null) return null;
        const ab = this.scene.getArtboards().find((a) => a.id === this.selectedArtboardId);
        if (!ab) return null;
        const s = this.artboardHandleWorld() * 1.8; // a bit more forgiving than the visual
        const pos = this.artboardHandlePositions(ab);
        for (let i = 0; i < pos.length; i++) {
            if (Math.abs(wx - pos[i][0]) <= s && Math.abs(wy - pos[i][1]) <= s) {
                return { id: ab.id, handle: Renderer.HANDLE_DIRS[i] };
            }
        }
        return null;
    }

    /** Hit-test artboard name labels; returns the artboard id or null. */
    artboardLabelHitTest(wx: number, wy: number): number | null {
        const px = 11;
        const size = px / this.zoom;
        const font = new this.ck.Font(null, size);
        let hit: number | null = null;
        for (const ab of this.scene.getArtboards()) {
            const blob = this.ck.TextBlob.MakeFromText(ab.name, font);
            // Approximate label width; MakeFromText has no measure, so estimate.
            const wApprox = ab.name.length * size * 0.6;
            if (blob) blob.delete();
            const labelTop = ab.y - 5 / this.zoom - size;
            const labelBottom = ab.y - 5 / this.zoom + size * 0.25;
            if (wx >= ab.x && wx <= ab.x + wApprox && wy >= labelTop && wy <= labelBottom) {
                hit = ab.id; // last (topmost) wins
            }
        }
        font.delete();
        return hit;
    }

    /** Union AABB of all artboards, or a default page if none. */
    getArtboardsBounds(): { x: number; y: number; w: number; h: number } {
        const arts = this.scene.getArtboards();
        if (arts.length === 0) return { x: 0, y: 0, w: 1000, h: 1000 };
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
        for (const a of arts) {
            minX = Math.min(minX, a.x);
            minY = Math.min(minY, a.y);
            maxX = Math.max(maxX, a.x + a.w);
            maxY = Math.max(maxY, a.y + a.h);
        }
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    private drawDirectEditHandles(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (!im?.editingPoints || im.editingNodeId === null || !im.editingTransform) return;

        const points = im.editingPoints;
        const t = im.editingTransform;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const dotSize = 4 / this.zoom;
        const handleSize = 3.5 / this.zoom;
        const lineWidth = 1 / this.zoom;

        const linePaint = new this.ck.Paint();
        linePaint.setColor(this.ck.Color(150, 150, 150, 0.8));
        linePaint.setStyle(this.ck.PaintStyle.Stroke);
        linePaint.setStrokeWidth(lineWidth);

        const anchorFill = new this.ck.Paint();
        anchorFill.setColor(this.ck.Color(255, 255, 255, 1.0));
        anchorFill.setStyle(this.ck.PaintStyle.Fill);

        const anchorStroke = new this.ck.Paint();
        anchorStroke.setColor(this.ck.Color(0, 162, 255, 1.0));
        anchorStroke.setStyle(this.ck.PaintStyle.Stroke);
        anchorStroke.setStrokeWidth(lineWidth * 1.5);

        const selectedFill = new this.ck.Paint();
        selectedFill.setColor(this.ck.Color(0, 162, 255, 1.0));
        selectedFill.setStyle(this.ck.PaintStyle.Fill);

        const handleFill = new this.ck.Paint();
        handleFill.setColor(this.ck.Color(0, 162, 255, 1.0));
        handleFill.setStyle(this.ck.PaintStyle.Fill);

        // Draw hover segment highlight
        if (im.hoverSegment) {
            const h = im.hoverSegment;
            const sp = points[h.subpathIndex];
            const p1 = sp.points[h.segmentIndex];
            const p2 = sp.points[(h.segmentIndex + 1) % sp.points.length];

            // Only draw if not closed or not at the end
            if (sp.closed || h.segmentIndex < sp.points.length - 1) {
                const highlightPaint = new this.ck.Paint();
                highlightPaint.setColor(this.ck.Color(0, 162, 255, 0.4));
                highlightPaint.setStyle(this.ck.PaintStyle.Stroke);
                highlightPaint.setStrokeWidth(lineWidth * 3);

                const path = new this.ck.Path();
                const a1 = {
                    x: t[0] * p1.x + t[1] * p1.y + t[2],
                    y: t[3] * p1.x + t[4] * p1.y + t[5],
                };
                const c1 = {
                    x: t[0] * p1.cp2[0] + t[1] * p1.cp2[1] + t[2],
                    y: t[3] * p1.cp2[0] + t[4] * p1.cp2[1] + t[5],
                };
                const c2 = {
                    x: t[0] * p2.cp1[0] + t[1] * p2.cp1[1] + t[2],
                    y: t[3] * p2.cp1[0] + t[4] * p2.cp1[1] + t[5],
                };
                const a2 = {
                    x: t[0] * p2.x + t[1] * p2.y + t[2],
                    y: t[3] * p2.x + t[4] * p2.y + t[5],
                };

                path.moveTo(a1.x, a1.y);
                path.cubicTo(c1.x, c1.y, c2.x, c2.y, a2.x, a2.y);
                canvas.drawPath(path, highlightPaint);

                path.delete();
                highlightPaint.delete();
            }
        }

        for (let si = 0; si < points.length; si++) {
            const sp = points[si];
            for (let i = 0; i < sp.points.length; i++) {
                const p = sp.points[i];
                const ax = t[0] * p.x + t[1] * p.y + t[2];
                const ay = t[3] * p.x + t[4] * p.y + t[5];
                const c1x = t[0] * p.cp1[0] + t[1] * p.cp1[1] + t[2];
                const c1y = t[3] * p.cp1[0] + t[4] * p.cp1[1] + t[5];
                const c2x = t[0] * p.cp2[0] + t[1] * p.cp2[1] + t[2];
                const c2y = t[3] * p.cp2[0] + t[4] * p.cp2[1] + t[5];

                const isSmooth = Math.abs(c1x - ax) > 0.5 || Math.abs(c1y - ay) > 0.5;
                if (isSmooth) {
                    canvas.drawLine(ax, ay, c1x, c1y, linePaint);
                    canvas.drawLine(ax, ay, c2x, c2y, linePaint);
                    canvas.drawCircle(c1x, c1y, handleSize, handleFill);
                    canvas.drawCircle(c2x, c2y, handleSize, handleFill);
                }

                const isSelected = im.selectedPoints.has(`${si}:${i}`);
                canvas.drawCircle(ax, ay, dotSize, isSelected ? selectedFill : anchorFill);
                canvas.drawCircle(ax, ay, dotSize, anchorStroke);
            }
        }

        linePaint.delete();
        anchorFill.delete();
        anchorStroke.delete();
        handleFill.delete();
        canvas.restore();
    }

    /** Draw a preview dot for the scissors / add-point hover. */
    private drawScissorsPreview(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (!im?.scissorsHoverPoint) return;

        const { x, y } = im.scissorsHoverPoint;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const radius = 5 / this.zoom;
        const lineWidth = 1.5 / this.zoom;

        const fill = new this.ck.Paint();
        fill.setColor(this.ck.Color(0, 162, 255, 1.0));
        fill.setStyle(this.ck.PaintStyle.Fill);

        const stroke = new this.ck.Paint();
        stroke.setColor(this.ck.Color(255, 255, 255, 1.0));
        stroke.setStyle(this.ck.PaintStyle.Stroke);
        stroke.setStrokeWidth(lineWidth);

        canvas.drawCircle(x, y, radius, fill);
        canvas.drawCircle(x, y, radius, stroke);

        fill.delete();
        stroke.delete();
        canvas.restore();
    }

    private drawPreview(canvas: Canvas) {
        this.drawStrokePreview(canvas);

        const preview = this.inputManager?.previewRect;
        if (!preview || preview.w < 1 || preview.h < 1) return;

        const { x, y, w, h, tool } = preview;
        const rect = this.ck.LTRBRect(x, y, x + w, y + h);
        // Artboards preview as a plain rectangle (like the rect tool).
        const rectLike = tool === 'rect' || tool === 'artboard';
        const isCustomShape = !rectLike && tool !== 'ellipse';
        const shapePath = isCustomShape ? this.makePreviewPath(tool, x, y, w, h) : null;

        const fillPaint = new this.ck.Paint();
        fillPaint.setColor(this.ck.Color(100, 149, 237, 0.3));
        fillPaint.setStyle(this.ck.PaintStyle.Fill);

        if (rectLike) canvas.drawRect(rect, fillPaint);
        else if (tool === 'ellipse') canvas.drawOval(rect, fillPaint);
        else canvas.drawPath(shapePath!, fillPaint);

        const strokePaint = new this.ck.Paint();
        strokePaint.setColor(this.ck.Color(0, 162, 255, 1.0));
        strokePaint.setStyle(this.ck.PaintStyle.Stroke);
        strokePaint.setStrokeWidth(1.5 / this.zoom);

        if (rectLike) canvas.drawRect(rect, strokePaint);
        else if (tool === 'ellipse') canvas.drawOval(rect, strokePaint);
        else canvas.drawPath(shapePath!, strokePaint);

        shapePath?.delete();
        fillPaint.delete();
        strokePaint.delete();
    }

    /** Live preview stroke for the line and pencil tools (point-based, not a box). */
    /** Ghost of a parametric action's result (Offset/Simplify/Blend), drawn in
     *  world space while its value dialog is open for live feedback. */
    private drawShapePreview(canvas: Canvas) {
        const preview = this.inputManager?.shapePreview;
        if (!preview || preview.subpaths.length === 0) return;

        const path = new this.ck.Path();
        appendSubpathsToPath(path, preview.subpaths);
        path.setFillType(
            preview.fillRule === 1 ? this.ck.FillType.EvenOdd : this.ck.FillType.Winding,
        );

        const fill = new this.ck.Paint();
        fill.setStyle(this.ck.PaintStyle.Fill);
        fill.setColor(this.ck.Color(0, 162, 255, 0.12));
        fill.setAntiAlias(true);
        canvas.drawPath(path, fill);

        const stroke = new this.ck.Paint();
        stroke.setStyle(this.ck.PaintStyle.Stroke);
        stroke.setColor(this.ck.Color(0, 162, 255, 1.0));
        stroke.setStrokeWidth(1.5 / this.zoom);
        stroke.setAntiAlias(true);
        canvas.drawPath(path, stroke);

        path.delete();
        fill.delete();
        stroke.delete();
    }

    private drawStrokePreview(canvas: Canvas) {
        const line = this.inputManager?.previewLine;
        const pencil = this.inputManager?.pencilPoints;
        if (!line && (!pencil || pencil.length < 2)) return;

        const path = new this.ck.Path();
        if (line) {
            path.moveTo(line.x1, line.y1);
            path.lineTo(line.x2, line.y2);
        } else if (pencil) {
            path.moveTo(pencil[0].x, pencil[0].y);
            for (let i = 1; i < pencil.length; i++) path.lineTo(pencil[i].x, pencil[i].y);
        }

        const paint = new this.ck.Paint();
        paint.setColor(this.ck.Color(0, 162, 255, 1.0));
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1.5 / this.zoom);
        paint.setAntiAlias(true);
        canvas.drawPath(path, paint);

        path.delete();
        paint.delete();
    }

    private makePreviewPath(tool: string, x: number, y: number, w: number, h: number) {
        const cx = x + w / 2;
        const cy = y + h / 2;
        const r = Math.min(w, h) / 2;
        const path = new this.ck.Path();

        if (tool === 'polygon') {
            const sides = 6;
            for (let i = 0; i < sides; i++) {
                const angle = (i * 2 * Math.PI) / sides - Math.PI / 2;
                const px = cx + r * Math.cos(angle);
                const py = cy + r * Math.sin(angle);
                if (i === 0) path.moveTo(px, py);
                else path.lineTo(px, py);
            }
            path.close();
        } else {
            const points = 5;
            const outerR = r;
            const innerR = r * 0.4;
            for (let i = 0; i < points * 2; i++) {
                const angle = (i * Math.PI) / points - Math.PI / 2;
                const cr = i % 2 === 0 ? outerR : innerR;
                const px = cx + cr * Math.cos(angle);
                const py = cy + cr * Math.sin(angle);
                if (i === 0) path.moveTo(px, py);
                else path.lineTo(px, py);
            }
            path.close();
        }
        return path;
    }

    /**
     * Smart measurements (Figma-style): with exactly one object selected and the
     * cursor hovering a different object, draw the clear-space gaps between the
     * two bounding boxes as pink lines with distance labels.
     */
    private drawMeasurements(canvas: Canvas) {
        const im = this.inputManager;
        if (!im) return;
        if (im.ui.activeTool !== 'selection' || im.editingNodeId != null) return;
        const sel = this.scene.engine!.get_selection();
        if (sel.length !== 1) return;
        const selId = sel[0];

        // Target = the object hovered while idle, or the nearest object while
        // dragging the selection (Figma shows live spacing during a move).
        let targetId: number | null = null;
        if (im.isMouseDown && im.dragMode === 'move') {
            targetId = this.nearestNode(selId);
        } else if (!im.isMouseDown && im.hoverNodeId != null && im.hoverNodeId !== selId) {
            targetId = im.hoverNodeId;
        }
        if (targetId == null) return;

        const S = this.scene.getNodeBounds(selId);
        const H = this.scene.getNodeBounds(targetId);
        if (!S || S.length < 4 || !H || H.length < 4) return;
        const [sx0, sy0, sx1, sy1] = S;
        const [hx0, hy0, hx1, hy1] = H;

        const paint = new this.ck.Paint();
        paint.setColor(this.ck.Color(255, 45, 120, 0.95));
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1 / this.zoom);
        paint.setAntiAlias(true);
        const cap = 4 / this.zoom; // half-length of the end ticks

        // Outline the object being measured TO, so the numbers have an obvious
        // referent ("the gap between the thing I'm dragging and this one").
        const targetOutline = new this.ck.Paint();
        targetOutline.setColor(this.ck.Color(255, 45, 120, 0.9));
        targetOutline.setStyle(this.ck.PaintStyle.Stroke);
        targetOutline.setStrokeWidth(1.5 / this.zoom);
        targetOutline.setAntiAlias(true);
        canvas.drawRect(this.ck.LTRBRect(hx0, hy0, hx1, hy1), targetOutline);
        targetOutline.delete();

        // Each gap line is anchored to the SELECTED object's center axis. This
        // reads as "measuring from the selection" and keeps the horizontal and
        // vertical labels apart (one sits beside the selection, one below it).
        const selCx = (sx0 + sx1) / 2;
        const selCy = (sy0 + sy1) / 2;
        if (sx1 < hx0) this.drawGap(canvas, paint, sx1, hx0, selCy, 'h', cap);
        else if (hx1 < sx0) this.drawGap(canvas, paint, hx1, sx0, selCy, 'h', cap);
        if (sy1 < hy0) this.drawGap(canvas, paint, sy1, hy0, selCx, 'v', cap);
        else if (hy1 < sy0) this.drawGap(canvas, paint, hy1, sy0, selCx, 'v', cap);

        paint.delete();
    }

    /** Nearest top-level object to `selId` by center distance, excluding the
     *  selection and its ancestors. Used for live measurements during a drag. */
    private nearestNode(selId: number): number | null {
        const S = this.scene.getNodeBounds(selId);
        if (!S || S.length < 4) return null;
        const scx = (S[0] + S[2]) / 2;
        const scy = (S[1] + S[3]) / 2;
        // Exclude the selected node and every ancestor (its own root/group).
        const skip = new Set<number>();
        let p = selId;
        while (p >= 0) {
            skip.add(p);
            p = this.scene.getNodeParent(p);
        }
        let best: number | null = null;
        let bestD = Infinity;
        for (const id of this.scene.getRootNodes()) {
            if (skip.has(id) || !this.scene.getNodeVisible(id)) continue;
            const b = this.scene.getNodeBounds(id);
            if (!b || b.length < 4) continue;
            const d = Math.hypot((b[0] + b[2]) / 2 - scx, (b[1] + b[3]) / 2 - scy);
            if (d < bestD) {
                bestD = d;
                best = id;
            }
        }
        return best;
    }

    /** One gap measurement: a line between `a`→`b` on `axis` at fixed `pos`,
     *  end ticks, and a distance label at the midpoint. */
    private drawGap(
        canvas: Canvas,
        paint: Paint,
        a: number,
        b: number,
        pos: number,
        axis: 'h' | 'v',
        cap: number,
    ) {
        const dist = Math.abs(b - a);
        if (dist < 0.5) return;
        if (axis === 'h') {
            canvas.drawLine(a, pos, b, pos, paint);
            canvas.drawLine(a, pos - cap, a, pos + cap, paint);
            canvas.drawLine(b, pos - cap, b, pos + cap, paint);
            this.drawMeasureLabel(canvas, (a + b) / 2, pos, `${Math.round(dist)}`);
        } else {
            canvas.drawLine(pos, a, pos, b, paint);
            canvas.drawLine(pos - cap, a, pos + cap, a, paint);
            canvas.drawLine(pos - cap, b, pos + cap, b, paint);
            this.drawMeasureLabel(canvas, pos, (a + b) / 2, `${Math.round(dist)}`);
        }
    }

    /** A pink pill with white text at world (cx, cy), sized in screen pixels. */
    private drawMeasureLabel(canvas: Canvas, cx: number, cy: number, text: string) {
        const size = 11 / this.zoom;
        const font = new this.ck.Font(null, size);
        let w = 0;
        try {
            const widths = font.getGlyphWidths(font.getGlyphIDs(text));
            for (let i = 0; i < widths.length; i++) w += widths[i];
        } catch {
            w = text.length * size * 0.6;
        }
        const padX = 5 / this.zoom;
        const padY = 3 / this.zoom;
        const halfW = w / 2 + padX;
        const halfH = size * 0.62 + padY;

        const bg = new this.ck.Paint();
        bg.setColor(this.ck.Color(255, 45, 120, 1.0));
        bg.setStyle(this.ck.PaintStyle.Fill);
        bg.setAntiAlias(true);
        const r = 3 / this.zoom;
        canvas.drawRRect(
            this.ck.RRectXY(this.ck.LTRBRect(cx - halfW, cy - halfH, cx + halfW, cy + halfH), r, r),
            bg,
        );

        const tp = new this.ck.Paint();
        tp.setColor(this.ck.Color(255, 255, 255, 1.0));
        tp.setAntiAlias(true);
        const blob = this.ck.TextBlob.MakeFromText(text, font);
        if (blob) {
            canvas.drawTextBlob(blob, cx - w / 2, cy + size * 0.35, tp);
            blob.delete();
        }
        bg.delete();
        tp.delete();
        font.delete();
    }

    /** Magenta alignment guides for active snaps, spanning the viewport. */
    /** Persistent ruler guides (cyan). The one under the cursor / being dragged
     *  is highlighted so it reads as grab-able. */
    private drawGuides(canvas: Canvas, minX: number, minY: number, maxX: number, maxY: number) {
        const guides = this.scene.getGuides();
        if (guides.x.length === 0 && guides.y.length === 0) return;
        const hi = this.inputManager?.highlightedGuide ?? null;
        const sel = this.inputManager?.selectedGuide ?? null;
        const guidesCtl = this.inputManager?.guides ?? null;

        const base = new this.ck.Paint();
        base.setColor(this.ck.Color(0, 200, 255, 0.7));
        base.setStyle(this.ck.PaintStyle.Stroke);
        base.setStrokeWidth(1 / this.zoom);
        base.setAntiAlias(true);

        const strong = new this.ck.Paint();
        strong.setColor(this.ck.Color(0, 200, 255, 1.0));
        strong.setStyle(this.ck.PaintStyle.Stroke);
        strong.setStrokeWidth(1.5 / this.zoom);
        strong.setAntiAlias(true);

        // Locked guides read as muted grey so they're visibly "fixed".
        const locked = new this.ck.Paint();
        locked.setColor(this.ck.Color(150, 150, 150, 0.9));
        locked.setStyle(this.ck.PaintStyle.Stroke);
        locked.setStrokeWidth(1 / this.zoom);
        locked.setAntiAlias(true);

        const paintFor = (axis: 'x' | 'y', i: number) => {
            const isSel = sel?.axis === axis && sel.index === i;
            const isHi = hi?.axis === axis && hi.index === i;
            if (guidesCtl?.isLocked({ axis, index: i })) return locked;
            return isSel || isHi ? strong : base;
        };
        guides.x.forEach((gx, i) => {
            canvas.drawLine(gx, minY, gx, maxY, paintFor('x', i));
        });
        guides.y.forEach((gy, i) => {
            canvas.drawLine(minX, gy, maxX, gy, paintFor('y', i));
        });
        base.delete();
        strong.delete();
        locked.delete();
    }

    private drawSnapGuides(canvas: Canvas, minX: number, minY: number, maxX: number, maxY: number) {
        const guides = this.inputManager?.activeSnapGuides;
        if (!guides || guides.length === 0) return;

        const paint = new this.ck.Paint();
        paint.setColor(this.ck.Color(255, 51, 170, 0.9));
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1 / this.zoom);
        paint.setAntiAlias(true);

        for (const g of guides) {
            if (g.axis === 'x') {
                canvas.drawLine(g.pos, minY, g.pos, maxY, paint);
            } else {
                canvas.drawLine(minX, g.pos, maxX, g.pos, paint);
            }
        }
        paint.delete();
    }

    private drawMarquee(canvas: Canvas) {
        const marquee = this.inputManager?.marqueeRect;
        if (!marquee || marquee.w < 1 || marquee.h < 1) return;

        const { x, y, w, h } = marquee;
        const rect = this.ck.LTRBRect(x, y, x + w, y + h);

        const fillPaint = new this.ck.Paint();
        fillPaint.setColor(this.ck.Color(0, 120, 255, 0.08));
        fillPaint.setStyle(this.ck.PaintStyle.Fill);
        canvas.drawRect(rect, fillPaint);

        const strokePaint = new this.ck.Paint();
        strokePaint.setColor(this.ck.Color(0, 120, 255, 0.7));
        strokePaint.setStyle(this.ck.PaintStyle.Stroke);
        strokePaint.setStrokeWidth(1 / this.zoom);
        canvas.drawRect(rect, strokePaint);

        fillPaint.delete();
        strokePaint.delete();
    }

    private drawPenPreview(canvas: Canvas) {
        // Continuation indicator: when the idle pen hovers a free endpoint of an
        // existing open path, ring it so the user knows a click would extend it.
        const adopt = this.inputManager?.penHoverAdopt;
        if (adopt) {
            const ap = new this.ck.Paint();
            ap.setColor(this.ck.Color(0, 162, 255, 1.0));
            ap.setStyle(this.ck.PaintStyle.Stroke);
            ap.setStrokeWidth(1.5 / this.zoom);
            canvas.drawCircle(adopt.x, adopt.y, 6 / this.zoom, ap);
            ap.delete();
        }

        const points = this.inputManager?.currentPathPoints;
        if (!points || points.length === 0) return;

        const strokePaint = new this.ck.Paint();
        strokePaint.setColor(this.ck.Color(0, 162, 255, 1.0));
        strokePaint.setStyle(this.ck.PaintStyle.Stroke);
        strokePaint.setStrokeWidth(2 / this.zoom);

        if (points.length >= 2) {
            const path = new this.ck.Path();
            path.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) {
                const prev = points[i - 1];
                const p = points[i];
                path.cubicTo(prev.cp2x, prev.cp2y, p.cp1x, p.cp1y, p.x, p.y);
            }
            // While closing, preview the segment that joins the last anchor back
            // to the first so the user sees the closing curve as they drag it.
            if (this.inputManager?.penPathClosed) {
                const last = points[points.length - 1];
                const first = points[0];
                path.cubicTo(last.cp2x, last.cp2y, first.cp1x, first.cp1y, first.x, first.y);
            }
            canvas.drawPath(path, strokePaint);
            path.delete();
        }

        // Rubber-band preview: the segment the next click would add — from the
        // last anchor to the hovered cursor (Illustrator-style). Snaps shut to
        // the first anchor when a click would close. Only shown while hovering.
        const hover = this.inputManager?.penHoverPos;
        if (hover && !this.inputManager?.penPathClosed) {
            const last = points[points.length - 1];
            const rubber = new this.ck.Path();
            rubber.moveTo(last.x, last.y);
            if (this.inputManager?.penHoverClosing && points.length > 1) {
                const first = points[0];
                rubber.cubicTo(last.cp2x, last.cp2y, first.cp1x, first.cp1y, first.x, first.y);
            } else {
                rubber.cubicTo(last.cp2x, last.cp2y, hover.x, hover.y, hover.x, hover.y);
            }
            const rubberPaint = new this.ck.Paint();
            rubberPaint.setColor(this.ck.Color(0, 162, 255, 0.5));
            rubberPaint.setStyle(this.ck.PaintStyle.Stroke);
            rubberPaint.setStrokeWidth(1.5 / this.zoom);
            canvas.drawPath(rubber, rubberPaint);
            rubberPaint.delete();
            rubber.delete();
        }

        // Close indicator: a ring around the first anchor when a click would
        // close the path (matches Illustrator's "○" close cursor).
        if (this.inputManager?.penHoverClosing && points.length > 1) {
            const first = points[0];
            const ringPaint = new this.ck.Paint();
            ringPaint.setColor(this.ck.Color(0, 162, 255, 1.0));
            ringPaint.setStyle(this.ck.PaintStyle.Stroke);
            ringPaint.setStrokeWidth(1.5 / this.zoom);
            canvas.drawCircle(first.x, first.y, 6 / this.zoom, ringPaint);
            ringPaint.delete();
        }

        const dotPaint = new this.ck.Paint();
        const handleLinePaint = new this.ck.Paint();
        handleLinePaint.setColor(this.ck.Color(150, 150, 150, 0.8));
        handleLinePaint.setStyle(this.ck.PaintStyle.Stroke);
        handleLinePaint.setStrokeWidth(1 / this.zoom);

        const handleDotPaint = new this.ck.Paint();
        handleDotPaint.setColor(this.ck.Color(0, 162, 255, 1.0));
        handleDotPaint.setStyle(this.ck.PaintStyle.Fill);

        dotPaint.setStyle(this.ck.PaintStyle.Fill);
        const dotSize = 4 / this.zoom;
        const handleSize = 3 / this.zoom;

        for (const p of points) {
            const hasCurve = Math.abs(p.cp1x - p.x) > 0.5 || Math.abs(p.cp1y - p.y) > 0.5;
            if (hasCurve) {
                canvas.drawLine(p.x, p.y, p.cp1x, p.cp1y, handleLinePaint);
                canvas.drawLine(p.x, p.y, p.cp2x, p.cp2y, handleLinePaint);
                canvas.drawCircle(p.cp1x, p.cp1y, handleSize, handleDotPaint);
                canvas.drawCircle(p.cp2x, p.cp2y, handleSize, handleDotPaint);
            }

            dotPaint.setColor(this.ck.Color(255, 255, 255, 1.0));
            dotPaint.setStyle(this.ck.PaintStyle.Fill);
            canvas.drawRect(
                this.ck.LTRBRect(p.x - dotSize, p.y - dotSize, p.x + dotSize, p.y + dotSize),
                dotPaint,
            );
            dotPaint.setColor(this.ck.Color(0, 162, 255, 1.0));
            dotPaint.setStyle(this.ck.PaintStyle.Stroke);
            dotPaint.setStrokeWidth(1 / this.zoom);
            canvas.drawRect(
                this.ck.LTRBRect(p.x - dotSize, p.y - dotSize, p.x + dotSize, p.y + dotSize),
                dotPaint,
            );
        }

        handleLinePaint.delete();
        handleDotPaint.delete();
        strokePaint.delete();
        dotPaint.delete();
    }

    /** Read a bézier outline from the render buffer (`[count][x,y,cp1x,cp1y,
     *  cp2x,cp2y]×N`) and build a CanvasKit path. Matches `write_outline_points`. */
    private readOutlinePath(reader: BinaryReader, closed: boolean): Path {
        const n = reader.u32();
        const pts: OutlinePt[] = [];
        for (let i = 0; i < n; i++) {
            pts.push({
                x: reader.f32(),
                y: reader.f32(),
                cp1: [reader.f32(), reader.f32()],
                cp2: [reader.f32(), reader.f32()],
            });
        }
        return this.pathFromOutline(pts, closed);
    }

    /** Reconstruct a CanvasKit path from an anchor+handles outline (the same
     *  cubic reconstruction the binary geometry reader uses). */
    private pathFromOutline(outline: OutlinePt[], closed: boolean): Path {
        const path = new this.ck.Path();
        if (!outline.length) return path;
        path.moveTo(outline[0].x, outline[0].y);
        for (let i = 0; i < outline.length - 1; i++) {
            const a = outline[i],
                b = outline[i + 1];
            path.cubicTo(a.cp2[0], a.cp2[1], b.cp1[0], b.cp1[1], b.x, b.y);
        }
        if (closed && outline.length >= 2) {
            const a = outline[outline.length - 1],
                b = outline[0];
            path.cubicTo(a.cp2[0], a.cp2[1], b.cp1[0], b.cp1[1], b.x, b.y);
            path.close();
        }
        return path;
    }

    private drawPaintBucketHover(canvas: Canvas) {
        // Only while the Live Paint tool is armed — avoids a stale highlight
        // lingering after the user switches tools.
        if (this.inputManager?.ui?.activeTool !== 'paint-bucket') return;
        // Edge hover takes precedence — the cursor is over a line, not a region.
        if (this.hoverEdgeId >= 0 && this.scene.engine) {
            this.drawEdgeHover(canvas);
            return;
        }
        if (this.hoverFaceId < 0 || !this.scene.engine) return;
        try {
            const outline = JSON.parse(
                this.scene.engine.get_face_boundary(this.hoverFaceId),
            ) as OutlinePt[];
            if (!outline || outline.length < 2) return;
            const path = this.pathFromOutline(outline, true);

            const paint = new this.ck.Paint();
            paint.setColor(this.ck.Color(66, 133, 244, 0.3));
            paint.setStyle(this.ck.PaintStyle.Fill);
            paint.setAntiAlias(true);
            canvas.drawPath(path, paint);

            paint.setColor(this.ck.Color(66, 133, 244, 0.8));
            paint.setStyle(this.ck.PaintStyle.Stroke);
            paint.setStrokeWidth(1.5 / this.zoom);
            canvas.drawPath(path, paint);

            path.delete();
            paint.delete();
        } catch {}
    }

    private drawEdgeHover(canvas: Canvas) {
        try {
            const outline = JSON.parse(
                this.scene.engine!.get_edge_polyline(this.hoverEdgeId),
            ) as OutlinePt[];
            if (!outline || outline.length < 2) return;
            const path = this.pathFromOutline(outline, false);

            const paint = new this.ck.Paint();
            paint.setStyle(this.ck.PaintStyle.Stroke);
            paint.setStrokeCap(this.ck.StrokeCap.Round);
            paint.setStrokeJoin(this.ck.StrokeJoin.Round);
            paint.setAntiAlias(true);
            paint.setColor(this.ck.Color(66, 133, 244, 0.9));
            paint.setStrokeWidth(4 / this.zoom);
            canvas.drawPath(path, paint);

            path.delete();
            paint.delete();
        } catch {}
    }
}
