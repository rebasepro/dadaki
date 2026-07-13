import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Root config used only by Vitest — unit tests are colocated in
// packages/editor/src/*.test.ts and run from the repo root (so the engine wasm
// path `engine/pkg/engine_bg.wasm` resolves relative to cwd).
//
// Test entry files import the `engine` workspace package directly; when Vite
// resolves those entry imports from the repo root it can't see the
// packages/editor-local symlink, so alias `engine` to the built wasm-bindgen
// glue explicitly.
export default defineConfig({
    resolve: {
        alias: {
            engine: fileURLToPath(new URL('./engine/pkg/engine.js', import.meta.url)),
        },
    },
    test: {
        environment: 'jsdom',
        include: ['packages/*/src/**/*.test.ts'],
    },
});
