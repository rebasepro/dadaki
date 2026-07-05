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

/** Style properties for a scene node. */
export interface NodeStyle {
    fill: Color | null;
    stroke: Color | null;
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
}

/** Text geometry. */
export interface TextGeometry {
    content: string;
    font_size: number;
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
