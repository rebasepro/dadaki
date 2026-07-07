/**
 * DocumentManager — owns the set of open documents and the active one.
 *
 * Each document holds its own live Engine + History + AutosaveManager (see
 * Document); switching tabs is a pointer swap on the shared WasmScene
 * (D2 in the plan), so switches are instant and per-document undo is preserved.
 * Restored-but-unviewed tabs stay as serialized bytes until first activation.
 */
import { Engine, History } from '../engine/pkg/engine';
import { AutosaveManager, PersistenceManager, type BackupEntry } from './persistence';
import { Document } from './document';
import { FileIO } from './file_io';
import type { WasmScene } from './wasm_scene';
import type { UIEngine } from './ui';
import type { InputManager } from './input';
import type { Renderer } from './renderer';
import type { FileService } from './file_service';
import type { TabStrip } from './tab_strip';

export class DocumentManager {
    private docs: Document[] = [];
    private activeId: string | null = null;

    constructor(
        private scene: WasmScene,
        private ui: UIEngine,
        private input: InputManager,
        private renderer: Renderer,
        private fileService: FileService,
        private tabStrip: TabStrip,
        /** Refresh breadcrumb root + document.title for the active doc. */
        private refreshChrome: () => void,
        private maxHistory = 50,
    ) {}

    // ─── Queries ────────────────────────────────────────────────────────────

    active(): Document | null {
        return this.docs.find(d => d.id === this.activeId) ?? null;
    }

    all(): readonly Document[] {
        return this.docs;
    }

