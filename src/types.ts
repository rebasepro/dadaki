/**
 * Type definitions for the vector editor scene data.
 * These types mirror the Rust Engine's JSON serialization format.
 */

/** RGBA color in 0–1 range. */
export interface Color {
    r: number;
    g: number;
    b: number;
    a: number;
}

/** A gradient color stop. */
export interface GradientStop {
    offset: number;
    color: Color;
}

/** Gradient definition. */
export interface Gradient {
    gradient_type: 'Linear' | 'Radial';
    stops: GradientStop[];
    start_x: number;
    start_y: number;
    end_x: number;
    end_y: number;
}

/**
 * A paint can be either a solid color or a gradient.
 * Matches the Rust engine's `#[serde(untagged)]` Paint enum:
 * - Solid: `{ r, g, b, a }`
 * - Gradient: `{ gradient_type, stops, start_x, start_y, end_x, end_y }`
 */
export type Paint = Color | Gradient;

/** Type guard: check if a Paint is a Gradient. */
export function isGradient(paint: Paint): paint is Gradient {
    return 'gradient_type' in paint;
}

/** Stroke Alignment */
export enum StrokeAlignment {
    Center = "Center",
    Inner = "Inner",
    Outer = "Outer",
}

/** Stroke definition */
export interface Stroke {
    paint: Paint | null;
    width: number;
    cap: number;
    join: number;
    dash_array: number[];
    dash_offset: number;
    miter_limit: number;
    alignment: StrokeAlignment;
}

/** Decomposed 2D transform components (matches engine's TransformComponents). */
export interface Transform2D {
    x: number;
    y: number;
    rotation_deg: number;
    skew_x_deg: number;
    skew_y_deg: number;
    scale_x: number;
    scale_y: number;
}

/** Style properties for a scene node.
 *  The canonical paint sources are `fills` and `strokes` arrays.
 *  Legacy scalar fields (fill, stroke, stroke_width, etc.) are kept as optional
 *  for backwards-compatible deserialization but should not be relied upon. */
export interface NodeStyle {
    /** @deprecated Use `fills` array instead. */
    fill?: Paint | null;
    /** @deprecated Use `strokes` array instead. */
    stroke?: Paint | null;
    /** @deprecated Use `strokes[].width` instead. */
    stroke_width?: number;
    opacity: number;
    /** @deprecated Use `strokes[].cap` instead. */
    stroke_cap?: number;
    /** @deprecated Use `strokes[].join` instead. */
    stroke_join?: number;
    /** @deprecated Use `strokes[].dash_array` instead. */
    dash_array?: number[];
    /** @deprecated Use `strokes[].dash_offset` instead. */
    dash_offset?: number;
    corner_radius: number;
    blend_mode: number;
    fill_rule: number;
    /** @deprecated Use `strokes[].miter_limit` instead. */
    miter_limit?: number;
    /** @deprecated Subsumed by fills array. */
    fill_opacity?: number;
    fills: Paint[];
    strokes: Stroke[];
}

/** A cubic Bézier path point with incoming/outgoing control points. */
export interface PathPoint {
    x: number;
    y: number;
    /** Incoming control point [x, y]. */
    cp1: [number, number];
    /** Outgoing control point [x, y]. */
    cp2: [number, number];
    /** Non-destructive parametric corner radius at this vertex (default 0). */
    corner_radius?: number;
}

/** A subpath — a sequence of connected path points with an explicit closed flag. */
export interface Subpath {
    points: PathPoint[];
    closed: boolean;
}

/** Rect geometry. */
export interface RectGeometry {
    width: number;
    height: number;
}

/** Ellipse geometry. */
export interface EllipseGeometry {
    radius_x: number;
    radius_y: number;
}

/** Path geometry. */
export interface PathGeometry {
    subpaths: Subpath[];
    /** Per-node vector network (graph-based editing source of truth). */
    network?: NodeVectorNetwork;
}

// ─── Per-Node Vector Network Types ─────────────────────────────────────

/** A vertex in the per-node vector network. */
export interface NetworkVertex {
    position: [number, number];
    /** Incoming control handle (absolute position). */
    handle_in?: [number, number];
    /** Outgoing control handle (absolute position). */
    handle_out?: [number, number];
    /** Non-destructive parametric corner radius at this vertex (default 0). */
    corner_radius?: number;
}

/** An edge connecting two vertices. */
export interface NetworkEdge {
    start_vertex: number;
    end_vertex: number;
}

/** An enclosed region with an independent fill style. */
export interface NetworkRegion {
    /** Ordered edge indices forming a closed loop. */
    edge_loop: number[];
    /** Fill color for this region. */
    fill?: Color;
}

/** Per-node vector network — the graph-based path representation. */
export interface NodeVectorNetwork {
    vertices: NetworkVertex[];
    edges: NetworkEdge[];
    regions: NetworkRegion[];
}

/** Text geometry. */
export interface TextGeometry {
    content: string;
    font_size: number;
    font_family: string;
    text_align: number;
    line_height: number;
}

/**
 * Discriminated geometry union.
 * Exactly one of the keys will be present.
 */
export interface NodeGeometry {
    Rect?: RectGeometry;
    Ellipse?: EllipseGeometry;
    Path?: PathGeometry;
    Text?: TextGeometry;
}

export interface SceneNode {
    name: string;
    node_type: string;
    geometry: NodeGeometry;
    style: NodeStyle;
    visible: boolean;
    locked: boolean;
    /** True when this node masks the siblings painted above it in its group. */
    is_mask?: boolean;
    /** Mask coverage source: 0 = alpha (default), 1 = luminance (reserved). */
    mask_type?: number;
    /** Reserved: clip descendants to this node's bounds (frames — not yet wired). */
    clip_content?: boolean;
    children?: number[];
    /** Local transform as column-major [f32; 9] (matches glam Mat3). */
    transform: number[];
}

/** Top-level scene data returned by Engine.get_scene_json(). */
export interface SceneData {
    nodes: Record<number, SceneNode>;
    root_nodes: number[];
}

/** Pen-tool path point with flat control-point fields. */
export interface PenPathPoint {
    x: number;
    y: number;
    cp1x: number;
    cp1y: number;
    cp2x: number;
    cp2y: number;
}
