import { Renderer } from './renderer';
import { UIEngine } from './ui';
import { InputManager } from './input';
import { WasmScene } from './wasm_scene';

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

    renderer.start();
    
    console.log('Antigravity Vector Engine Initialized (Rust Core / CanvasKit)');
}

bootstrap().catch(err => {
    console.error('Failed to initialize engine:', err);
});