    byId(id: string): Document | undefined {
        return this.docs.find(d => d.id === id);
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    /** Create a new blank document and activate it. */
    create(name = 'Untitled'): Document {
        const doc = new Document(name);
        this.docs.push(doc);
        this.activate(doc.id);
        this.persistManifest();
        return doc;
    }

    /** Adopt an already-built document (e.g. opened from a file) and activate it. */
    adopt(doc: Document): void {
        this.docs.push(doc);
        this.activate(doc.id);
        this.persistManifest();
    }

    /** Restore a version snapshot as a new tab (never overwrites current work). */
    openBackup(entry: BackupEntry): void {
        const time = new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const doc = new Document(`${entry.name} (restored ${time})`);
        doc.pendingBytes = entry.bytes; // lazily deserialized on activate
        this.adopt(doc);
    }

    /** Close a document (with a dirty-confirm). Never leaves zero tabs open. */
    close(id: string): void {
        const doc = this.byId(id);
        if (!doc) return;
        if (doc.dirty && !window.confirm(`"${doc.name}" has unsaved changes. Close anyway?`)) return;

        // Capture a final version snapshot before dropping the working copy, so
        // the closed document stays recoverable from the backups list.
        doc.autosave?.snapshotNow();

        const idx = this.docs.findIndex(d => d.id === id);
        this.docs.splice(idx, 1);
        // Remove the working-copy slot (so it won't reopen), but KEEP its backups.
        PersistenceManager.deleteDocument(id).catch(console.error);

        if (this.docs.length === 0) {
            // Always keep one document open.
            this.create();
            return;
        }
        if (this.activeId === id) {
            const next = this.docs[Math.min(idx, this.docs.length - 1)];
            this.activate(next.id, true);
        } else {
            this.renderTabs();
        }
        this.persistManifest();
    }

    /** Cycle the active tab by direction (+1 next, -1 previous), wrapping. */
    cycle(dir: 1 | -1): void {
        if (this.docs.length < 2) return;
        const idx = this.docs.findIndex(d => d.id === this.activeId);
        const next = (idx + dir + this.docs.length) % this.docs.length;
        this.activate(this.docs[next].id);
    }

    /**
     * Open a file picker and load the chosen file into a NEW tab. If the same
     * file is already open (matched by handle), just activates that tab.
     */
    async openFromPicker(): Promise<void> {
        const picked = await FileIO.pickFile();
        if (!picked) return;

        if (picked.handle) {
            const existing = await this.findOpenByHandle(picked.handle);
            if (existing) { this.activate(existing.id); return; }
        }

        // Create + activate a blank tab so the scene points at its engine, then
        // load into it (SVG import parses into the active engine).
        const isVec = picked.file.name.endsWith('.vec');
        const doc = this.create(stripExt(picked.file.name));
        const ok = await FileIO.loadFile(this.scene.engine!, picked.file, (svg) => this.ui.parseSVG(svg));
        if (!ok) {
            this.close(doc.id);
            return;
        }
        doc.fileHandle = isVec ? picked.handle : null;
        this.scene.invalidateCache();
        doc.markSaved();
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.refreshChrome();
        this.renderTabs();
        doc.autosave?.trigger();
        this.persistManifest();
    }

    private async findOpenByHandle(handle: FileSystemFileHandle): Promise<Document | null> {
        for (const d of this.docs) {
            if (d.fileHandle && (await handle.isSameEntry(d.fileHandle))) return d;
        }
        return null;
    }

    rename(id: string, name: string): void {
        const doc = this.byId(id);
        if (!doc) return;
        doc.name = name;
        doc.autosave?.trigger();
        if (doc.id === this.activeId) this.fileService.activeDoc = doc;
        this.refreshChrome();
        this.renderTabs();
        this.persistManifest();
    }

    /** Switch the editor to a different document. */
    activate(id: string, force = false): void {
        if (!force && id === this.activeId) return;
        const doc = this.byId(id);
        if (!doc) return;

        const outgoing = this.active();

        // 1. Exit any editing / gesture on the outgoing document first, while
        //    the scene still points at its engine.
        this.input.exitEditMode();
        this.input.currentPathPoints = [];
        this.scene.endGesture(); // no-op unless a gesture is mid-flight

        if (outgoing && outgoing !== doc) {
            // 2. Save the outgoing camera.
            outgoing.viewport = {
                zoom: this.renderer.zoom,
                panX: this.renderer.pan.x,
                panY: this.renderer.pan.y,
            };
            // 3. Flush its debounced autosave so nothing is lost on switch.
            outgoing.autosave?.flush();
        }

        // 4. Lazily instantiate the incoming document's engine.
        this.ensureInstantiated(doc);

        // 5. Swap the scene onto it and re-point the mutation handler.
        this.scene.attachDocument(doc);
        this.scene.onMutate = () => this.handleMutation(doc);
        this.activeId = doc.id;
        this.fileService.activeDoc = doc;

        // 6. Restore camera + rebuild UI for the new document.
        if (doc.viewport) {
            this.renderer.zoom = doc.viewport.zoom;
            this.renderer.pan = { x: doc.viewport.panX, y: doc.viewport.panY };
        } else {
            this.renderer.fitToArtboard();
        }
        this.ui.setZoom(this.renderer.zoom);
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.refreshChrome();
        this.renderTabs();
    }

    // ─── Session restore ──────────────────────────────────────────────────

    /**
     * Rebuild the open-document set from IndexedDB. Falls back to migrating the
     * legacy single-scene autosave, or a fresh Untitled document.
     */
    async restoreSession(): Promise<void> {
        const [manifest, stored] = await Promise.all([
            PersistenceManager.loadManifest(),
            PersistenceManager.loadAllDocuments(),
        ]);

        if (manifest && stored.length > 0) {
            const byId = new Map(stored.map(s => [s.id, s]));
            for (const openId of manifest.open) {
                const s = byId.get(openId);
                if (!s) continue;
                const doc = new Document(s.name, s.id);
                doc.fileHandle = s.handle;
                doc.pendingBytes = s.bytes; // stays lazy until activated
                this.docs.push(doc);
            }
        }

        if (this.docs.length === 0) {
            // Migrate a pre-tabs autosave, if present.
            const legacy = await PersistenceManager.loadLegacyScene();
            const doc = new Document('Untitled');
            if (legacy) {
                doc.pendingBytes = legacy;
                PersistenceManager.clearLegacyScene().catch(() => {});
            }
            this.docs.push(doc);
        }

        const wanted = manifest?.active && this.byId(manifest.active) ? manifest.active : this.docs[0].id;
        this.activate(wanted, true);
        this.persistManifest();
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    private handleMutation(doc: Document): void {
        doc.markMutated();
        // Autosave itself is triggered by the WasmScene mutation wrappers via
        // this.scene.autosave (= doc.autosave). Here we only reflect the dirty
        // state in the chrome.
        this.refreshChrome();
        this.renderTabs();
    }

    private ensureInstantiated(doc: Document): void {
        if (doc.engine) return;
        doc.engine = new Engine();
        if (doc.pendingBytes) {
            doc.engine.deserialize_proto(doc.pendingBytes);
            doc.pendingBytes = null;
        }
        doc.history = new History(this.maxHistory);
        doc.autosave = new AutosaveManager(
            doc.engine,
            doc.id,
            () => ({ name: doc.name, handle: doc.fileHandle }),
        );
    }

    private renderTabs(): void {
        this.tabStrip.render(this.docs.map(d => ({
            id: d.id,
            name: d.name,
            dirty: d.dirty,
            active: d.id === this.activeId,
        })));
    }

    private persistManifest(): void {
        PersistenceManager.saveManifest({
            open: this.docs.map(d => d.id),
            active: this.activeId,
        }).catch(console.error);
    }
}

function stripExt(name: string): string {
    return name.replace(/\.(vec|svg)$/i, '');
}
