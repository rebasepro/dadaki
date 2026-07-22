// @dadaki/editor — public API.
//
// The editor is embeddable via a single entry point: `createEditor(container,
// options)`. It builds the full editor chrome inside `container`, wires up the
// Rust/WASM scene, renderer, input, panels and document lifecycle, and returns
// an `EditorHandle` the host can drive.
//
// The host is responsible for loading CanvasKit (and, optionally, the `lucide`
// icon global) and passing the CanvasKit instance in via `options.canvasKit`.
// The library never imports Firebase, reads env vars, or reaches into any host
// page structure beyond the `container` it is given.
//
// NOTE (v1): the injected chrome uses stable element ids, so only ONE editor
// instance per document is supported. Full container-scoped, multi-instance
// isolation is a documented future hardening step — see BUILD-PLAN §7.

import type { CanvasKit } from 'canvaskit-wasm';
import { AboutDialog } from './about_dialog';
import { type AgentApi, createAgentApi } from './agent';
import { type AnalyticsSink, logAppEvent, registerAnalyticsSink } from './analytics';
import { AppMenu } from './app_menu';
import { BackupDialog } from './backup_dialog';
import chromeHtml from './chrome.html?raw';
import { ContextBar } from './context_bar';
import { Document } from './document';
import { DocumentManager } from './document_manager';
import { ExportDialog, type ExportOptions } from './export_dialog';
import { FileService } from './file_service';
import { ensureFontCSS, fontsSettled, loadGoogleFontData } from './fonts';
import { GuidesController } from './guides';
import { InputManager } from './input';
import { PersistenceManager } from './persistence';
import { PresenceController } from './presence';
import { Renderer } from './renderer';
import { TabStrip } from './tab_strip';
import { Toolbar } from './toolbar';
import { UIEngine } from './ui';
import { WasmScene } from './wasm_scene';

export type {
    AgentApi,
    AgentCanvas,
    AgentDescription,
    AgentGradient,
    AgentNode,
    AgentPathPoint,
    AgentStyle,
    AgentTextOptions,
} from './agent';
export type { BridgeCredentials, BridgeHandle, BridgeOptions } from './agent_bridge';
export {
    clearBridgeCredentials,
    connectAgentBridge,
    readBridgeCredentials,
} from './agent_bridge';
export type { AnalyticsSink } from './analytics';
export { logAppEvent, registerAnalyticsSink } from './analytics';
export type { Document } from './document';

/** Largest site id the engine's id encoding can represent. */
export const MAX_SITE_ID = 1023;

/**
 * Keep a host-supplied site id inside the range the engine encodes. Out-of-range
 * values are clamped rather than rejected: a bad site id degrades to "shares a
 * range with someone else", which the version check still catches, whereas
 * throwing here would stop the editor opening at all.
 */
function clampSiteId(site: number | undefined): number {
    if (typeof site !== 'number' || !Number.isFinite(site) || site < 0) return 0;
    return Math.min(Math.floor(site), MAX_SITE_ID);
}

