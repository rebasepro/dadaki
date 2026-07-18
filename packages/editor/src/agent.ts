/**
 * Agent authoring API — the surface an autonomous agent drives the editor
 * through (see `EditorHandle.agent`, and the MCP server in `tools/mcp`).
 *
 * The design goal is that an agent works at the level of a human's *intent*
 * ("draw a rect", "align these left", "make it red") rather than a human's
 * *motor actions* (move mouse to 412,90; press; drag). Pixel-driving the real
 * toolbar would be slow, brittle against UI changes, and agents are poor at
 * precise dragging. What actually matters from "a human in front of the tool"
 * is the feedback loop — act, look, correct — so this API is paired with
 * `describe()` and SVG/PNG rendering so the agent can see what it made.
 *
 * Two invariants make agent edits indistinguishable from human ones:
 *
 *   1. Every mutating call goes through `scene.transaction()`, so one agent
 *      call is exactly one undo step. A human can undo an agent's work.
 *   2. Nothing here talks to the engine directly — it all delegates to the
 *      existing `WasmScene` wrappers, so autosave, cache invalidation, mesh
 *      re-snapping and the host's `onDocumentMutated` hook all still fire.
 *
 * Coordinates are world units. Colors are CSS hex (`#rgb`/`#rrggbb`/
 * `#rrggbbaa`) because that is what agents reliably produce; they are parsed
 * to the engine's 0–1 RGBA at the boundary.
 */

import type { CanvasKit } from 'canvaskit-wasm';
import { type AlignMode, alignSelection, distributeSelection } from './align';
import { applyBooleanOp, type BoolOp } from './boolean_ops';
import { colorToHex, parseHex } from './color_picker';
import type { Color, NodeStyle, Paint, Stroke, Subpath } from './types';
import { isSolid, StrokeAlignment } from './types';
import type { WasmScene } from './wasm_scene';

/** A node as reported to the agent: flat, small, and free of engine internals. */
export interface AgentNode {
    id: number;
    name: string;
    type: string;
    /** World-space bounds [x, y, width, height], rounded to 2dp. */
    bounds: [number, number, number, number];
    /** First solid fill as hex, or null when unfilled / gradient / mesh / pattern. */
    fill: string | null;
    /** First solid stroke as hex, or null when unstroked / non-solid. */
    stroke: string | null;
    strokeWidth: number | null;
    opacity: number;
    visible: boolean;
    locked: boolean;
    children?: AgentNode[];
}

export interface AgentDescription {
    nodes: AgentNode[];
    /** Ids currently selected in the editor. */
    selection: number[];
}

export interface AgentApi {
    // ─── Seeing ────────────────────────────────────────────────────────
    /** The whole scene as a compact tree. This is what lets the agent aim. */
    describe(): AgentDescription;
    /** One node, or null if the id is unknown. */
    describeNode(id: number): AgentNode | null;
    /** The active document serialized to SVG (for rendering / inspection). */
    toSVG(): string;

    // ─── Creating ──────────────────────────────────────────────────────
    createRect(x: number, y: number, w: number, h: number, style?: AgentStyle): number;
    createEllipse(cx: number, cy: number, rx: number, ry: number, style?: AgentStyle): number;
    createPolygon(
        cx: number,
        cy: number,
        radius: number,
        sides: number,
        style?: AgentStyle,
    ): number;
    createStar(
        cx: number,
        cy: number,
        outerR: number,
        innerR: number,
        points: number,
        style?: AgentStyle,
    ): number;
    /** A path from explicit points; `points` matches the engine's pen format. */
    createPath(points: AgentPathPoint[], closed?: boolean, style?: AgentStyle): number;
    createText(x: number, y: number, content: string, fontSize?: number): number;

    // ─── Styling ───────────────────────────────────────────────────────
    setFill(ids: number | number[], hex: string | null): void;
    setStroke(ids: number | number[], hex: string | null, width?: number): void;
    setOpacity(ids: number | number[], opacity: number): void;
    setCornerRadius(ids: number | number[], radius: number): void;

