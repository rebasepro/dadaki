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

/** Style properties for a scene node. */
export interface NodeStyle {
    fill: Paint | null;
    stroke: Paint | null;
    stroke_width: number;
    opacity: number;
    stroke_cap: number;
    stroke_join: number;
    dash_array: number[];
    dash_offset: number;
    corner_radius: number;
    blend_mode: number;
    fill_rule: number;
    miter_limit: number;
    fill_opacity: number;
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

/** A node in the scene graph. */
export interface SceneNode {
    name: string;
    node_type: string;
    geometry: NodeGeometry;
    style: NodeStyle;
    visible: boolean;
    locked: boolean;
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
