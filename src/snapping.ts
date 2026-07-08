import type { WasmScene } from './wasm_scene';

/** A visual alignment guide produced by a snap, drawn by the Renderer.
 *  `axis: 'x'` is a vertical line at world x = pos; `axis: 'y'` is horizontal. */
export interface SnapGuide {
    axis: 'x' | 'y';
    pos: number;
}

export interface SnapDelta {
    dx: number;
    dy: number;
    guides: SnapGuide[];
}

/**
 * Snapping engine for interactive drags (move / resize / draw).
 *
 * Targets are collected once at drag start (`begin`) from the artboard
 * (edges + center) and every top-level node's world bounds (edges + centers),
 * excluding the nodes being manipulated. Queries are then cheap per-frame.
 *
 * Holding Cmd/Ctrl during a drag bypasses snapping (checked by callers).
 */
export class SnapEngine {
    private xTargets: number[] = [];
    private yTargets: number[] = [];
    active: boolean = false;

    /**
     * Collect snap targets, excluding `excludeIds` and any root that contains
     * them. `excludeArtboardId` omits one artboard's edges (so a frame being
     * dragged/resized doesn't snap to itself).
     */
    begin(scene: WasmScene, excludeIds: Iterable<number>, excludeArtboardId?: number) {
        this.xTargets = [];
        this.yTargets = [];

        // Roots that are (or contain) a manipulated node don't participate.
        const excludedRoots = new Set<number>();
        for (const id of excludeIds) {
            let current = id;
            let root = id;
            while (current >= 0) {
                root = current;
                current = scene.getNodeParent(current);
            }
            excludedRoots.add(root);
        }

        // Artboard edges and centers — every artboard on the canvas (except one
        // being dragged, so it can't snap to its own edges).
        const artboards = scene.getArtboards();
        if (artboards.length > 0) {
            for (const a of artboards) {
                if (a.id === excludeArtboardId) continue;
                this.xTargets.push(a.x, a.x + a.w / 2, a.x + a.w);
                this.yTargets.push(a.y, a.y + a.h / 2, a.y + a.h);
            }
        } else {
            const docW = scene.engine?.get_document_width() ?? 1000;
            const docH = scene.engine?.get_document_height() ?? 1000;
            this.xTargets.push(0, docW / 2, docW);
            this.yTargets.push(0, docH / 2, docH);
        }

        // Top-level nodes: edges and centers of their world AABBs
        for (const rootId of scene.getRootNodes()) {
            if (excludedRoots.has(rootId)) continue;
            if (!scene.getNodeVisible(rootId)) continue;
            const b = scene.getNodeBounds(rootId);
            if (b[2] <= b[0] && b[3] <= b[1]) continue; // empty bounds
            this.xTargets.push(b[0], (b[0] + b[2]) / 2, b[2]);
            this.yTargets.push(b[1], (b[1] + b[3]) / 2, b[3]);
        }

        this.active = true;
    }

    end() {
        this.active = false;
        this.xTargets = [];
        this.yTargets = [];
    }

    /** Nearest target to `value` within `threshold`, or null. */
    private nearest(targets: number[], value: number, threshold: number): number | null {
        let best: number | null = null;
        let bestDist = threshold;
        for (const t of targets) {
            const d = Math.abs(t - value);
            if (d < bestDist) {
                bestDist = d;
                best = t;
            }
        }
        return best;
    }

    /**
     * Snap a moving box: each axis independently tries its min, mid and max
     * against the targets and keeps the closest match. Returns the correction
     * to add to the box position, plus guides for the renderer.
     */
    snapBounds(b: { x: number; y: number; w: number; h: number }, threshold: number): SnapDelta {
        const result: SnapDelta = { dx: 0, dy: 0, guides: [] };
        if (!this.active) return result;

        const xCandidates = [b.x, b.x + b.w / 2, b.x + b.w];
        const yCandidates = [b.y, b.y + b.h / 2, b.y + b.h];

        let bestDx: number | null = null;
        let bestXGuide = 0;
        for (const c of xCandidates) {
            const t = this.nearest(this.xTargets, c, threshold);
            if (t !== null && (bestDx === null || Math.abs(t - c) < Math.abs(bestDx))) {
                bestDx = t - c;
                bestXGuide = t;
            }
        }
        let bestDy: number | null = null;
        let bestYGuide = 0;
        for (const c of yCandidates) {
            const t = this.nearest(this.yTargets, c, threshold);
            if (t !== null && (bestDy === null || Math.abs(t - c) < Math.abs(bestDy))) {
                bestDy = t - c;
                bestYGuide = t;
            }
        }

        if (bestDx !== null) {
            result.dx = bestDx;
            result.guides.push({ axis: 'x', pos: bestXGuide });
        }
        if (bestDy !== null) {
            result.dy = bestDy;
            result.guides.push({ axis: 'y', pos: bestYGuide });
        }
        return result;
    }

    /** Snap a single point (shape-creation corner, dragged resize edge). */
    snapPoint(x: number, y: number, threshold: number): { x: number; y: number; guides: SnapGuide[] } {
        const guides: SnapGuide[] = [];
        if (!this.active) return { x, y, guides };

        const tx = this.nearest(this.xTargets, x, threshold);
        const ty = this.nearest(this.yTargets, y, threshold);
        if (tx !== null) {
            x = tx;
            guides.push({ axis: 'x', pos: tx });
        }
        if (ty !== null) {
            y = ty;
            guides.push({ axis: 'y', pos: ty });
        }
        return { x, y, guides };
    }

    /** Snap a single axis value. Returns the snapped value and guide, or null if no snap. */
    snapAxis(axis: 'x' | 'y', value: number, threshold: number): { value: number; guide: SnapGuide } | null {
        if (!this.active) return null;
        const t = this.nearest(axis === 'x' ? this.xTargets : this.yTargets, value, threshold);
        if (t === null) return null;
        return { value: t, guide: { axis, pos: t } };
    }
}
