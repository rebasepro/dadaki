/**
 * Document color swatches.
 *
 * A reusable palette stored in the engine scene (so it persists with the file
 * and rides the undo stack). Swatches behave as Illustrator "global colors":
 * editing a swatch recolors every fill/stroke in the document that currently
 * matches the swatch's previous color, in one undo step.
 *
 * Interactions:
 *   • click        → apply the swatch to the selection's fill (one-off)
 *   • double-click → open the color picker to edit the swatch (global recolor)
 *   • ⌥/alt-click  → remove the swatch
 *   • header "+"   → add the current fill color as a new swatch
 */
import { colorToHex, openColorPicker } from './color_picker';
import type { Color } from './types';
import type { UIEngine } from './ui';
import type { WasmScene } from './wasm_scene';

function colorsEqual(a: Color, b: Color, eps = 1 / 512): boolean {
    return (
        Math.abs(a.r - b.r) < eps &&
        Math.abs(a.g - b.g) < eps &&
        Math.abs(a.b - b.b) < eps &&
        Math.abs((a.a ?? 1) - (b.a ?? 1)) < eps
    );
}

export class SwatchesController {
    private grid: HTMLElement;

    constructor(
        private scene: WasmScene,
        private ui: UIEngine,
        private requestRender: () => void,
    ) {
        this.grid = document.getElementById('swatches-grid') as HTMLElement;
        document.getElementById('add-swatch-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.addCurrent();
        });
        this.render();
    }

    /** Re-read swatches from the scene and repaint the grid. Call after load/undo. */
    render() {
        const swatches = this.scene.getSwatches();
        this.grid.innerHTML = '';
        if (swatches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'swatches-empty';
            empty.textContent = 'No swatches yet — add the current fill with +';
            this.grid.appendChild(empty);
            return;
        }
        swatches.forEach((color, index) => {
            this.grid.appendChild(this.buildChip(color, index));
        });
    }

    private buildChip(color: Color, index: number): HTMLElement {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'swatch-chip';
        chip.title = `${colorToHex(color)} — click to apply, double-click to edit, ⌥-click to remove`;
        const fill = document.createElement('span');
        fill.className = 'swatch-fill';
        fill.style.background = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${color.a ?? 1})`;
        chip.appendChild(fill);

        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.altKey) {
                this.remove(index);
            } else {
                this.ui.applySolidFill({ ...color });
            }
        });
        chip.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.edit(index, chip);
        });
        return chip;
    }

    /** Add the current fill color as a new swatch (dedup exact matches). */
    private addCurrent() {
        const color = this.ui.getActiveFillColor();
        const list = this.scene.getSwatches();
        if (list.some((c) => colorsEqual(c, color))) return;
        list.push({ ...color });
        this.scene.setSwatches(list);
        this.render();
    }

    private remove(index: number) {
        const list = this.scene.getSwatches();
        if (index < 0 || index >= list.length) return;
        list.splice(index, 1);
        this.scene.setSwatches(list);
        this.render();
    }

    /** Edit a swatch via the color picker; recolor matching fills/strokes live. */
    private edit(index: number, anchor: HTMLElement) {
        const list = this.scene.getSwatches();
        if (index < 0 || index >= list.length) return;
        const before = this.scene.serializeScene();
        let prev: Color = { ...list[index] };

        const commit = (c: Color, pushHistory: boolean) => {
            this.recolor(prev, c);
            prev = { ...c };
            const cur = this.scene.getSwatches();
            cur[index] = { ...c };
            this.scene.setSwatches(cur);
            this.render();
            this.requestRender();
            if (pushHistory) this.scene.pushHistoryState(before);
        };

        openColorPicker(
            anchor,
            { ...prev },
            {
                title: 'Edit swatch',
                onInput: (c) => commit(c, false),
                onChange: (c) => commit(c, true),
            },
        );
    }

    /**
     * Replace every solid fill/stroke paint in the document that matches
     * `oldColor` with `newColor`. Runs history-free — the caller brackets it.
     */
    private recolor(oldColor: Color, newColor: Color) {
        if (colorsEqual(oldColor, newColor)) return;
        const data = this.scene.getSceneData();
        for (const idStr of Object.keys(data.nodes)) {
            const id = Number(idStr);
            const style = this.scene.getNodeStyle(id);
            let changed = false;

            const fills = (style.fills ?? []).map((p: any) => {
                if (p && 'r' in p && colorsEqual(p, oldColor)) {
                    changed = true;
                    return { ...newColor };
                }
                return p;
            });
            const strokes = (style.strokes ?? []).map((s: any) => {
                if (s?.paint && 'r' in s.paint && colorsEqual(s.paint, oldColor)) {
                    changed = true;
                    return { ...s, paint: { ...newColor } };
                }
                return s;
            });

            if (changed) {
                this.scene.setNodeStyleNoHistory(id, JSON.stringify({ ...style, fills, strokes }));
            }
        }
    }
}
