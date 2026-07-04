import { Renderer } from './renderer.js';
import { Scene } from './scene.js';
import { UIEngine } from './ui.js';
import { InputManager } from './input.js';

async function bootstrap() {
    const ck = await CanvasKitInit({
        locateFile: (file) => `https://unpkg.com/canvaskit-wasm@0.39.1/bin/full/${file}`
    });

    const canvas = document.getElementById('editor-canvas');
    const scene = new Scene(ck);
    const renderer = new Renderer(ck, canvas, scene);
    const ui = new UIEngine(ck, scene);
    const input = new InputManager(canvas, scene, ui, renderer);

    // Initial setup
    renderer.start();
    
    console.log('Antigravity Vector Engine Initialized (CanvasKit/Wasm)');
}

bootstrap().catch(err => {
    console.error('Failed to initialize engine:', err);
});
