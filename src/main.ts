import { AboutDialog } from './about_dialog';
import { logAppEvent, registerAnalyticsSink } from './analytics';
import { AppMenu } from './app_menu';
import { BackupDialog } from './backup_dialog';
import { ContextBar } from './context_bar';
import { Document } from './document';
import { DocumentManager } from './document_manager';
import { ExportDialog, type ExportOptions } from './export_dialog';
import { FileService } from './file_service';
import { createFirebaseAnalyticsSink } from './firebase_analytics';
import { GuidesController } from './guides';
import { InputManager } from './input';
import { PersistenceManager } from './persistence';
import { Renderer } from './renderer';
import { TabStrip } from './tab_strip';
import { Toolbar } from './toolbar';
import { UIEngine } from './ui';
import { WasmScene } from './wasm_scene';

async function bootstrap() {
    // Wire analytics before anything can emit an event.
    registerAnalyticsSink(createFirebaseAnalyticsSink());

    // @ts-expect-error - Loaded from script tag in index.html
    const ck = await CanvasKitInit({
        locateFile: (file: string) => `/${file}`,
    });

    const wasmScene = new WasmScene(ck);
    await wasmScene.init();

    const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement;
    const renderer = new Renderer(ck, canvas, wasmScene);
    wasmScene.renderer = renderer;
    const ui = new UIEngine(ck, wasmScene);
    const input = new InputManager(canvas, wasmScene, ui, renderer);
    renderer.inputManager = input;
    (window as any).app = { scene: wasmScene, input: input, ui: ui, renderer: renderer, ck: ck };

    // Tool rail — grouped tools with flyouts
    const toolbarEl = document.getElementById('toolbar') as HTMLElement;
    ui.toolbar = new Toolbar(toolbarEl, ui);

    // Context bar — floating action bar over the canvas
    const canvasContainer = document.getElementById('canvas-container') as HTMLElement;
    const contextBar = new ContextBar(canvasContainer, ui, input, wasmScene, renderer);
    ui.contextBar = contextBar;

    // Rulers + guides + snap-to-grid.
    const guides = new GuidesController(canvasContainer, wasmScene, renderer, input);
    input.guides = guides;
    renderer.guidesController = guides;

    // ─── File / document lifecycle (multi-tab) ──────────────────────────
    const tabStripEl = document.getElementById('tab-strip') as HTMLElement;

    // Save button reflects dirty state: "Save" (emphasized) when there are
    // unsaved changes, "Saved" (muted) otherwise. Clicking saves the .dataki.
    const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
    const saveLabel = saveBtn.querySelector('.save-label') as HTMLElement;
    const updateSaveButton = () => {
        const dirty = fileService.activeDoc.dirty;
        saveBtn.classList.toggle('dirty', dirty);
        saveLabel.textContent = dirty ? 'Save' : 'Saved';
        saveBtn.title = dirty ? 'Save changes (⌘S)' : 'All changes saved';
    };

    // FileService starts with a placeholder doc; DocumentManager reassigns
    // activeDoc as soon as it activates the restored/first document. The tab
    // strip shows the name + dirty dot; the header Save button shows save state.
    const fileService = new FileService(wasmScene, ui, new Document('Untitled'), updateSaveButton);
    saveBtn.addEventListener('click', () => fileService.saveActive().catch(console.error));

    const tabStrip = new TabStrip(tabStripEl, {
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
    );
    input.fileService = fileService;
    input.documentManager = documentManager;

    // Export dialog + button. Resolves the chosen artboard (or whole canvas)
    // into export bounds + optional background.
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
    document.getElementById('export-btn')?.addEventListener('click', () => exportDialog.open());

    // Version history (backups) dialog.
    const backupDialog = new BackupDialog({
        list: () => PersistenceManager.listBackups(),
        restore: (entry) => documentManager.openBackup(entry),
        remove: (id) => PersistenceManager.deleteBackup(id),
    });

    // About dialog
    const aboutDialog = new AboutDialog();

    // App menu (top-left)
    const appMenuBtn = document.getElementById('app-menu-btn') as HTMLButtonElement;
    new AppMenu(appMenuBtn, {
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

    // Warn before leaving if any open document has unsaved changes. Skipped in
    // dev — HMR reloads constantly and the prompt is just noise there.
    if (!import.meta.env.DEV) {
        window.addEventListener('beforeunload', (e) => {
            if (documentManager.all().some((d) => d.dirty)) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    }

    // Restore the previous session (open tabs + active) — this activates the
    // first document, which fits the artboard and paints the chrome.
    await documentManager.restoreSession();

    // Populate layers & property panel with any restored session data
    ui.updateLayerList();

    // Zoom controls
    document.getElementById('zoom-in')?.addEventListener('click', () => {
        renderer.setZoomCentered(renderer.zoom * 1.25);
        ui.setZoom(renderer.zoom);
    });
    document.getElementById('zoom-out')?.addEventListener('click', () => {
        renderer.setZoomCentered(renderer.zoom / 1.25);
        ui.setZoom(renderer.zoom);
    });
    document.getElementById('zoom-fit')?.addEventListener('click', () => {
        renderer.fitToArtboard();
        ui.setZoom(renderer.zoom);
    });

    renderer.start();

    // Dev-only handle for debugging and automated testing
    if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__editor = {
            scene: wasmScene,
            ui,
            input,
            renderer,
            contextBar,
            fileService,
            documentManager,
            backupDialog,
            persistence: PersistenceManager,
            get doc() {
                return documentManager.active();
            },
            /** Shape stress harness — see src/dev_stress.ts. */
            stress: async (opts?: import('./dev_stress').StressOptions) => {
                const { runStress } = await import('./dev_stress');
                return runStress({ scene: wasmScene, renderer, wasm: wasmScene.wasm }, opts);
            },
        };
    }

    console.log('Dadaki Vector Engine Initialized (Rust Core / CanvasKit)');
    logAppEvent('app_loaded');
}

bootstrap().catch((err) => {
    console.error('Failed to initialize engine:', err);
});
