/**
 * Alignment and distribution operations for multi-selections.
 * Works on world-space bounds via the engine's spatial index.
 */

import { logAppEvent } from './analytics';
import type { WasmScene } from './wasm_scene';

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

interface NodeBounds {
    id: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

function collectBounds(scene: WasmScene, ids: number[]): NodeBounds[] {
    const out: NodeBounds[] = [];
    for (const id of ids) {
        const b = scene.getNodeBounds(id);
        if (b.length === 4 && (b[2] > b[0] || b[3] > b[1])) {
            out.push({ id, minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] });
        }
    }
    return out;
}

/** Align selected nodes to the selection's union bounds. One undo step. */
export function alignSelection(scene: WasmScene, ids: number[], mode: AlignMode): void {
    const items = collectBounds(scene, ids);
    if (items.length < 2) return;

    const uMinX = Math.min(...items.map((i) => i.minX));
    const uMinY = Math.min(...items.map((i) => i.minY));
    const uMaxX = Math.max(...items.map((i) => i.maxX));
    const uMaxY = Math.max(...items.map((i) => i.maxY));
    const uCx = (uMinX + uMaxX) / 2;
    const uCy = (uMinY + uMaxY) / 2;

    scene.saveMoveHistory();
    for (const it of items) {
        let dx = 0,
            dy = 0;
        switch (mode) {
            case 'left':
                dx = uMinX - it.minX;
                break;
            case 'hcenter':
                dx = uCx - (it.minX + it.maxX) / 2;
                break;
            case 'right':
                dx = uMaxX - it.maxX;
                break;
            case 'top':
                dy = uMinY - it.minY;
                break;
            case 'vcenter':
                dy = uCy - (it.minY + it.maxY) / 2;
                break;
            case 'bottom':
                dy = uMaxY - it.maxY;
                break;
        }
        if (dx !== 0 || dy !== 0) {
            scene.moveNode(it.id, dx, dy);
        }
    }
    scene.invalidateCache();
    scene.autosave?.trigger();
    logAppEvent('alignment_action', { mode: mode, count: ids.length, type: 'align' });
}

/** Distribute nodes with equal gaps along an axis. Needs 3+ nodes. One undo step. */
export function distributeSelection(scene: WasmScene, ids: number[], axis: 'h' | 'v'): void {
    const items = collectBounds(scene, ids);
    if (items.length < 3) return;

    const size = (it: NodeBounds) => (axis === 'h' ? it.maxX - it.minX : it.maxY - it.minY);
    const min = (it: NodeBounds) => (axis === 'h' ? it.minX : it.minY);
    const sorted = [...items].sort((a, b) => min(a) - min(b));

    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const spanStart = min(first);
    const spanEnd = axis === 'h' ? last.maxX : last.maxY;
    const totalSize = sorted.reduce((s, it) => s + size(it), 0);
    const gap = (spanEnd - spanStart - totalSize) / (sorted.length - 1);

    scene.saveMoveHistory();
    let cursor = spanStart;
    for (const it of sorted) {
        const delta = cursor - min(it);
        if (Math.abs(delta) > 0.01) {
            if (axis === 'h') scene.moveNode(it.id, delta, 0);
            else scene.moveNode(it.id, 0, delta);
        }
        cursor += size(it) + gap;
    }
    scene.invalidateCache();
    scene.autosave?.trigger();
    logAppEvent('alignment_action', { axis: axis, count: ids.length, type: 'distribute' });
}
