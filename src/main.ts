import { Renderer } from './renderer';
import { Scene } from './scene';
import { UIEngine } from './ui';
import { InputManager } from './input';

async function bootstrap() {
    // @ts-ignore - Loaded from script tag in index.html
    const ck = await CanvasKitInit({
        locateFile: (file: string) => `/${file}`
    });

    const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement;
    const scene = new Scene(ck);
    const renderer = new Renderer(ck, canvas, scene);
    const ui = new UIEngine(ck, scene);
    new InputManager(canvas, scene, ui, renderer);

    // Initial setup
    renderer.start();
    
    console.log('Antigravity Vector Engine Initialized (CanvasKit/Wasm)');
}

bootstrap().catch(err => {
    console.error('Failed to initialize engine:', err);
});