    // ─── Arranging ─────────────────────────────────────────────────────
    move(ids: number | number[], dx: number, dy: number): void;
    setPosition(id: number, x: number, y: number): void;
    resize(id: number, w: number, h: number): void;
    rotate(id: number, degrees: number): void;
    align(ids: number[], mode: AlignMode): void;
    distribute(ids: number[], axis: 'h' | 'v'): void;

    // ─── Structuring ───────────────────────────────────────────────────
    group(ids: number[]): number;
    ungroup(id: number): void;
    duplicate(id: number): number;
    remove(ids: number | number[]): void;
    rename(id: number, name: string): void;
    boolean(ids: number[], op: BoolOp): number | null;

    // ─── Session ───────────────────────────────────────────────────────
    select(ids: number | number[]): void;
    undo(): void;
    redo(): void;
}

/** Style shorthand accepted at creation time, applied in the same undo step. */
export interface AgentStyle {
    fill?: string | null;
    stroke?: string | null;
    strokeWidth?: number;
    opacity?: number;
    cornerRadius?: number;
}

/** A path point; control points default to the anchor (i.e. a straight corner). */
export interface AgentPathPoint {
    x: number;
    y: number;
    cp1x?: number;
    cp1y?: number;
    cp2x?: number;
    cp2y?: number;
}

/** Minimal view of the editor the agent API needs; keeps this module testable. */
export interface AgentDeps {
    scene: WasmScene;
    ck: CanvasKit;
    /** Read the current selection (from the UI engine). */
    getSelection(): number[];
    /** Replace the current selection (drives the UI engine + a re-render). */
    setSelection(ids: number[]): void;
    /** Serialize the active document to SVG. */
    exportSVG(): string;
}

function toIds(ids: number | number[]): number[] {
    return typeof ids === 'number' ? [ids] : ids;
}

function requireColor(hex: string): Color {
    const c = parseHex(hex);
    if (!c) throw new Error(`[agent] invalid color ${JSON.stringify(hex)} — expected CSS hex`);
    return c;
}

