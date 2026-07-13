// @dadaki/app — deployable shell.
//
// This is the ONLY wiring point that knows about the host page and the
// (optional) analytics backend. It loads CanvasKit, mounts the editor into the
// page via the library's `createEditor`, and owns app-only concerns: the
// Firebase analytics sink, the unsaved-changes guard, and dev/test globals.

import { createEditor } from '@dadaki/editor';
import '@dadaki/editor/style.css';
import { createFirebaseAnalyticsSink } from './firebase_analytics';

async function bootstrap() {
    // @ts-expect-error - CanvasKitInit is loaded from a <script> tag in index.html
    const ck = await CanvasKitInit({
        locateFile: (file: string) => `/${file}`,
    });

    const mount = document.getElementById('app') as HTMLElement;
    const editor = await createEditor(mount, {
        canvasKit: ck,
        analyticsSink: createFirebaseAnalyticsSink(),
    });

    // Global handle used by the SVG conformance harness and manual debugging.
    (window as unknown as Record<string, unknown>).app = {
        scene: editor.scene,
        ui: editor.ui,
        input: editor.input,
        renderer: editor.renderer,
        ck,
    };

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
        (window as unknown as Record<string, unknown>).__editor = {
            scene: editor.scene,
            ui: editor.ui,
            input: editor.input,
            renderer: editor.renderer,
            documentManager: editor.documentManager,
            fileService: editor.fileService,
            persistence: editor.persistence,
            get doc() {
                return editor.activeDocument();
            },
            stress: editor.stress,
        };
    }

    console.log('Dadaki Vector Engine Initialized (Rust Core / CanvasKit)');
}

bootstrap().catch((err) => {
    console.error('Failed to initialize engine:', err);
});