export interface EditorOptions {
    /** A CanvasKit instance (host loads canvaskit.js and passes it here). */
    canvasKit: CanvasKit;
    /** Optional analytics sink; if provided it is registered before any event. */
    analyticsSink?: AnalyticsSink;
    /**
     * Restore the editor's own persisted session (open tabs) from IndexedDB.
     * Defaults to true (the standalone app). Hosts that manage documents
     * themselves (e.g. a cloud app) should pass false and use `initialDocument`
     * / `loadBytes` to control what's open.
     */
    restoreSession?: boolean;
    /**
     * When `restoreSession` is false, the single document to open on start.
     * Provide `bytes` (a `.dadaki` snapshot from `exportBytes`) to open an
     * existing document, or omit to start with a blank one.
     */
    initialDocument?: { bytes?: Uint8Array; name?: string };
    /**
     * Identity of this editing session for object-id allocation, 0…1023.
     *
     * Node ids are `(siteId << 22) | counter`, so two sessions given different
     * site ids can create objects concurrently without ever producing the same
     * id — the prerequisite for merging their edits. Hosts that support
     * multiple people (or tabs) in one document must give each a DIFFERENT
     * site id; ids may be reused by sessions that don't overlap in time.
     *
     * Defaults to 0, which reproduces the original single-writer numbering
     * exactly, so single-user hosts can ignore this.
     */
    siteId?: number;
    /**
     * Fired when the user brings a document with content into the editor via
     * built-in chrome the host doesn't mediate — the File → Open picker or a
     * backup restore — always in a new tab, which is active when this fires.
     * Hosts that own persistence (e.g. a cloud app) should persist the new
     * document here; without this hook they'd never learn it exists.
     */
    onDocumentOpened?: (doc: Document) => void;
    /**
     * Fired whenever the active tab changes (including the initial document,
     * which fires before `createEditor` resolves). Lets a host that keys its
     * persistence per-document follow tab switches (URL, save target, badges).
     */
    onDocumentActivated?: (doc: Document) => void;
    /**
     * Fired on every scene mutation, carrying the document that changed. This
     * is the signal a host with its own persistence should drive autosave from:
     * it covers every path that can dirty a document (gestures, menu actions,
     * SVG import, paste, programmatic edits), unlike listening for DOM events
     * on the canvas.
     */
    onDocumentMutated?: (doc: Document) => void;
    /** Fired when a tab is closed, so a host can drop its per-document state. */
    onDocumentClosed?: (doc: Document) => void;
    /**
     * Toggle/inject into the built-in chrome for embedding.
     * - `header: false` hides the whole top header (rarely needed).
     * - `saveButton: false` hides just the built-in Save button — use this when
     *   the host provides its own persistence (e.g. cloud autosave).
     * The host injects its own controls into the header via the slots exposed on
     * `EditorHandle.chrome` (`headerLeading` / `headerTrailing`).
     */
    chrome?: { header?: boolean; saveButton?: boolean };
}

export interface EditorHandle {
    readonly scene: WasmScene;
    readonly ui: UIEngine;
    readonly input: InputManager;
    readonly renderer: Renderer;
    /** Live collaborator presence (peer cursors + selection). The host pipes a
     *  transport into it: `presence.setPeers(...)` in, `presence.onLocalPresence(...)`
     *  out. Inert until the host wires a transport. */
    readonly presence: PresenceController;
    readonly documentManager: DocumentManager;
    readonly fileService: FileService;
    /** The persistence manager (backups live in the host's IndexedDB). */
    readonly persistence: typeof PersistenceManager;
    /**
     * Header injection slots (plain DOM). A host mounts its own controls into
     * `headerLeading` (far left) and `headerTrailing` (far right) — e.g. a
     * React portal — to blend host UI into the editor's own top bar.
     */
    readonly chrome: {
        header: HTMLElement;
        headerLeading: HTMLElement;
        headerTrailing: HTMLElement;
    };
    /** Currently active document, or undefined. */
    activeDocument(): Document | undefined;
    /**
     * Serialize a document to durable bytes (the `.dadaki` protobuf snapshot).
     * Defaults to the active document; pass a `Document.id` to serialize a
     * background tab, which a host needs to flush that tab's pending save
     * without switching to it. Returns null if the document has no live engine.
     */
    exportBytes(docId?: string): Uint8Array | null;
    /**
     * Set the site used to allocate new object ids (see `EditorOptions.siteId`),
     * for hosts that only learn their site after the editor is up — e.g. once a
     * presence handshake says which other sessions are already in the document.
     * Applies to open documents and ones opened later.
     */
    setSiteId(site: number): void;
    /** Serialize the active document to an SVG string (good for previews). */
    exportSVG(): string;
    /**
     * Authoring API for autonomous agents: intent-level verbs (create, style,
     * align, group, boolean) plus `describe()` so an agent can see the scene it
     * is editing. Each call is one undo step; agent edits are ordinary edits as
     * far as history, autosave and the host hooks are concerned.
     */
    readonly agent: AgentApi;
    /**
     * Open a document from durable bytes (as produced by `exportBytes`) in a
     * new tab and activate it.
     */
    loadBytes(bytes: Uint8Array, name?: string): void;
    /** Create a fresh, blank document in a new tab and activate it. */
    newDocument(name?: string): void;
    /** Rename the active document. */
    renameActive(name: string): void;
    /** Open the built-in export dialog (SVG/PNG, scale, per-artboard). */
    openExportDialog(): void;
    /** Resolves once no webfont fetch is in flight. Await before rendering or
     *  exporting straight after an import, or text whose face is still
     *  downloading is captured in a fallback one. */
    fontsReady(): Promise<void>;
    /** Dev/test convenience: run the shape stress harness. */
    stress(opts?: import('./dev_stress').StressOptions): Promise<unknown>;
    /** Tear down the editor: stop rendering and clear the container. */
    destroy(): void;
}

