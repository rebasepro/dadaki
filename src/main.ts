import { Renderer } from './renderer';
import { UIEngine } from './ui';
import { InputManager } from './input';
import { WasmScene } from './wasm_scene';
import { ContextBar } from './context_bar';
import { BreadcrumbBar } from './breadcrumb';

async function bootstrap() {
    // @ts-ignore - Loaded from script tag in index.html
    const ck = await CanvasKitInit({
        locateFile: (file: string) => `/${file}`
    });

    const wasmScene = new WasmScene(ck);
    await wasmScene.init();

    const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement;
    const renderer = new Renderer(ck, canvas, wasmScene);
    wasmScene.renderer = renderer;
    const ui = new UIEngine(ck, wasmScene);
    const input = new InputManager(canvas, wasmScene, ui, renderer);
    renderer.inputManager = input;

    // Context bar — floating action bar over the canvas
    const canvasContainer = document.getElementById('canvas-container') as HTMLElement;
    const contextBar = new ContextBar(canvasContainer, ui, input, wasmScene, renderer);
    ui.contextBar = contextBar;

    // Breadcrumb bar — replaces the static header title
    const headerEl = document.getElementById('header') as HTMLElement;
    const breadcrumbBar = new BreadcrumbBar(headerEl, ui, input, wasmScene, renderer);
    ui.breadcrumbBar = breadcrumbBar;

    // Start with the artboard centered and fitted in the viewport
    renderer.fitToArtboard();
    ui.setZoom(renderer.zoom);

    renderer.start();

    // Dev-only handle for debugging and automated testing
    if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__editor = {
            scene: wasmScene, ui, input, renderer, contextBar,
        };
    }

    console.log('Antigravity Vector Engine Initialized (Rust Core / CanvasKit)');
}

bootstrap().catch(err => {
    console.error('Failed to initialize engine:', err);
});
