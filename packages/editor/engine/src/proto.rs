//! Protobuf serialization for .vec file format.
//!
//! Uses prost derive macros — no protoc or build.rs needed.
//! Provides conversion between internal serde types and proto types.

use prost::Message;
use base64::{Engine as B64Engine, engine::general_purpose::STANDARD as BASE64};
use glam::Vec2;

use crate::{
    Color, Geometry, Gradient, GradientFocal, GradientStop, GradientType, Node, NodeType, Paint, PathPoint, Scene, Style,
    vector_network::{VectorNetwork, NodeVectorNetwork, NetworkVertex, NetworkEdge, NetworkRegion},
};

/// Current file format version. Bump when schema changes.
/// v3: per-node vector network.
/// v4: Live Paint face fills.
/// v5: Multiple strokes and non-destructive transforms.
/// v6: Live Paint face-fill signatures (source_nodes) + gap-bridge distance.
pub const FORMAT_VERSION: u32 = 6;

// ─── Proto Message Types ────────────────────────────────────────────────────────

#[derive(Clone, PartialEq, Message)]
pub struct ProtoColor {
    #[prost(float, tag = "1")]
    pub r: f32,
    #[prost(float, tag = "2")]
    pub g: f32,
    #[prost(float, tag = "3")]
    pub b: f32,
    #[prost(float, tag = "4")]
    pub a: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoPaint {
    #[prost(message, optional, tag = "1")]
    pub solid: Option<ProtoColor>,
    #[prost(message, optional, tag = "2")]
    pub gradient: Option<ProtoGradient>,
    #[prost(message, optional, tag = "3")]
    pub pattern: Option<ProtoPattern>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoPattern {
    #[prost(uint32, tag = "1")]
    pub image_id: u32,
    #[prost(float, tag = "2")]
    pub width: f32,
    #[prost(float, tag = "3")]
    pub height: f32,
    /// Pattern→local affine, 6 floats [a,b,c,d,e,f].
    #[prost(float, repeated, tag = "4")]
    pub transform: Vec<f32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoStroke {
    #[prost(message, optional, tag = "1")]
    pub paint: Option<ProtoPaint>,
    #[prost(float, tag = "2")]
    pub width: f32,
    #[prost(uint32, tag = "3")]
    pub cap: u32,
    #[prost(uint32, tag = "4")]
    pub join: u32,
    #[prost(float, repeated, tag = "5")]
    pub dash_array: Vec<f32>,
    #[prost(float, tag = "6")]
    pub dash_offset: f32,
    #[prost(float, tag = "7")]
    pub miter_limit: f32,
    #[prost(uint32, tag = "8")]
    pub alignment: u32, // 0: Center, 1: Inner, 2: Outer
}



#[derive(Clone, PartialEq, Message)]
pub struct ProtoTransform {
    #[prost(float, tag = "1")]
    pub x: f32,
    #[prost(float, tag = "2")]
    pub y: f32,
    #[prost(float, tag = "3")]
    pub rotation_deg: f32,
    #[prost(float, tag = "4")]
    pub skew_x_deg: f32,
    #[prost(float, tag = "5")]
    pub skew_y_deg: f32,
    #[prost(float, tag = "6")]
    pub scale_x: f32,
    #[prost(float, tag = "7")]
    pub scale_y: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoEffect {
    /// 0 = blur, 1 = drop shadow.
    #[prost(uint32, tag = "1")]
    pub kind: u32,
    /// Blur sigma (kind 0) or shadow blur sigma (kind 1).
    #[prost(float, tag = "2")]
    pub radius: f32,
    #[prost(float, tag = "3")]
    pub dx: f32,
    #[prost(float, tag = "4")]
    pub dy: f32,
    #[prost(message, optional, tag = "5")]
    pub color: Option<ProtoColor>,
    /// 4×5 color matrix (kind 2 = ColorMatrix), row-major 20 floats.
    #[prost(float, repeated, tag = "6")]
    pub matrix: Vec<f32>,
    /// For ColorMatrix: true if the matrix should be applied in linearRGB space.
    #[prost(bool, tag = "7")]
    pub linear_rgb: bool,
    /// Blur (kind 0): y-axis sigma for anisotropic blur. 0 = isotropic (= radius).
    #[prost(float, tag = "8")]
    pub radius_y: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoStyle {
    #[prost(message, repeated, tag = "1")]
    pub fills: Vec<ProtoPaint>,
    #[prost(message, repeated, tag = "2")]
    pub strokes: Vec<ProtoStroke>,
    #[prost(float, optional, tag = "3")]
    pub opacity: Option<f32>,
    #[prost(float, tag = "4")]
    pub corner_radius: f32,
    #[prost(uint32, tag = "5")]
    pub blend_mode: u32,
    #[prost(uint32, tag = "6")]
    pub fill_rule: u32,
    #[prost(message, repeated, tag = "7")]
    pub effects: Vec<ProtoEffect>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoGradientStop {
    #[prost(float, tag = "1")]
    pub offset: f32,
    #[prost(message, optional, tag = "2")]
    pub color: Option<ProtoColor>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoGradient {
    #[prost(uint32, tag = "1")]
    pub gradient_type: u32,
    #[prost(message, repeated, tag = "2")]
    pub stops: Vec<ProtoGradientStop>,
    #[prost(float, tag = "3")]
    pub start_x: f32,
    #[prost(float, tag = "4")]
    pub start_y: f32,
    #[prost(float, tag = "5")]
    pub end_x: f32,
    #[prost(float, tag = "6")]
    pub end_y: f32,
    #[prost(uint32, tag = "7")]
    pub spread: u32,
    #[prost(bool, tag = "8")]
    pub has_focal: bool,
    #[prost(float, tag = "9")]
    pub focal_x: f32,
    #[prost(float, tag = "10")]
    pub focal_y: f32,
    #[prost(float, tag = "11")]
    pub focal_r: f32,
    /// True when `transform` carries a gradient→local affine (elliptical radial).
    #[prost(bool, tag = "12")]
    pub has_transform: bool,
    /// Gradient→local affine [a, b, c, d, e, f]; empty when `has_transform` false.
    #[prost(float, repeated, tag = "13")]
    pub transform: Vec<f32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoPathPoint {
    #[prost(float, tag = "1")]
    pub x: f32,
    #[prost(float, tag = "2")]
    pub y: f32,
    #[prost(float, tag = "3")]
    pub cp1_x: f32,
    #[prost(float, tag = "4")]
    pub cp1_y: f32,
    #[prost(float, tag = "5")]
    pub cp2_x: f32,
    #[prost(float, tag = "6")]
    pub cp2_y: f32,
    #[prost(float, tag = "7")]
    pub corner_radius: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoSubpath {
    #[prost(message, repeated, tag = "1")]
    pub points: Vec<ProtoPathPoint>,
    #[prost(bool, tag = "2")]
    pub closed: bool,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoRect {
    #[prost(float, tag = "1")]
    pub width: f32,
    #[prost(float, tag = "2")]
    pub height: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoEllipse {
    #[prost(float, tag = "1")]
    pub radius_x: f32,
    #[prost(float, tag = "2")]
    pub radius_y: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoPath {
    /// v1 flat point list (single implicit subpath). Only read during
    /// migration of old files; v2+ writers leave this empty.
    #[prost(message, repeated, tag = "1")]
    pub legacy_points: Vec<ProtoPathPoint>,
    /// v2+ explicit subpaths.
    #[prost(message, repeated, tag = "2")]
    pub subpaths: Vec<ProtoSubpath>,
    /// Per-node vector network (v3+).
    #[prost(message, optional, tag = "3")]
    pub network: Option<ProtoNodeNetwork>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoNetworkVertex {
    #[prost(float, tag = "1")]
    pub x: f32,
    #[prost(float, tag = "2")]
    pub y: f32,
    #[prost(float, optional, tag = "3")]
    pub handle_in_x: Option<f32>,
    #[prost(float, optional, tag = "4")]
    pub handle_in_y: Option<f32>,
    #[prost(float, optional, tag = "5")]
    pub handle_out_x: Option<f32>,
    #[prost(float, optional, tag = "6")]
    pub handle_out_y: Option<f32>,
    #[prost(float, tag = "7")]
    pub corner_radius: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoNetworkEdge {
    #[prost(uint32, tag = "1")]
    pub start_vertex: u32,
    #[prost(uint32, tag = "2")]
    pub end_vertex: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoNetworkRegion {
    #[prost(uint32, repeated, tag = "1")]
    pub edge_loop: Vec<u32>,
    #[prost(message, optional, tag = "2")]
    pub fill: Option<ProtoColor>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoNodeNetwork {
    #[prost(message, repeated, tag = "1")]
    pub vertices: Vec<ProtoNetworkVertex>,
    #[prost(message, repeated, tag = "2")]
    pub edges: Vec<ProtoNetworkEdge>,
    #[prost(message, repeated, tag = "3")]
    pub regions: Vec<ProtoNetworkRegion>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoText {
    #[prost(string, tag = "1")]
    pub content: String,
    #[prost(float, tag = "2")]
    pub font_size: f32,
    #[prost(string, tag = "3")]
    pub font_family: String,
    #[prost(uint32, tag = "4")]
    pub text_align: u32,
    #[prost(float, tag = "5")]
    pub line_height: f32,
    #[prost(uint32, tag = "6")]
    pub font_weight: u32,
    #[prost(bool, tag = "7")]
    pub italic: bool,
    #[prost(float, tag = "8")]
    pub letter_spacing: f32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoImage {
    #[prost(float, tag = "1")]
    pub width: f32,
    #[prost(float, tag = "2")]
    pub height: f32,
    #[prost(uint32, tag = "3")]
    pub image_id: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoGeometry {
    /// Only one of these will be set (simulated oneof).
    #[prost(message, optional, tag = "1")]
    pub rect: Option<ProtoRect>,
    #[prost(message, optional, tag = "2")]
    pub ellipse: Option<ProtoEllipse>,
    #[prost(message, optional, tag = "3")]
    pub path: Option<ProtoPath>,
    #[prost(message, optional, tag = "4")]
    pub text: Option<ProtoText>,
    #[prost(message, optional, tag = "5")]
    pub image: Option<ProtoImage>,
}

/// Encoded raster image bytes stored at the document level.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoImageData {
    #[prost(uint32, tag = "1")]
    pub id: u32,
    #[prost(bytes = "vec", tag = "2")]
    pub bytes: Vec<u8>,
    #[prost(string, tag = "3")]
    pub mime: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoNode {
    #[prost(uint32, tag = "1")]
    pub id: u32,
    #[prost(string, tag = "2")]
    pub name: String,
    /// NodeType as u32: 0=Path, 1=Rect, 2=Ellipse, 3=Group, 4=Text
    #[prost(uint32, tag = "3")]
    pub node_type: u32,
    /// 3x3 transform matrix (9 floats, column-major)
    #[prost(message, optional, tag = "4")]
    pub transform: Option<ProtoTransform>,
    #[prost(message, optional, tag = "5")]
    pub style: Option<ProtoStyle>,
    #[prost(message, optional, tag = "6")]
    pub geometry: Option<ProtoGeometry>,
    #[prost(uint32, repeated, tag = "7")]
    pub children: Vec<u32>,
    #[prost(uint32, optional, tag = "8")]
    pub parent: Option<u32>,
    #[prost(bool, tag = "9")]
    pub visible: bool,
    #[prost(bool, tag = "10")]
    pub locked: bool,
    /// Masking (Figma-style): this node masks the siblings painted above it.
    #[prost(bool, tag = "11")]
    pub is_mask: bool,
    /// 0 = alpha (default), 1 = luminance (reserved).
    #[prost(uint32, tag = "12")]
    pub mask_type: u32,
    /// Reserved: clip descendants to this node's bounds (frames — not yet wired).
    #[prost(bool, tag = "13")]
    pub clip_content: bool,
    /// This Group is a Live Paint group (special object).
    #[prost(bool, tag = "14")]
    pub live_paint: bool,
    /// Non-destructive Boolean Group, stored as op+1 so proto3's 0-default means
    /// "not a boolean group": 0 = none, 1 = union, 2 = subtract, 3 = intersect,
    /// 4 = exclude. The cached outline is not serialized (recomputed on load).
    #[prost(uint32, tag = "15")]
    pub boolean_op: u32,
}

/// A preserved face fill from the vector network.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoFaceFill {
    /// Centroid position for re-mapping after graph rebuild.
    #[prost(float, tag = "1")]
    pub centroid_x: f32,
    #[prost(float, tag = "2")]
    pub centroid_y: f32,
    #[prost(message, optional, tag = "3")]
    pub fill: Option<ProtoColor>,
    /// Sorted set of source-node ids bounding this face (the "signature").
    /// Lets fills re-attach to the same region after shapes move/reshape,
    /// independent of centroid drift. Empty in pre-v5 files (centroid-only).
    #[prost(uint32, repeated, tag = "4")]
    pub source_nodes: Vec<u32>,
}

/// A preserved painted edge from the vector network. Anchor is in the source
/// node's local space so it survives moves/transforms.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoPaintedEdge {
    #[prost(uint32, tag = "1")]
    pub source_node: u32,
    #[prost(float, tag = "2")]
    pub local_x: f32,
    #[prost(float, tag = "3")]
    pub local_y: f32,
    #[prost(message, optional, tag = "4")]
    pub color: Option<ProtoColor>,
    #[prost(float, tag = "5")]
    pub width: f32,
    /// Structural identity: source-segment ordinal (+1; 0 = none/legacy) + t.
    #[prost(uint32, tag = "6")]
    pub seg_plus1: u32,
    #[prost(float, tag = "7")]
    pub t: f32,
}

/// A named artboard (frame). See `crate::Artboard`.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoArtboard {
    #[prost(uint32, tag = "1")]
    pub id: u32,
    #[prost(string, tag = "2")]
    pub name: String,
    #[prost(float, tag = "3")]
    pub x: f32,
    #[prost(float, tag = "4")]
    pub y: f32,
    #[prost(float, tag = "5")]
    pub w: f32,
    #[prost(float, tag = "6")]
    pub h: f32,
    #[prost(message, optional, tag = "7")]
    pub background: Option<ProtoColor>,
}

/// The top-level document message.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoDocument {
    #[prost(uint32, tag = "1")]
    pub format_version: u32,
    #[prost(message, repeated, tag = "2")]
    pub nodes: Vec<ProtoNode>,
    #[prost(uint32, repeated, tag = "3")]
    pub root_ids: Vec<u32>,
    #[prost(uint32, tag = "4")]
    pub next_id: u32,
    /// Live Paint face fills (for preservation across saves).
    #[prost(message, repeated, tag = "5")]
    pub face_fills: Vec<ProtoFaceFill>,
    /// Gap tolerance for vector network.
    #[prost(float, tag = "6")]
    pub gap_tolerance: f32,
    /// Document dimensions (default 1000x1000).
    #[prost(float, optional, tag = "7")]
    pub document_width: Option<f32>,
    #[prost(float, optional, tag = "8")]
    pub document_height: Option<f32>,
    /// Encoded raster images referenced by Geometry::Image nodes.
    #[prost(message, repeated, tag = "9")]
    pub images: Vec<ProtoImageData>,
    /// Artboards (frames). Empty in pre-artboard files/snapshots — `to_scene`
    /// synthesizes a single "Artboard 1" from document_width/height in that case.
    #[prost(message, repeated, tag = "10")]
    pub artboards: Vec<ProtoArtboard>,
    /// Live Paint gap-closing distance in world units (0 = off).
    #[prost(float, tag = "11")]
    pub gap_bridge_distance: f32,
    /// Live Paint painted edge strokes.
    #[prost(message, repeated, tag = "12")]
    pub painted_edges: Vec<ProtoPaintedEdge>,
    /// Node id of the active Live Paint group (0 = none).
    #[prost(uint32, tag = "13")]
    pub live_paint_group: u32,
    /// Vertical ruler guides — world x positions.
    #[prost(float, repeated, tag = "14")]
    pub guides_x: Vec<f32>,
    /// Horizontal ruler guides — world y positions.
    #[prost(float, repeated, tag = "15")]
    pub guides_y: Vec<f32>,
    /// Document color swatches (editor-owned JSON blob).
    #[prost(string, tag = "16")]
    pub swatches_json: String,
    /// Text-on-path links (editor-owned JSON blob, `{textId: pathId}`).
    #[prost(string, tag = "17")]
    pub text_paths_json: String,
    /// Arrowhead / line-ending markers (editor-owned JSON blob).
    #[prost(string, tag = "18")]
    pub markers_json: String,
    /// Locked ruler guides (editor-owned JSON blob, `{"x":[…],"y":[…]}`).
    #[prost(string, tag = "19")]
    pub guide_locks_json: String,
}

/// A history/undo/drag snapshot. Wraps a full document plus the transient
/// selection (which `ProtoDocument` deliberately omits, since files shouldn't
/// carry selection but undo must restore it). This is the protobuf replacement
/// for the old positional-bincode `Scene` snapshot: tagged fields mean adding a
/// field can never corrupt an existing stream, so the "no skip_serializing_if"
/// bincode landmine is gone.
#[derive(Clone, PartialEq, Message)]
pub struct ProtoSnapshot {
    #[prost(message, optional, tag = "1")]
    pub document: Option<ProtoDocument>,
    #[prost(uint32, repeated, tag = "2")]
    pub selection: Vec<u32>,
}

// ─── Conversion: Internal → Proto ───────────────────────────────────────────────

impl From<&Color> for ProtoColor {
    fn from(c: &Color) -> Self {
        ProtoColor { r: c.r, g: c.g, b: c.b, a: c.a }
    }
}

impl From<&ProtoColor> for Color {
    fn from(c: &ProtoColor) -> Self {
        Color { r: c.r, g: c.g, b: c.b, a: c.a }
    }
}

impl From<&Gradient> for ProtoGradient {
    fn from(g: &Gradient) -> Self {
        ProtoGradient {
            gradient_type: match g.gradient_type {
                GradientType::Linear => 0,
                GradientType::Radial => 1,
            },
            stops: g.stops.iter().map(|s| ProtoGradientStop {
                offset: s.offset,
                color: Some(ProtoColor { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a }),
            }).collect(),
            start_x: g.start_x,
            start_y: g.start_y,
            end_x: g.end_x,
            end_y: g.end_y,
            spread: g.spread as u32,
            has_focal: g.focal.is_some(),
            focal_x: g.focal.as_ref().map(|f| f.x).unwrap_or(0.0),
            focal_y: g.focal.as_ref().map(|f| f.y).unwrap_or(0.0),
            focal_r: g.focal.as_ref().map(|f| f.r).unwrap_or(0.0),
            has_transform: g.transform.is_some(),
            transform: g.transform.map(|t| t.to_vec()).unwrap_or_default(),
        }
    }
}

impl From<&ProtoGradient> for Gradient {
    fn from(g: &ProtoGradient) -> Self {
        Gradient {
            gradient_type: if g.gradient_type == 1 { GradientType::Radial } else { GradientType::Linear },
            stops: g.stops.iter().map(|s| {
                let c = s.color.as_ref().map(|c| Color { r: c.r, g: c.g, b: c.b, a: c.a })
                    .unwrap_or(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 });
                GradientStop { offset: s.offset, color: c }
            }).collect(),
            start_x: g.start_x,
            start_y: g.start_y,
            end_x: g.end_x,
            end_y: g.end_y,
            spread: g.spread as u8,
            focal: if g.has_focal {
                Some(GradientFocal { x: g.focal_x, y: g.focal_y, r: g.focal_r })
            } else {
                None
            },
            transform: if g.has_transform && g.transform.len() == 6 {
                let mut t = [0.0f32; 6];
                t.copy_from_slice(&g.transform);
                Some(t)
            } else {
                None
            },
        }
    }
}

impl From<&Style> for ProtoStyle {
    fn from(s: &Style) -> Self {
        ProtoStyle {
            fills: s.fills.iter().map(|f| f.into()).collect(),
            strokes: s.strokes.iter().map(|st| st.into()).collect(),
            opacity: Some(s.opacity),
            corner_radius: s.corner_radius,
            blend_mode: s.blend_mode as u32,
            fill_rule: s.fill_rule as u32,
            effects: s.effects.iter().map(effect_to_proto).collect(),
        }
    }
}

impl From<&ProtoStyle> for Style {
    fn from(s: &ProtoStyle) -> Self {
        Style {
            fills: s.fills.iter().map(|f| Paint::from(f)).collect(),
            strokes: s.strokes.iter().map(|st| crate::Stroke::from(st)).collect(),
            opacity: s.opacity.unwrap_or(1.0),
            blend_mode: s.blend_mode as u8,
            fill_rule: s.fill_rule as u8,
            corner_radius: s.corner_radius,
            effects: s.effects.iter().filter_map(proto_to_effect).collect(),
        }
    }
}

fn effect_to_proto(e: &crate::Effect) -> ProtoEffect {
    match e {
        crate::Effect::Blur { radius, radius_y } => ProtoEffect {
            kind: 0, radius: *radius, dx: 0.0, dy: 0.0, color: None, matrix: Vec::new(), linear_rgb: false,
            radius_y: radius_y.unwrap_or(0.0),
        },
        crate::Effect::DropShadow { dx, dy, blur, color } => ProtoEffect {
            kind: 1, radius: *blur, dx: *dx, dy: *dy, color: Some(color.into()), matrix: Vec::new(), linear_rgb: false,
            radius_y: 0.0,
        },
        crate::Effect::ColorMatrix { matrix, linear_rgb } => ProtoEffect {
            kind: 2, radius: 0.0, dx: 0.0, dy: 0.0, color: None, matrix: matrix.to_vec(), linear_rgb: *linear_rgb,
            radius_y: 0.0,
        },
    }
}

fn proto_to_effect(e: &ProtoEffect) -> Option<crate::Effect> {
    match e.kind {
        0 => Some(crate::Effect::Blur {
            radius: e.radius,
            radius_y: if e.radius_y > 0.0 { Some(e.radius_y) } else { None },
        }),
        1 => Some(crate::Effect::DropShadow {
            dx: e.dx, dy: e.dy, blur: e.radius,
            color: e.color.as_ref().map(Color::from).unwrap_or(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
        }),
        2 => {
            let mut m = [0.0f32; 20];
            if e.matrix.len() == 20 { m.copy_from_slice(&e.matrix); }
            Some(crate::Effect::ColorMatrix { matrix: m, linear_rgb: e.linear_rgb })
        }
        _ => None,
    }
}

impl From<&crate::Transform2D> for ProtoTransform {
    fn from(t: &crate::Transform2D) -> Self {
        ProtoTransform {
            x: t.x, y: t.y,
            rotation_deg: t.rotation_deg,
            skew_x_deg: t.skew_x_deg,
            skew_y_deg: t.skew_y_deg,
            scale_x: t.scale_x,
            scale_y: t.scale_y,
        }
    }
}

impl From<&ProtoTransform> for crate::Transform2D {
    fn from(pt: &ProtoTransform) -> Self {
        crate::Transform2D {
            x: pt.x, y: pt.y,
            rotation_deg: pt.rotation_deg,
            skew_x_deg: pt.skew_x_deg,
            skew_y_deg: pt.skew_y_deg,
            scale_x: if pt.scale_x == 0.0 { 1.0 } else { pt.scale_x },
            scale_y: if pt.scale_y == 0.0 { 1.0 } else { pt.scale_y },
        }
    }
}

impl From<&Paint> for ProtoPaint {
    fn from(p: &Paint) -> Self {
        match p {
            Paint::Solid(c) => ProtoPaint { solid: Some(c.into()), gradient: None, pattern: None },
            Paint::Gradient(g) => ProtoPaint { solid: None, gradient: Some(g.into()), pattern: None },
            Paint::Pattern(pat) => ProtoPaint {
                solid: None, gradient: None,
                pattern: Some(ProtoPattern {
                    image_id: pat.image_id,
                    width: pat.width,
                    height: pat.height,
                    transform: pat.transform.to_vec(),
                }),
            },
        }
    }
}

impl From<&ProtoPaint> for Paint {
    fn from(p: &ProtoPaint) -> Self {
        if let Some(pat) = &p.pattern {
            let t = &pat.transform;
            let transform = if t.len() == 6 {
                [t[0], t[1], t[2], t[3], t[4], t[5]]
            } else {
                [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
            };
            Paint::Pattern(crate::Pattern { image_id: pat.image_id, width: pat.width, height: pat.height, transform })
        } else if let Some(g) = &p.gradient {
            Paint::Gradient(g.into())
        } else if let Some(c) = &p.solid {
            Paint::Solid(c.into())
        } else {
            Paint::Solid(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 })
        }
    }
}

impl From<&crate::StrokeAlignment> for u32 {
    fn from(a: &crate::StrokeAlignment) -> Self {
        match a {
            crate::StrokeAlignment::Center => 0,
            crate::StrokeAlignment::Inner => 1,
            crate::StrokeAlignment::Outer => 2,
        }
    }
}

impl From<u32> for crate::StrokeAlignment {
    fn from(v: u32) -> Self {
        match v {
            1 => crate::StrokeAlignment::Inner,
            2 => crate::StrokeAlignment::Outer,
            _ => crate::StrokeAlignment::Center,
        }
    }
}

impl From<&crate::Stroke> for ProtoStroke {
    fn from(s: &crate::Stroke) -> Self {
        ProtoStroke {
            paint: s.paint.as_ref().map(|p| p.into()),
            width: s.width,
            cap: s.cap as u32,
            join: s.join as u32,
            dash_array: s.dash_array.clone(),
            dash_offset: s.dash_offset,
            miter_limit: s.miter_limit,
            alignment: (&s.alignment).into(),
        }
    }
}

impl From<&ProtoStroke> for crate::Stroke {
    fn from(s: &ProtoStroke) -> Self {
        crate::Stroke {
            paint: s.paint.as_ref().map(|p| p.into()),
            width: s.width,
            cap: s.cap as u8,
            join: s.join as u8,
            dash_array: s.dash_array.clone(),
            dash_offset: s.dash_offset,
            miter_limit: s.miter_limit,
            alignment: s.alignment.into(),
        }
    }
}



impl From<&PathPoint> for ProtoPathPoint {
    fn from(p: &PathPoint) -> Self {
        ProtoPathPoint {
            x: p.x, y: p.y,
            cp1_x: p.cp1.x, cp1_y: p.cp1.y,
            cp2_x: p.cp2.x, cp2_y: p.cp2.y,
            corner_radius: p.corner_radius,
        }
    }
}

impl From<&ProtoPathPoint> for PathPoint {
    fn from(p: &ProtoPathPoint) -> Self {
        PathPoint {
            x: p.x, y: p.y,
            cp1: Vec2::new(p.cp1_x, p.cp1_y),
            cp2: Vec2::new(p.cp2_x, p.cp2_y),
            corner_radius: p.corner_radius,
        }
    }
}

fn node_type_to_u32(nt: NodeType) -> u32 {
    match nt {
        NodeType::Path => 0,
        NodeType::Rect => 1,
        NodeType::Ellipse => 2,
        NodeType::Group => 3,
        NodeType::Text => 4,
        NodeType::Image => 5,
    }
}

fn u32_to_node_type(v: u32) -> NodeType {
    match v {
        0 => NodeType::Path,
        1 => NodeType::Rect,
        2 => NodeType::Ellipse,
        3 => NodeType::Group,
        4 => NodeType::Text,
        5 => NodeType::Image,
        _ => NodeType::Rect,
    }
}

fn geometry_to_proto(g: &Geometry) -> ProtoGeometry {
    match g {
        Geometry::Rect { width, height } => ProtoGeometry {
            rect: Some(ProtoRect { width: *width, height: *height }),
            ellipse: None, path: None, text: None, image: None,
        },
        Geometry::Ellipse { radius_x, radius_y } => ProtoGeometry {
            rect: None,
            ellipse: Some(ProtoEllipse { radius_x: *radius_x, radius_y: *radius_y }),
            path: None, text: None, image: None,
        },
        Geometry::Path { ref subpaths, ref network } => ProtoGeometry {
            rect: None, ellipse: None,
            path: Some(ProtoPath {
                legacy_points: Vec::new(),
                subpaths: subpaths.iter().map(|sp| ProtoSubpath {
                    points: sp.points.iter().map(|p| p.into()).collect(),
                    closed: sp.closed,
                }).collect(),
                network: network.as_ref().map(|n| network_to_proto(n)),
            }),
            text: None, image: None,
        },
        Geometry::Text { content, font_size, ref font_family, text_align, line_height, font_weight, italic, letter_spacing } => ProtoGeometry {
            rect: None, ellipse: None, path: None, image: None,
            text: Some(ProtoText {
                content: content.clone(),
                font_size: *font_size,
                font_family: font_family.clone(),
                text_align: *text_align as u32,
                line_height: *line_height,
                font_weight: *font_weight as u32,
                italic: *italic,
                letter_spacing: *letter_spacing,
            }),
        },
        Geometry::Image { width, height, image_id } => ProtoGeometry {
            rect: None, ellipse: None, path: None, text: None,
            image: Some(ProtoImage { width: *width, height: *height, image_id: *image_id }),
        },
    }
}

fn proto_to_geometry(g: &ProtoGeometry) -> Geometry {
    if let Some(img) = &g.image {
        Geometry::Image { width: img.width, height: img.height, image_id: img.image_id }
    } else if let Some(r) = &g.rect {
        Geometry::Rect { width: r.width, height: r.height }
    } else if let Some(e) = &g.ellipse {
        Geometry::Ellipse { radius_x: e.radius_x, radius_y: e.radius_y }
    } else if let Some(p) = &g.path {
        // Defensive: if migrate() didn't run (direct to_scene call on a v1
        // doc), still honor the legacy flat point list.
        if p.subpaths.is_empty() && !p.legacy_points.is_empty() {
            let sp = legacy_points_to_subpath(p.legacy_points.clone());
            Geometry::Path {
                subpaths: vec![crate::Subpath {
                    points: sp.points.iter().map(|pp| pp.into()).collect(),
                    closed: sp.closed,
                }],
                network: p.network.as_ref().map(|n| proto_to_network(n)),
            }
        } else {
            Geometry::Path {
                subpaths: p.subpaths.iter().map(|sp| crate::Subpath {
                    points: sp.points.iter().map(|pp| pp.into()).collect(),
                    closed: sp.closed,
                }).collect(),
                network: p.network.as_ref().map(|n| proto_to_network(n)),
            }
        }
    } else if let Some(t) = &g.text {
        Geometry::Text {
            content: t.content.clone(),
            font_size: t.font_size,
            font_family: t.font_family.clone(),
            text_align: t.text_align as u8,
            line_height: if t.line_height > 0.0 { t.line_height } else { 1.2 },
            font_weight: if t.font_weight > 0 { t.font_weight as u16 } else { 400 },
            italic: t.italic,
            letter_spacing: t.letter_spacing,
        }
    } else {
        Geometry::Rect { width: 100.0, height: 100.0 }
    }
}

fn network_to_proto(n: &NodeVectorNetwork) -> ProtoNodeNetwork {
    ProtoNodeNetwork {
        vertices: n.vertices.iter().map(|v| ProtoNetworkVertex {
            x: v.position.x,
            y: v.position.y,
            handle_in_x: v.handle_in.map(|h| h.x),
            handle_in_y: v.handle_in.map(|h| h.y),
            handle_out_x: v.handle_out.map(|h| h.x),
            handle_out_y: v.handle_out.map(|h| h.y),
            corner_radius: v.corner_radius,
        }).collect(),
        edges: n.edges.iter().map(|e| ProtoNetworkEdge {
            start_vertex: e.start_vertex,
            end_vertex: e.end_vertex,
        }).collect(),
        regions: n.regions.iter().map(|r| ProtoNetworkRegion {
            edge_loop: r.edge_loop.clone(),
            fill: r.fill.as_ref().map(|c| c.into()),
        }).collect(),
    }
}

fn proto_to_network(n: &ProtoNodeNetwork) -> NodeVectorNetwork {
    NodeVectorNetwork {
        vertices: n.vertices.iter().map(|v| NetworkVertex {
            position: Vec2::new(v.x, v.y),
            handle_in: match (v.handle_in_x, v.handle_in_y) {
                (Some(x), Some(y)) => Some(Vec2::new(x, y)),
                _ => None,
            },
            handle_out: match (v.handle_out_x, v.handle_out_y) {
                (Some(x), Some(y)) => Some(Vec2::new(x, y)),
                _ => None,
            },
            corner_radius: v.corner_radius,
        }).collect(),
        edges: n.edges.iter().map(|e| NetworkEdge {
            start_vertex: e.start_vertex,
            end_vertex: e.end_vertex,
        }).collect(),
        regions: n.regions.iter().map(|r| NetworkRegion {
            edge_loop: r.edge_loop.clone(),
            fill: r.fill.as_ref().map(|c| c.into()),
        }).collect(),
    }
}

fn node_to_proto(node: &Node) -> ProtoNode {
    ProtoNode {
        id: node.id,
        name: node.name.clone(),
        node_type: node_type_to_u32(node.node_type),
        transform: Some((&node.transform).into()),
        style: Some((&node.style).into()),
        geometry: Some(geometry_to_proto(&node.geometry)),
        children: node.children.clone(),
        parent: node.parent,
        visible: node.visible,
        locked: node.locked,
        is_mask: node.is_mask,
        mask_type: node.mask_type as u32,
        clip_content: node.clip_content,
        live_paint: node.live_paint,
        boolean_op: node.boolean_op.map(|op| op as u32 + 1).unwrap_or(0),
    }
}

fn proto_to_node(pn: &ProtoNode) -> Node {
    Node {
        id: pn.id,
        name: pn.name.clone(),
        node_type: u32_to_node_type(pn.node_type),
        transform: pn.transform.as_ref()
            .map(|t| crate::Transform2D::from(t))
            .unwrap_or(crate::Transform2D::IDENTITY),
        style: pn.style.as_ref().map(|s| s.into()).unwrap_or_else(|| Style {
            fills: vec![Paint::Solid(Color { r: 0.5, g: 0.5, b: 0.5, a: 1.0 })],
            strokes: Vec::new(),
            opacity: 1.0,
            blend_mode: 0,
            fill_rule: 0,
            corner_radius: 0.0,
            effects: Vec::new(),
        }),
        geometry: pn.geometry.as_ref().map(proto_to_geometry).unwrap_or(
            Geometry::Rect { width: 100.0, height: 100.0 }
        ),
        children: pn.children.clone(),
        parent: pn.parent,
        visible: pn.visible,
        locked: pn.locked,
        is_mask: pn.is_mask,
        mask_type: pn.mask_type as u8,
        clip_content: pn.clip_content,
        live_paint: pn.live_paint,
        boolean_op: if pn.boolean_op == 0 { None } else { Some((pn.boolean_op - 1) as u8) },
        bool_cache: Vec::new(),
    }
}

// ─── Document-Level Conversion ──────────────────────────────────────────────────

impl ProtoDocument {
    /// Convert the current scene to a ProtoDocument.
    pub fn from_scene(scene: &Scene, next_id: u32) -> Self {
        // Deterministic node ordering (HashMap iteration order is not stable).
        // Undo relies on serialize→deserialize→serialize being a byte-exact
        // fixed point (see gesture_history.test.ts), which requires this.
        let mut nodes: Vec<ProtoNode> = scene.nodes.values().map(node_to_proto).collect();
        nodes.sort_by_key(|n| n.id);
        let root_ids = scene.root_nodes.clone();

        // Preserve face fills from the vector network as centroids (remapped on
        // the next rebuild). Include BOTH computed faces and not-yet-applied
        // `pending_fills` so a snapshot taken before a rebuild re-serializes
        // identically after a round-trip (deserialize leaves the network dirty
        // with pending fills; without this the fills would silently drop on
        // undo of a live-painted scene).
        let mut face_fills: Vec<ProtoFaceFill> = scene.vector_network.faces.values()
            .filter(|f| f.fill.is_some() && !f.is_outer)
            .map(|f| {
                let fill = f.fill.as_ref().unwrap();
                let centroid = crate::vector_network::face_centroid(f);
                ProtoFaceFill {
                    centroid_x: centroid.x,
                    centroid_y: centroid.y,
                    fill: Some(fill.into()),
                    source_nodes: f.signature.clone(),
                }
            })
            .collect();
        for pf in &scene.vector_network.pending_fills {
            face_fills.push(ProtoFaceFill {
                centroid_x: pf.centroid.x,
                centroid_y: pf.centroid.y,
                fill: Some((&pf.color).into()),
                source_nodes: pf.signature.clone(),
            });
        }
        // Deterministic fill ordering for byte-exact snapshots.
        face_fills.sort_by(|a, b| {
            a.centroid_x.partial_cmp(&b.centroid_x).unwrap_or(std::cmp::Ordering::Equal)
                .then(a.centroid_y.partial_cmp(&b.centroid_y).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.source_nodes.cmp(&b.source_nodes))
        });

        // Images, in deterministic id order (byte-exact snapshots).
        let mut images: Vec<ProtoImageData> = scene.images.iter()
            .map(|(&id, data)| ProtoImageData {
                id,
                bytes: data.bytes.clone(),
                mime: data.mime.clone(),
            })
            .collect();
        images.sort_by_key(|i| i.id);

        // Artboards, in declared order (already deterministic).
        let artboards: Vec<ProtoArtboard> = scene.artboards.iter().map(|a| ProtoArtboard {
            id: a.id,
            name: a.name.clone(),
            x: a.x,
            y: a.y,
            w: a.w,
            h: a.h,
            background: Some((&a.background).into()),
        }).collect();

        // Legacy document dims mirror the primary artboard so pre-artboard
        // readers still open the file with a sensible page size.
        let (doc_w, doc_h) = scene.artboards.first()
            .map(|a| (a.w, a.h))
            .unwrap_or((scene.document_width, scene.document_height));

        ProtoDocument {
            format_version: FORMAT_VERSION,
            nodes,
            root_ids,
            next_id,
            face_fills,
            gap_tolerance: scene.vector_network.gap_tolerance,
            document_width: Some(doc_w),
            document_height: Some(doc_h),
            images,
            artboards,
            gap_bridge_distance: scene.vector_network.gap_bridge_distance,
            painted_edges: {
                let mut pe: Vec<ProtoPaintedEdge> = scene.vector_network.painted_edges.iter()
                    .map(|p| ProtoPaintedEdge {
                        source_node: p.source_node,
                        local_x: p.local.x,
                        local_y: p.local.y,
                        color: Some((&p.color).into()),
                        width: p.width,
                        seg_plus1: (p.seg + 1).max(0) as u32,
                        t: p.t,
                    })
                    .collect();
                // Deterministic order for byte-exact snapshots.
                pe.sort_by(|a, b| a.source_node.cmp(&b.source_node)
                    .then(a.local_x.partial_cmp(&b.local_x).unwrap_or(std::cmp::Ordering::Equal))
                    .then(a.local_y.partial_cmp(&b.local_y).unwrap_or(std::cmp::Ordering::Equal)));
                pe
            },
            live_paint_group: scene.live_paint_group.unwrap_or(0),
            guides_x: scene.guides_x.clone(),
            guides_y: scene.guides_y.clone(),
            swatches_json: scene.swatches_json.clone(),
            text_paths_json: scene.text_paths_json.clone(),
            markers_json: scene.markers_json.clone(),
            guide_locks_json: scene.guide_locks_json.clone(),
        }
    }

    /// Convert a ProtoDocument back to a Scene + next_id.
    pub fn to_scene(&self) -> (Scene, u32) {
        let mut nodes = std::collections::HashMap::new();
        for pn in &self.nodes {
            let node = proto_to_node(pn);
            nodes.insert(node.id, node);
        }

        let mut vn = VectorNetwork::default();
        vn.gap_tolerance = if self.gap_tolerance > 0.0 {
            self.gap_tolerance
        } else {
            2.0
        };
        vn.gap_bridge_distance = self.gap_bridge_distance.max(0.0);
        // Face fills will be re-mapped after the first network rebuild. Stored as
        // pending on the network; signature (source_nodes) lets them re-attach to
        // the right region even if shapes moved between save and load.
        vn.pending_fills = self.face_fills.iter().filter_map(|ff| {
            ff.fill.as_ref().map(|c| crate::vector_network::PendingFill {
                centroid: Vec2::new(ff.centroid_x, ff.centroid_y),
                signature: ff.source_nodes.clone(),
                color: Color::from(c),
            })
        }).collect();
        vn.painted_edges = self.painted_edges.iter().filter_map(|pe| {
            pe.color.as_ref().map(|c| crate::vector_network::PaintedEdge {
                source_node: pe.source_node,
                local: Vec2::new(pe.local_x, pe.local_y),
                color: Color::from(c),
                width: pe.width,
                seg: pe.seg_plus1 as i32 - 1,
                t: pe.t,
            })
        }).collect();

        let images = self.images.iter()
            .map(|img| (img.id, crate::ImageData { bytes: img.bytes.clone(), mime: img.mime.clone() }))
            .collect();

        let doc_w = self.document_width.unwrap_or(1000.0);
        let doc_h = self.document_height.unwrap_or(1000.0);

        // Artboards: use the stored list, or synthesize one from the legacy
        // document dims for pre-artboard files/snapshots. This single rule
        // migrates old .vec files, old IndexedDB autosaves, and old SVG payloads.
        let artboards: Vec<crate::Artboard> = if self.artboards.is_empty() {
            vec![crate::Artboard {
                id: 1,
                name: "Artwork 1".to_string(),
                x: 0.0,
                y: 0.0,
                w: doc_w,
                h: doc_h,
                background: crate::Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
            }]
        } else {
            self.artboards.iter().map(|a| crate::Artboard {
                id: a.id,
                name: a.name.clone(),
                x: a.x,
                y: a.y,
                w: a.w,
                h: a.h,
                background: a.background.as_ref().map(Color::from)
                    .unwrap_or(Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }),
            }).collect()
        };

        // Keep the legacy mirror in sync with the primary artboard.
        let (mirror_w, mirror_h) = artboards.first().map(|a| (a.w, a.h)).unwrap_or((doc_w, doc_h));

        let scene = Scene {
            nodes,
            root_nodes: self.root_ids.clone(),
            selection: Vec::new(),
            vector_network: vn,
            document_width: mirror_w,
            document_height: mirror_h,
            images,
            artboards,
            live_paint_group: if self.live_paint_group != 0 { Some(self.live_paint_group) } else { None },
            guides_x: self.guides_x.clone(),
            guides_y: self.guides_y.clone(),
            swatches_json: self.swatches_json.clone(),
            text_paths_json: self.text_paths_json.clone(),
            markers_json: self.markers_json.clone(),
            guide_locks_json: self.guide_locks_json.clone(),
        };

        let next_id = if self.next_id > 0 {
            self.next_id
        } else {
            // Compute from max node id
            scene.nodes.keys().copied().max().unwrap_or(0) + 1
        };

        (scene, next_id)
    }
}

// ─── Serialize / Deserialize ────────────────────────────────────────────────────

/// Serialize a scene to protobuf bytes.
pub fn serialize_to_proto(scene: &Scene, next_id: u32) -> Vec<u8> {
    let doc = ProtoDocument::from_scene(scene, next_id);
    doc.encode_to_vec()
}

/// Deserialize a scene from protobuf bytes.
pub fn deserialize_from_proto(data: &[u8]) -> Option<(Scene, u32)> {
    let mut doc = ProtoDocument::decode(data).ok()?;
    migrate(&mut doc);
    Some(doc.to_scene())
}

/// Serialize a full history/undo/drag snapshot (document + selection).
/// This is what `Engine::serialize_scene` stores on the undo stack.
pub fn serialize_snapshot(scene: &Scene, next_id: u32) -> Vec<u8> {
    let snap = ProtoSnapshot {
        document: Some(ProtoDocument::from_scene(scene, next_id)),
        selection: scene.selection.clone(),
    };
    snap.encode_to_vec()
}

/// Restore a scene + next_id from a snapshot produced by `serialize_snapshot`.
/// Restores selection (which the plain document path drops).
pub fn deserialize_snapshot(data: &[u8]) -> Option<(Scene, u32)> {
    let snap = ProtoSnapshot::decode(data).ok()?;
    let mut doc = snap.document?;
    migrate(&mut doc);
    let (mut scene, next_id) = doc.to_scene();
    scene.selection = snap.selection;
    Some((scene, next_id))
}

/// Serialize a scene to base64-encoded protobuf (for SVG embedding).
pub fn serialize_to_base64(scene: &Scene, next_id: u32) -> String {
    let bytes = serialize_to_proto(scene, next_id);
    BASE64.encode(&bytes)
}

/// Deserialize a scene from base64-encoded protobuf (from SVG metadata).
pub fn deserialize_from_base64(b64: &str) -> Option<(Scene, u32)> {
    let bytes = BASE64.decode(b64.trim()).ok()?;
    deserialize_from_proto(&bytes)
}

/// Run schema migrations on older format versions.
fn migrate(doc: &mut ProtoDocument) {
    if doc.format_version <= 1 {
        migrate_v1_to_v2(doc);
    }
    doc.format_version = FORMAT_VERSION;
}

/// v1 → v2: wrap each path's flat point list into a single subpath.
/// Closed-ness in v1 was implied by a duplicated end point (≈ first point);
/// we detect it, drop the duplicate, and preserve its incoming control handle.
fn migrate_v1_to_v2(doc: &mut ProtoDocument) {
    for node in &mut doc.nodes {
        let Some(geo) = node.geometry.as_mut() else { continue };
        let Some(path) = geo.path.as_mut() else { continue };
        if !path.legacy_points.is_empty() && path.subpaths.is_empty() {
            let points = std::mem::take(&mut path.legacy_points);
            path.subpaths.push(legacy_points_to_subpath(points));
        }
    }
}

fn legacy_points_to_subpath(mut points: Vec<ProtoPathPoint>) -> ProtoSubpath {
    let mut closed = false;
    if points.len() >= 3 {
        let first = &points[0];
        let last = &points[points.len() - 1];
        if (first.x - last.x).abs() < 0.01 && (first.y - last.y).abs() < 0.01 {
            closed = true;
            // The duplicated closing point carried the incoming handle of the
            // closing segment; move it onto the first point before dropping.
            let dup = points.pop().unwrap();
            points[0].cp1_x = dup.cp1_x;
            points[0].cp1_y = dup.cp1_y;
        }
    }
    ProtoSubpath { points, closed }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Transform2D, Stroke, StrokeAlignment};
    use std::collections::HashMap;

    fn make_style() -> ProtoStyle {
        ProtoStyle {
            fills: vec![ProtoPaint {
                solid: Some(ProtoColor { r: 1.0, g: 0.0, b: 0.0, a: 1.0 }),
                gradient: None,
                pattern: None,
            }],
            strokes: Vec::new(),
            opacity: Some(1.0),
            corner_radius: 0.0,
            blend_mode: 0,
            fill_rule: 0,
            effects: Vec::new(),
        }
    }

    /// Identity transform for proto node fixtures.
    fn ident_transform() -> ProtoTransform {
        ProtoTransform {
            x: 0.0, y: 0.0,
            rotation_deg: 0.0,
            skew_x_deg: 0.0, skew_y_deg: 0.0,
            scale_x: 1.0, scale_y: 1.0,
        }
    }

    fn pp(x: f32, y: f32) -> ProtoPathPoint {
        ProtoPathPoint { x, y, cp1_x: x, cp1_y: y, cp2_x: x, cp2_y: y, corner_radius: 0.0 }
    }

    /// A v1 file (legacy flat point list, duplicated closing point) must decode
    /// into a single closed subpath without the duplicate.
    #[test]
    fn test_v1_file_migrates_to_subpaths() {
        // v1 writers encoded `points` at tag 1 of ProtoPath — identical wire
        // bytes to encoding `legacy_points` today, so this fixture is
        // wire-exact with a real v1 file.
        let v1_doc = ProtoDocument {
            format_version: 1,
            nodes: vec![ProtoNode {
                id: 1,
                name: "Triangle".into(),
                node_type: 0, // Path
                transform: Some(ident_transform()),
                style: Some(make_style()),
                geometry: Some(ProtoGeometry {
                    rect: None,
                    ellipse: None,
                    path: Some(ProtoPath {
                        legacy_points: vec![
                            pp(0.0, 0.0), pp(100.0, 0.0), pp(50.0, 80.0),
                            pp(0.0, 0.0), // v1 closing duplicate
                        ],
                        subpaths: Vec::new(),
                        network: None,
                    }),
                    text: None,
                    image: None,
                }),
                children: Vec::new(),
                parent: None,
                visible: true,
                locked: false,
                is_mask: false,
                mask_type: 0,
                clip_content: false,
                live_paint: false,
                boolean_op: 0,
            }],
            root_ids: vec![1],
            next_id: 2,
            face_fills: Vec::new(),
            gap_tolerance: 2.0,
            document_width: None,
            document_height: None,
            images: Vec::new(),
            artboards: Vec::new(),
            gap_bridge_distance: 0.0,
            painted_edges: Vec::new(),
            live_paint_group: 0,
            guides_x: Vec::new(),
            guides_y: Vec::new(),
            swatches_json: String::new(),
            text_paths_json: String::new(),
            markers_json: String::new(),
            guide_locks_json: String::new(),
        };

        let bytes = v1_doc.encode_to_vec();
        let (scene, next_id) = deserialize_from_proto(&bytes).expect("v1 file must decode");
        assert_eq!(next_id, 2);

        let node = scene.nodes.get(&1).expect("node present");
        match &node.geometry {
            Geometry::Path { subpaths, .. } => {
                assert_eq!(subpaths.len(), 1);
                assert!(subpaths[0].closed, "duplicated end point implies closed");
                assert_eq!(subpaths[0].points.len(), 3, "closing duplicate dropped");
            }
            other => panic!("expected Path geometry, got {:?}", other),
        }
        // v1 files without document dimensions get defaults
        assert_eq!(scene.document_width, 1000.0);
        assert_eq!(scene.document_height, 1000.0);
    }

    /// An open v1 path (no duplicated end point) stays open.
    #[test]
    fn test_v1_open_path_stays_open() {
        let mut doc = ProtoDocument {
            format_version: 1,
            nodes: vec![],
            root_ids: vec![],
            next_id: 1,
            face_fills: Vec::new(),
            gap_tolerance: 2.0,
            document_width: None,
            document_height: None,
            images: Vec::new(),
            artboards: Vec::new(),
            gap_bridge_distance: 0.0,
            painted_edges: Vec::new(),
            live_paint_group: 0,
            guides_x: Vec::new(),
            guides_y: Vec::new(),
            swatches_json: String::new(),
            text_paths_json: String::new(),
            markers_json: String::new(),
            guide_locks_json: String::new(),
        };
        doc.nodes.push(ProtoNode {
            id: 1,
            name: "Line".into(),
            node_type: 0,
            transform: Some(ident_transform()),
            style: Some(make_style()),
            geometry: Some(ProtoGeometry {
                rect: None,
                ellipse: None,
                path: Some(ProtoPath {
                    legacy_points: vec![pp(0.0, 0.0), pp(50.0, 50.0)],
                    subpaths: Vec::new(),
                    network: None,
                }),
                text: None,
                image: None,
            }),
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
            is_mask: false,
            mask_type: 0,
            clip_content: false,
            live_paint: false,
            boolean_op: 0,
        });

        let bytes = doc.encode_to_vec();
        let (scene, _) = deserialize_from_proto(&bytes).unwrap();
        match &scene.nodes.get(&1).unwrap().geometry {
            Geometry::Path { subpaths, .. } => {
                assert_eq!(subpaths.len(), 1);
                assert!(!subpaths[0].closed);
                assert_eq!(subpaths[0].points.len(), 2);
            }
            other => panic!("expected Path geometry, got {:?}", other),
        }
    }

    /// v2 round trip: subpaths, closed flags, and document size survive.
    #[test]
    fn test_v2_round_trip() {
        let mut nodes = HashMap::new();
        nodes.insert(7, Node {
            id: 7,
            name: "Shape".into(),
            node_type: NodeType::Path,
            transform: Transform2D::from_translation(25.0, 30.0),
            style: Style {
                fills: vec![Paint::Solid(Color { r: 0.2, g: 0.4, b: 0.6, a: 0.75 })],
                strokes: vec![Stroke {
                    paint: Some(Paint::Solid(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 })),
                    width: 3.0,
                    cap: 1,
                    join: 2,
                    dash_array: vec![4.0, 2.0],
                    dash_offset: 1.0,
                    miter_limit: 4.0,
                    alignment: StrokeAlignment::Center,
                }],
                opacity: 0.5,
                corner_radius: 0.0,
                blend_mode: 0,
                fill_rule: 1,
                effects: Vec::new(),
            },
            geometry: Geometry::Path {
                subpaths: vec![
                    crate::Subpath {
                        points: vec![
                            PathPoint { x: 0.0, y: 0.0, cp1: Vec2::new(0.0, 0.0), cp2: Vec2::new(10.0, 0.0), corner_radius: 0.0 },
                            PathPoint { x: 50.0, y: 0.0, cp1: Vec2::new(40.0, 0.0), cp2: Vec2::new(50.0, 0.0), corner_radius: 0.0 },
                            PathPoint { x: 25.0, y: 40.0, cp1: Vec2::new(25.0, 40.0), cp2: Vec2::new(25.0, 40.0), corner_radius: 0.0 },
                        ],
                        closed: true,
                    },
                    crate::Subpath {
                        points: vec![
                            PathPoint { x: 10.0, y: 10.0, cp1: Vec2::new(10.0, 10.0), cp2: Vec2::new(10.0, 10.0), corner_radius: 0.0 },
                            PathPoint { x: 20.0, y: 20.0, cp1: Vec2::new(20.0, 20.0), cp2: Vec2::new(20.0, 20.0), corner_radius: 0.0 },
                        ],
                        closed: false,
                    },
                ],
                network: None,
            },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
            is_mask: false,
            mask_type: 0,
            clip_content: false,
            live_paint: false,
            boolean_op: None,
            bool_cache: Vec::new(),
        });

        let scene = Scene {
            nodes,
            root_nodes: vec![7],
            selection: Vec::new(),
            vector_network: VectorNetwork::default(),
            document_width: 800.0,
            document_height: 600.0,
            images: Default::default(),
            artboards: Vec::new(),
            live_paint_group: None,
            guides_x: Vec::new(),
            guides_y: Vec::new(),
            swatches_json: String::new(),
            text_paths_json: String::new(),
            markers_json: String::new(),
            guide_locks_json: String::new(),
        };

        let bytes = serialize_to_proto(&scene, 8);
        let (scene2, next_id) = deserialize_from_proto(&bytes).unwrap();
        assert_eq!(next_id, 8);
        assert_eq!(scene2.document_width, 800.0);
        assert_eq!(scene2.document_height, 600.0);
        // An empty artboards list synthesizes a single Artboard 1 sized to the doc.
        assert_eq!(scene2.artboards.len(), 1);
        assert_eq!(scene2.artboards[0].w, 800.0);
        assert_eq!(scene2.artboards[0].h, 600.0);

        let node = scene2.nodes.get(&7).unwrap();
        assert_eq!(node.style.opacity, 0.5);
        // Fill opacity now lives in the fill paint's alpha channel.
        match &node.style.fills[0] {
            Paint::Solid(c) => assert_eq!(c.a, 0.75),
            other => panic!("expected solid fill, got {:?}", other),
        }
        assert_eq!(node.style.strokes.len(), 1);
        assert_eq!(node.style.strokes[0].width, 3.0);
        match &node.geometry {
            Geometry::Path { subpaths, .. } => {
                assert_eq!(subpaths.len(), 2);
                assert!(subpaths[0].closed);
                assert!(!subpaths[1].closed);
                assert_eq!(subpaths[0].points.len(), 3);
                assert_eq!(subpaths[0].points[0].cp2, Vec2::new(10.0, 0.0));
                assert_eq!(subpaths[1].points.len(), 2);
            }
            other => panic!("expected Path geometry, got {:?}", other),
        }
    }

    // ─── Artboards ──────────────────────────────────────────────────────────

    fn scene_with_artboards(artboards: Vec<crate::Artboard>) -> Scene {
        Scene {
            nodes: HashMap::new(),
            root_nodes: Vec::new(),
            selection: Vec::new(),
            vector_network: VectorNetwork::default(),
            document_width: 1000.0,
            document_height: 1000.0,
            images: Default::default(),
            artboards,
            live_paint_group: None,
            guides_x: Vec::new(),
            guides_y: Vec::new(),
            swatches_json: String::new(),
            text_paths_json: String::new(),
            markers_json: String::new(),
            guide_locks_json: String::new(),
        }
    }

    fn ab(id: u32, name: &str, x: f32, y: f32, w: f32, h: f32) -> crate::Artboard {
        crate::Artboard {
            id, name: name.to_string(), x, y, w, h,
            background: Color { r: 0.2, g: 0.4, b: 0.6, a: 1.0 },
        }
    }

    #[test]
    fn test_artboards_round_trip() {
        let scene = scene_with_artboards(vec![
            ab(1, "Artboard 1", 0.0, 0.0, 800.0, 600.0),
            ab(2, "Hero", 900.0, 0.0, 1200.0, 400.0),
        ]);
        let bytes = serialize_to_proto(&scene, 3);
        let (scene2, _) = deserialize_from_proto(&bytes).unwrap();
        assert_eq!(scene2.artboards.len(), 2);
        assert_eq!(scene2.artboards[1].name, "Hero");
        assert_eq!(scene2.artboards[1].x, 900.0);
        assert_eq!(scene2.artboards[1].w, 1200.0);
        assert_eq!(scene2.artboards[0].background.b, 0.6);
        // Legacy dims mirror the primary artboard.
        assert_eq!(scene2.document_width, 800.0);
        assert_eq!(scene2.document_height, 600.0);
    }

    #[test]
    fn test_old_bytes_without_artboards_synthesize_one() {
        // A document encoded WITHOUT tag 10 (pre-artboard writer): only doc dims.
        let old = ProtoDocument {
            format_version: FORMAT_VERSION,
            nodes: Vec::new(),
            root_ids: Vec::new(),
            next_id: 1,
            face_fills: Vec::new(),
            gap_tolerance: 2.0,
            document_width: Some(1920.0),
            document_height: Some(1080.0),
            images: Vec::new(),
            artboards: Vec::new(),
            gap_bridge_distance: 0.0,
            painted_edges: Vec::new(),
            live_paint_group: 0,
            guides_x: Vec::new(),
            guides_y: Vec::new(),
            swatches_json: String::new(),
            text_paths_json: String::new(),
            markers_json: String::new(),
            guide_locks_json: String::new(),
        };
        let bytes = old.encode_to_vec();
        let (scene, _) = deserialize_from_proto(&bytes).unwrap();
        assert_eq!(scene.artboards.len(), 1);
        assert_eq!(scene.artboards[0].name, "Artwork 1");
        assert_eq!(scene.artboards[0].w, 1920.0);
        assert_eq!(scene.artboards[0].h, 1080.0);
        assert_eq!(scene.artboards[0].x, 0.0);
    }

    #[test]
    fn test_artboards_survive_snapshot_round_trip() {
        // Undo snapshots must carry artboards (they wrap ProtoDocument).
        let scene = scene_with_artboards(vec![
            ab(1, "A", 0.0, 0.0, 500.0, 500.0),
            ab(2, "B", 600.0, 0.0, 300.0, 700.0),
        ]);
        let snap = serialize_snapshot(&scene, 3);
        let (scene2, next_id) = deserialize_snapshot(&snap).unwrap();
        assert_eq!(next_id, 3);
        assert_eq!(scene2.artboards.len(), 2);
        assert_eq!(scene2.artboards[1].h, 700.0);
    }

    #[test]
    fn test_snapshot_is_byte_exact_fixed_point_with_artboards() {
        // The gesture/undo contract: serialize → deserialize → serialize is a
        // byte-exact fixed point (artboards must not perturb determinism).
        let scene = scene_with_artboards(vec![
            ab(2, "Two", 10.0, 20.0, 640.0, 480.0),
            ab(5, "Five", 700.0, 0.0, 100.0, 100.0),
        ]);
        let snap1 = serialize_snapshot(&scene, 6);
        let (scene2, next_id) = deserialize_snapshot(&snap1).unwrap();
        let snap2 = serialize_snapshot(&scene2, next_id);
        assert_eq!(snap1, snap2);
    }
}
