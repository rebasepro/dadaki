// @dadaki/app — deployable shell.
//
// This is the ONLY wiring point that knows about the host page. It loads
// CanvasKit, mounts the editor into the page via the library's `createEditor`,
// and owns app-only concerns: the unsaved-changes guard and dev/test globals.
//
// No analytics backend is wired here. The core dispatches events to whatever
// sink a host registers (`analyticsSink`), and this shell registers none — so
// the demo reports nowhere.

import { connectAgentBridge, createEditor, readBridgeCredentials } from '@dadaki/editor';
import '@dadaki/editor/style.css';
import { createIcons, icons } from 'lucide';

// The editor treats `lucide` as an optional host-provided global (it calls
// `window.lucide?.createIcons()` to materialize its `<i data-lucide>` tags).
// We satisfy that contract from a bundled dependency instead of a runtime CDN
// so icons work fully offline — matching how CanvasKit and Inter are self-hosted.
// `createIcons()` needs the full icon set passed in, so we wrap it to preserve
// the editor's no-argument call convention (equivalent to lucide's UMD global).
(window as unknown as { lucide: { createIcons(): void } }).lucide = {
    createIcons: () => createIcons({ icons }),
};

async function bootstrap() {
    // @ts-expect-error - CanvasKitInit is loaded from a <script> tag in index.html
    const ck = await CanvasKitInit({
        locateFile: (file: string) => `/${file}`,
    });

    const mount = document.getElementById('app') as HTMLElement;
    const editor = await createEditor(mount, {
        canvasKit: ck,
    });

    // Global handle used by the SVG conformance harness, the agent MCP server
    // (packages/mcp drives `app.agent` over CDP) and manual debugging.
    (window as unknown as Record<string, unknown>).app = {
        scene: editor.scene,
        ui: editor.ui,
        input: editor.input,
        renderer: editor.renderer,
        agent: editor.agent,
        exportSVG: editor.exportSVG,
        newDocument: editor.newDocument,
        fontsReady: editor.fontsReady,
        presence: editor.presence,
        ck,
    };

    // Attach to an agent bridge if this tab was given one (via
    // ?agentBridge=PORT&token=… , or a previous session). Opt-in only: with no
    // credentials this does nothing at all.
    const bridge = readBridgeCredentials();
    if (bridge) {
        connectAgentBridge(editor.agent, bridge, {
            onStatus: (connected) => {
                document.body.classList.toggle('agent-attached', connected);
            },
        });
    }

    // Warn before leaving if any open document has unsaved changes. Skipped in
    // dev — HMR reloads constantly and the prompt is just noise there.
    if (!import.meta.env.DEV) {
        window.addEventListener('beforeunload', (e) => {
            if (editor.documentManager.all().some((d) => d.dirty)) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    }

    // Dev-only handle for debugging and automated testing.
    if (import.meta.env.DEV) {
        // The whole handle, so a test can drive the same surface a host does
        // (exportSVG, exportThumbnail, exportBytes…) and not just the internals.
        (window as unknown as Record<string, unknown>).__editor = {
            ...editor,
            get doc() {
                return editor.activeDocument();
            },
        };
    }

    console.log('Dadaki Vector Engine Initialized (Rust Core / CanvasKit)');
}

bootstrap().catch((err) => {
    console.error('Failed to initialize engine:', err);
});
