import { defineConfig } from 'vite';

export default defineConfig({
    // Don't let Vite pre-bundle canvaskit — its WASM glue code breaks when transformed
    optimizeDeps: {
        exclude: ['canvaskit-wasm']
    }
});
