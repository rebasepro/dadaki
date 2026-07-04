import type { CanvasKit } from 'canvaskit-wasm';
import { PathObject, SceneObject } from './scene';

export enum PathfinderOp {
    Union,
    Difference,
    Intersect,
    Xor
}

export class Pathfinder {
    ck: CanvasKit;

    constructor(ck: CanvasKit) {
        this.ck = ck;
    }

    apply(objects: SceneObject[], op: PathfinderOp): PathObject | null {
        if (objects.length < 2) return null;

        let resultPath: any = this.getPath(objects[0]);
        if (!resultPath) return null;

        const ckOp = this.getCKOp(op);

        for (let i = 1; i < objects.length; i++) {
            const nextPath = this.getPath(objects[i]);
            if (!nextPath) continue;

            const combined = this.ck.Path.MakeFromOp(resultPath, nextPath, ckOp);
            if (combined) {
                if (resultPath !== (objects[0] as any)._cachedPath) resultPath.delete();
                resultPath = combined;
            }
            if (nextPath !== (objects[i] as any)._cachedPath) nextPath.delete();
        }

        const newObj = new PathObject(this.ck, `Result ${PathfinderOp[op]}`);
        newObj._cachedPath = resultPath;
        // Inherit style from first object
        newObj.fill = objects[0].fill;
        newObj.stroke = objects[0].stroke;
        newObj.strokeWidth = objects[0].strokeWidth;

        return newObj;
    }

    private getPath(obj: SceneObject): any {
        if (obj._cachedPath) {
            // We need a copy because Pathfinder will likely delete it or we want to keep the original
            return obj._cachedPath.copy();
        }
        
        // If not a path, we might need to convert it (e.g. Rect -> Path)
        if ((obj as any).w !== undefined) {
            const rect = obj as any;
            const p = new (this.ck as any).Path();
            p.addRect(this.ck.LTRBRect(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h));
            return p;
        }
        
        if ((obj as any).rx !== undefined) {
            const ellipse = obj as any;
            const p = new (this.ck as any).Path();
            p.addOval(this.ck.LTRBRect(ellipse.x - ellipse.rx, ellipse.y - ellipse.ry, ellipse.x + ellipse.rx, ellipse.y + ellipse.ry));
            return p;
        }

        return null;
    }

    private getCKOp(op: PathfinderOp): any {
        switch (op) {
            case PathfinderOp.Union: return this.ck.PathOp.Union;
            case PathfinderOp.Difference: return this.ck.PathOp.Difference;
            case PathfinderOp.Intersect: return this.ck.PathOp.Intersect;
            case PathfinderOp.Xor: return this.ck.PathOp.XOR;
        }
    }
}