/** First solid paint in a list as hex, or null when empty/non-solid. */
function firstSolidHex(paints: Paint[] | undefined): string | null {
    const p = paints?.[0];
    if (!p || !isSolid(p)) return null;
    return colorToHex(p);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Build a stroke, preserving whatever the node already had (cap, join, dashes)
 * and overriding only paint/width. A width set with no colour and no existing
 * stroke has nothing to paint, so it defaults to black — otherwise the agent
 * would make a change it can't see, and would loop trying to fix it.
 */
function makeStroke(
    existing: Stroke | undefined,
    paint: Paint | undefined,
    width?: number,
): Stroke {
    return {
        cap: existing?.cap ?? 0,
        join: existing?.join ?? 0,
        dash_array: existing?.dash_array ?? [],
        dash_offset: existing?.dash_offset ?? 0,
        miter_limit: existing?.miter_limit ?? 4,
        alignment: existing?.alignment ?? StrokeAlignment.Center,
        paint: paint ?? existing?.paint ?? { r: 0, g: 0, b: 0, a: 1 },
        width: width ?? existing?.width ?? 1,
    };
}

/**
 * The engine's default node style carries a black 2px stroke, which is right
 * for a human dragging out a shape on a canvas (they can see it and delete it)
 * but wrong for an agent: asking for "a yellow circle" would silently produce
 * a black-outlined one, and a thin dark outline is exactly the sort of detail
 * an agent won't notice in a render and will never think to remove. So at
 * creation time a stroke is opt-in — unless the caller mentioned `stroke` or
 * `strokeWidth`, we clear it.
 */
function creationStyle(style: AgentStyle | undefined): AgentStyle {
    if (style?.stroke !== undefined || style?.strokeWidth !== undefined) return style;
    return { ...style, stroke: null };
}

export function createAgentApi(deps: AgentDeps): AgentApi {
    const { scene, ck } = deps;

    /**
     * Resolve ids, failing loudly on unknown ones. Without this, a stale id
     * reaches `getNodeStyle`, whose `JSON.parse` of the engine's empty string
     * surfaces as "Unexpected end of JSON input" — a message that tells an
     * agent nothing about what it did wrong or how to recover.
     */
    const requireNodes = (ids: number | number[]): number[] => {
        const list = toIds(ids);
        const missing = list.filter((id) => scene.getNode(id) === null);
        if (missing.length) {
            throw new Error(
                `[agent] no object with id ${missing.join(', ')} — call describe() for current ids`,
            );
        }
        return list;
    };

    /** Apply an `AgentStyle` to a node without its own history push — callers
     *  are always already inside a transaction that owns the undo step. */
    const applyStyle = (id: number, style: AgentStyle | undefined) => {
        if (!style) return;
        const current = scene.getNodeStyle(id);
        const next: NodeStyle = { ...current };
        if (style.fill !== undefined) {
            next.fills = style.fill === null ? [] : [requireColor(style.fill)];
        }
        if (style.stroke !== undefined || style.strokeWidth !== undefined) {
            const existing = current.strokes?.[0];
            if (style.stroke === null) {
                next.strokes = [];
            } else {
                const paint = style.stroke !== undefined ? requireColor(style.stroke) : undefined;
                next.strokes = [makeStroke(existing, paint, style.strokeWidth)];
            }
        }
        if (style.opacity !== undefined) next.opacity = style.opacity;
        if (style.cornerRadius !== undefined) next.corner_radius = style.cornerRadius;
        scene.setNodeStyleNoHistory(id, JSON.stringify(next));
    };

    /** Read-modify-write a node's style inside the caller's transaction. */
    const editStyle = (ids: number | number[], edit: (s: NodeStyle) => NodeStyle) => {
        const list = requireNodes(ids);
        scene.transaction(() => {
            for (const id of list) {
                scene.setNodeStyleNoHistory(
                    id,
                    JSON.stringify(edit({ ...scene.getNodeStyle(id) })),
                );
            }
        });
    };

    const describeNode = (id: number): AgentNode | null => {
        const node = scene.getNode(id);
        if (!node) return null;
        const b = scene.getNodeBounds(id);
        const stroke = node.style.strokes?.[0];
        const out: AgentNode = {
            id,
            name: node.name,
            type: node.node_type,
            bounds: [round2(b[0]), round2(b[1]), round2(b[2] - b[0]), round2(b[3] - b[1])],
            fill: firstSolidHex(node.style.fills),
            stroke: stroke?.paint && isSolid(stroke.paint) ? colorToHex(stroke.paint) : null,
            strokeWidth: stroke ? stroke.width : null,
            opacity: node.style.opacity,
            visible: node.visible,
            locked: node.locked,
        };
        const kids = node.children ?? [];
        if (kids.length) {
            out.children = kids
                .map((childId) => describeNode(childId))
                .filter((n): n is AgentNode => n !== null);
        }
        return out;
    };

    return {
        describe(): AgentDescription {
            const data = scene.getSceneData();
            return {
                nodes: data.root_nodes
                    .map((id) => describeNode(id))
                    .filter((n): n is AgentNode => n !== null),
                selection: deps.getSelection(),
            };
        },

        describeNode,

        toSVG: () => deps.exportSVG(),

        createRect(x, y, w, h, style) {
            return scene.transaction(() => {
                const id = scene.addRect(x, y, w, h);
                applyStyle(id, creationStyle(style));
                return id;
            });
        },

        createEllipse(cx, cy, rx, ry, style) {
            return scene.transaction(() => {
                const id = scene.addEllipse(cx, cy, rx, ry);
                applyStyle(id, creationStyle(style));
                return id;
            });
        },

        createPolygon(cx, cy, radius, sides, style) {
            return scene.transaction(() => {
                const id = scene.addPolygon(cx, cy, radius, sides);
                applyStyle(id, creationStyle(style));
                return id;
            });
        },

        createStar(cx, cy, outerR, innerR, points, style) {
            return scene.transaction(() => {
                const id = scene.addStar(cx, cy, outerR, innerR, points);
                applyStyle(id, creationStyle(style));
                return id;
            });
        },

        createPath(points, closed = false, style) {
            if (points.length < 2) throw new Error('[agent] createPath needs at least 2 points');
            // The engine's path format carries explicit control points as
            // [x, y] tuples; an agent that omits them means "straight segment",
            // which is cp == anchor. Note the engine's `add_path` deserializes
            // with `unwrap_or_default()`, so a shape mismatch here yields a
            // silently EMPTY path rather than an error — hence the typed
            // Subpath below rather than an inline object literal.
            const subpath: Subpath = {
                closed,
                points: points.map((p) => ({
                    x: p.x,
                    y: p.y,
                    cp1: [p.cp1x ?? p.x, p.cp1y ?? p.y],
                    cp2: [p.cp2x ?? p.x, p.cp2y ?? p.y],
                })),
            };
            return scene.transaction(() => {
                const id = scene.addPath(JSON.stringify([subpath]));
                applyStyle(id, creationStyle(style));
                return id;
            });
        },

        createText(x, y, content, fontSize = 16) {
            return scene.transaction(() => scene.addText(x, y, content, fontSize));
        },

        setFill(ids, hex) {
            const fills: Paint[] = hex === null ? [] : [requireColor(hex)];
            editStyle(ids, (s) => ({ ...s, fills }));
        },

        setStroke(ids, hex, width) {
            editStyle(ids, (s) => {
                if (hex === null) return { ...s, strokes: [] };
                return { ...s, strokes: [makeStroke(s.strokes?.[0], requireColor(hex), width)] };
            });
        },

        setOpacity(ids, opacity) {
            editStyle(ids, (s) => ({ ...s, opacity }));
        },

        setCornerRadius(ids, radius) {
            editStyle(ids, (s) => ({ ...s, corner_radius: radius }));
        },

        move(ids, dx, dy) {
            const list = requireNodes(ids);
            scene.transaction(() => {
                for (const id of list) {
                    const t = scene.getNodeTransformComponents(id);
                    scene.setNodeTransformComponents(id, { ...t, x: t.x + dx, y: t.y + dy });
                }
            });
        },

        setPosition(id, x, y) {
            requireNodes(id);
            scene.transaction(() => scene.setNodePosition(id, x, y));
        },

        resize(id, w, h) {
            requireNodes(id);
            scene.transaction(() => scene.resizeNode(id, w, h));
        },

        rotate(id, degrees) {
            requireNodes(id);
            scene.transaction(() => scene.setNodeRotation(id, degrees));
        },

        align(ids, mode) {
            requireNodes(ids);
            scene.transaction(() => alignSelection(scene, ids, mode));
        },

        distribute(ids, axis) {
            requireNodes(ids);
            scene.transaction(() => distributeSelection(scene, ids, axis));
        },

        group(ids) {
            requireNodes(ids);
            return scene.transaction(() => scene.groupNodes(ids));
        },

        ungroup(id) {
            requireNodes(id);
            scene.transaction(() => scene.ungroupNode(id));
        },

        duplicate(id) {
            requireNodes(id);
            return scene.transaction(() => scene.duplicateNode(id));
        },

        remove(ids) {
            const list = requireNodes(ids);
            scene.transaction(() => scene.removeNodes(list));
        },

        rename(id, name) {
            requireNodes(id);
            scene.transaction(() => scene.setNodeName(id, name));
        },

        boolean(ids, op) {
            if (ids.length < 2) throw new Error('[agent] boolean needs at least 2 nodes');
            requireNodes(ids);
            return scene.transaction(() => applyBooleanOp(ck, scene, ids, op));
        },

        select(ids) {
            deps.setSelection(requireNodes(ids));
        },

        undo: () => scene.undo(),
        redo: () => scene.redo(),
    };
}
