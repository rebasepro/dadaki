import { Renderer } from './renderer';
import { UIEngine } from './ui';
import { InputManager } from './input';
import { WasmScene } from './wasm_scene';
import { ContextBar } from './context_bar';

async function bootstrap() {
    // @ts-ignore - Loaded from script tag in index.html
    const ck = await CanvasKitInit({
        locateFile: (file: string) => `/${file}`
    });

    const wasmScene = new WasmScene(ck);
    await wasmScene.init();

    const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement;
    const renderer = new Renderer(ck, canvas, wasmScene);
    const ui = new UIEngine(ck, wasmScene);
    const input = new InputManager(canvas, wasmScene, ui, renderer);
    renderer.inputManager = input;

    // Context bar — floating action bar over the canvas
    const canvasContainer = document.getElementById('canvas-container') as HTMLElement;
    const contextBar = new ContextBar(canvasContainer, ui, input, wasmScene, renderer);
    ui.contextBar = contextBar;

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
