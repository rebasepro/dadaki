/** The parts of `agent.describe()` the summary reads. */
export interface SceneNode {
    id: number;
    name?: string;
    type: string;
    bounds?: number[];
    children?: SceneNode[];
}
export interface SceneDescription {
    canvas?: unknown;
    nodes?: SceneNode[];
    selection?: unknown;
}

/** Beyond this (as sent, pretty-printed), connect answers with an outline. */
const CONNECT_FULL_SCENE_MAX_CHARS = 20_000;
const CONNECT_OUTLINE_MAX_NODES = 60;

/**
 * What connect reports about the document it attached to.
 *
 * It used to return the whole scene. A real design is hundreds of paths with
 * their points and styles: the Tux file is 730 objects and 460,000 characters,
 * more than an agent's tool result may hold, so the first thing an agent saw
 * after connecting was an error. A small document still comes back whole —
 * one call, nothing to follow up — and a large one comes back as an outline:
 * the canvas, how many objects there are, and the top level with each group's
 * size, which is what an agent needs to decide what to look at next.
 */
export function summarizeForConnect(scene: SceneDescription) {
    // Measured as the agent will receive it: tool results are pretty-printed.
    const full = JSON.stringify(scene, null, 2);
    if (full.length <= CONNECT_FULL_SCENE_MAX_CHARS) return { scene };
    const count = (ns: SceneNode[] = []): number =>
        ns.reduce((n, x) => n + 1 + count(x.children), 0);
    const top = scene.nodes ?? [];
    return {
        canvas: scene.canvas,
        selection: scene.selection,
        objectCount: count(top),
        topLevel: top.slice(0, CONNECT_OUTLINE_MAX_NODES).map((n) => ({
            id: n.id,
            name: n.name,
            type: n.type,
            bounds: n.bounds,
            ...(n.children ? { descendants: count(n.children) } : {}),
        })),
        ...(top.length > CONNECT_OUTLINE_MAX_NODES
            ? { topLevelOmitted: top.length - CONNECT_OUTLINE_MAX_NODES }
            : {}),
        note:
            `This document is large (${full.length.toLocaleString('en')} characters as a full ` +
            'description), so this is an outline. describe_scene returns everything; ' +
            'render_png_image shows it.',
    };
}