export async function createEditor(
    container: HTMLElement,
    options: EditorOptions,
): Promise<EditorHandle> {
    if (options.analyticsSink) registerAnalyticsSink(options.analyticsSink);

    const ck = options.canvasKit;

    // Build the editor chrome inside the host container.
    container.innerHTML = chromeHtml;
    const appContainer = container.querySelector('#app-container');
    if (options.chrome?.header === false) {
        appContainer?.classList.add('no-chrome-header');
    }
    if (options.chrome?.saveButton === false) {
        appContainer?.classList.add('no-save-btn');
    }
    // Render lucide icons if the host provided the global (icons are optional
    // chrome; the editor still works without them).
    (window as unknown as { lucide?: { createIcons(): void } }).lucide?.createIcons();

    const el = <T extends HTMLElement>(id: string): T => {
        const found = container.querySelector<T>(`#${id}`);
        if (!found) throw new Error(`[dadaki] editor chrome is missing #${id}`);
        return found;
    };

    const wasmScene = new WasmScene(ck);
    await wasmScene.init();

    const canvas = el<HTMLCanvasElement>('editor-canvas');
    const renderer = new Renderer(ck, canvas, wasmScene);
    wasmScene.renderer = renderer;
    const ui = new UIEngine(ck, wasmScene);
    const input = new InputManager(canvas, wasmScene, ui, renderer);
    renderer.inputManager = input;

    // Collaborative presence: peer cursors + selection over the canvas. Purely
    // additive (an overlay + a passive pointer listener) and transport-agnostic
    // — the host feeds peers in and reads local presence out. Selection changes
    // reach it through the UI's sync chokepoint.
    const presence = new PresenceController(canvas, renderer);
    ui.onSelectionChange = (ids) => presence.reportLocalSelection(ids);

    // Tool rail — grouped tools with flyouts
    ui.toolbar = new Toolbar(el<HTMLElement>('toolbar'), ui);

    // Context bar — floating action bar over the canvas
    const canvasContainer = el<HTMLElement>('canvas-container');
    const contextBar = new ContextBar(canvasContainer, ui, input, wasmScene, renderer);
    ui.contextBar = contextBar;

    // Rulers + guides + snap-to-grid.
    const guides = new GuidesController(canvasContainer, wasmScene, renderer, input);
    input.guides = guides;
    renderer.guidesController = guides;

    // ─── File / document lifecycle (multi-tab) ──────────────────────────
    const saveBtn = el<HTMLButtonElement>('save-btn');
    const saveLabel = saveBtn.querySelector('.save-label') as HTMLElement;
    const updateSaveButton = () => {
        const dirty = fileService.activeDoc.dirty;
        saveBtn.classList.toggle('dirty', dirty);
        saveLabel.textContent = dirty ? 'Save' : 'Saved';
        saveBtn.title = dirty ? 'Save changes (⌘S)' : 'All changes saved';
    };

    const fileService = new FileService(wasmScene, ui, new Document('Untitled'), updateSaveButton);
    saveBtn.addEventListener('click', () => fileService.saveActive().catch(console.error));

    const tabStrip = new TabStrip(el<HTMLElement>('tab-strip'), {
        onSelect: (id) => documentManager.activate(id),
        onClose: (id) => documentManager.close(id),
        onNew: () => documentManager.create(),
        onRename: (id, name) => documentManager.rename(id, name),
    });

    const documentManager = new DocumentManager(
        wasmScene,
        ui,
        input,
        renderer,
        fileService,
        tabStrip,
        () => fileService.refreshChrome(),
        50,
        clampSiteId(options.siteId),
    );
    input.fileService = fileService;
    input.documentManager = documentManager;
    // Wire host lifecycle callbacks before the initial document is created so
    // the first activation is observable too.
    documentManager.hostEvents = {
        opened: options.onDocumentOpened,
        activated: options.onDocumentActivated,
        mutated: options.onDocumentMutated,
        closed: options.onDocumentClosed,
    };

    // Export dialog + button.
    const exportDialog = new ExportDialog(
        (opts: ExportOptions) => {
            const arts = wasmScene.getArtboards();
            let bounds: { x: number; y: number; w: number; h: number } | undefined;
            let background: { r: number; g: number; b: number; a: number } | undefined;
            if (opts.artboardId === 'all') {
                bounds = renderer.getArtboardsBounds();
            } else {
                const ab = arts.find((a) => a.id === opts.artboardId) ?? arts[0];
                if (ab) {
                    bounds = { x: ab.x, y: ab.y, w: ab.w, h: ab.h };
                    if (!opts.transparent) background = ab.background;
                }
            }
            if (opts.format === 'png') ui.exportPNG(opts.scale, bounds, background);
            else ui.exportSVG(bounds, background);
        },
        () => wasmScene.getArtboards().map((a) => ({ id: a.id, name: a.name })),
    );
    input.openExportDialog = () => exportDialog.open();
    el<HTMLButtonElement>('export-btn').addEventListener('click', () => exportDialog.open());

    // Version history (backups) dialog.
    const backupDialog = new BackupDialog({
        list: () => PersistenceManager.listBackups(),
        restore: (entry) => documentManager.openBackup(entry),
        remove: (id) => PersistenceManager.deleteBackup(id),
    });

    // About dialog
    const aboutDialog = new AboutDialog();

    // App menu (top-left)
    new AppMenu(el<HTMLButtonElement>('app-menu-btn'), {
        onNew: () => documentManager.create(),
        onOpen: () => documentManager.openFromPicker().catch(console.error),
        onSave: () => fileService.saveActive().catch(console.error),
        onSaveAs: () => fileService.saveActiveAs().catch(console.error),
        onImportSVG: () => ui.importSVGViaPicker(),
        onExport: () => exportDialog.open(),
        onAddArtboard: () => ui.addArtboard(),
        onBackups: () => backupDialog.open().catch(console.error),
        onAbout: () => aboutDialog.open(),
    });

    // Choose the initial document set. Standalone app: restore the previous
    // session. Embedded host: open exactly one document it controls.
    if (options.restoreSession === false) {
        const init = options.initialDocument;
        if (init?.bytes) {
            const doc = new Document(init.name ?? 'Untitled');
            doc.pendingBytes = init.bytes;
            documentManager.adopt(doc);
        } else {
            documentManager.create(init?.name ?? 'Untitled');
        }
    } else {
        await documentManager.restoreSession();
    }
    ui.updateLayerList();

    // Zoom controls
    el<HTMLButtonElement>('zoom-in').addEventListener('click', () => {
        renderer.setZoomCentered(renderer.zoom * 1.25);
        ui.setZoom(renderer.zoom);
    });
    el<HTMLButtonElement>('zoom-out').addEventListener('click', () => {
        renderer.setZoomCentered(renderer.zoom / 1.25);
        ui.setZoom(renderer.zoom);
    });
    el<HTMLButtonElement>('zoom-fit').addEventListener('click', () => {
        renderer.fitToArtboard();
        ui.setZoom(renderer.zoom);
    });

    renderer.start();

    logAppEvent('app_loaded');

    // Render the artwork as it looks on the canvas — framed to the artboard
    // bounds and on a solid canvas — rather than loose shapes on transparency
    // (which reads as an empty/checkerboard preview). This is what hosts use
    // for thumbnails, and what the agent API renders through. Artboards default
    // to a transparent background, so fall back to white (the canvas colour
    // shown in the editor) when there's no opaque fill.
    const exportSVG = (): string => {
        const white = { r: 1, g: 1, b: 1, a: 1 };
        const canvasBg = (bg?: { r: number; g: number; b: number; a: number }) =>
            bg && bg.a > 0 ? bg : white;
        const arts = wasmScene.getArtboards();
        if (arts.length === 1) {
            const ab = arts[0];
            return ui.buildSVGString(
                { x: ab.x, y: ab.y, w: ab.w, h: ab.h },
                canvasBg(ab.background),
            );
        }
        if (arts.length > 1) {
            return ui.buildSVGString(renderer.getArtboardsBounds(), canvasBg(arts[0].background));
        }
        return ui.buildSVGString(undefined, white);
    };

    // Agent authoring surface. Selection goes through the engine (whose
    // `select_node` is add-only, hence the clear) and then refreshes the same
    // panels a human click would, so the editor's chrome reflects agent work.
    const agent = createAgentApi({
        scene: wasmScene,
        ck,
        getSelection: () => Array.from(wasmScene.getSelection()),
        setSelection: (ids: number[]) => {
            wasmScene.engine?.clear_selection();
            for (const id of ids) wasmScene.selectNode(id, true);
            ui.updateLayerList();
            ui.syncWithSelection();
            renderer.requestRender();
        },
        exportSVG,
        measureText: (geo) => renderer.measureText(geo),
        fontsReady: () => fontsSettled(),
        ensureFont: (family: string) => {
            ensureFontCSS(family);
            void loadGoogleFontData(family);
        },
        renderPNG: async (scale: number) => {
            // Text added moments ago may still be fetching its faces; without
            // this the image shows a fallback face and an agent reading it
            // draws the wrong conclusion about its own work.
            await fontsSettled();
            // Frame the artboard, matching exportSVG, so an agent's PNG and its
            // SVG deliverable always show the same thing. The artboard's own
            // background is used, falling back to the white the editor shows.
            const arts = wasmScene.getArtboards();
            const ab = arts[0];
            const bounds = ab
                ? { x: ab.x, y: ab.y, w: ab.w, h: ab.h }
                : renderer.getArtboardsBounds();
            const bg =
                ab?.background && ab.background.a > 0 ? ab.background : { r: 1, g: 1, b: 1, a: 1 };
            const blob = renderer.exportPNG(scale, bounds, bg);
            if (!blob) throw new Error('[agent] PNG export failed (no render surface)');
            const bytes = new Uint8Array(await blob.arrayBuffer());
            // Chunked: String.fromCharCode(...bytes) overflows the call stack
            // on anything but a tiny image. 8k arguments stays well clear of
            // the engine's spread limit, which a big render at high scale would
            // otherwise approach — failing the render rather than the thing
            // that is actually oversized.
            let binary = '';
            const CHUNK = 0x2000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
            }
            return btoa(binary);
        },
        importSVG: (svg: string) =>
            new Promise<number[]>((resolve, reject) => {
                ui.parseSVG(svg, (newRoots) => resolve(newRoots)).catch(reject);
            }),
    });

    return {
        scene: wasmScene,
        ui,
        input,
        renderer,
        presence,
        documentManager,
        fileService,
        persistence: PersistenceManager,
        chrome: {
            header: el<HTMLElement>('header'),
            headerLeading: el<HTMLElement>('header-slot-leading'),
            headerTrailing: el<HTMLElement>('header-slot-trailing'),
        },
        activeDocument: () => documentManager.active() ?? undefined,
        exportBytes: (docId?: string) => {
            const doc = docId ? documentManager.byId(docId) : documentManager.active();
            const engine = doc?.engine;
            if (!engine) return null;
            return new Uint8Array(engine.serialize_proto());
        },
        exportSVG,
        agent,
        /** Resolves once no webfont fetch is in flight. Anything that renders
         *  or exports right after an import should await this, or it captures a
         *  fallback face for text whose real one is still downloading. */
        fontsReady: () => fontsSettled(),
        setSiteId: (site: number) => documentManager.setSiteId(clampSiteId(site)),
        loadBytes: (bytes: Uint8Array, name = 'Untitled') => {
            const doc = new Document(name);
            doc.pendingBytes = bytes;
            documentManager.adopt(doc);
        },
        newDocument: (name = 'Untitled') => {
            documentManager.create(name);
        },
        renameActive: (name: string) => {
            const doc = documentManager.active();
            if (doc) documentManager.rename(doc.id, name);
        },
        openExportDialog: () => exportDialog.open(),
        stress: async (opts?: import('./dev_stress').StressOptions) => {
            const { runStress } = await import('./dev_stress');
            return runStress({ scene: wasmScene, renderer, wasm: wasmScene.wasm }, opts);
        },
        destroy: () => {
            presence.dispose();
            (renderer as { stop?: () => void }).stop?.();
            container.innerHTML = '';
        },
    };
}
