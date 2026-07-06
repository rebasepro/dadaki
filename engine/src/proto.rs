//! Protobuf serialization for .vec file format.
//!
//! Uses prost derive macros — no protoc or build.rs needed.
//! Provides conversion between internal serde types and proto types.

use prost::Message;
use base64::{Engine as B64Engine, engine::general_purpose::STANDARD as BASE64};
use glam::Vec2;

use crate::{
    Color, Geometry, Gradient, GradientStop, GradientType, Node, NodeType, Paint, PathPoint, Scene, Style,
    vector_network::{VectorNetwork, NodeVectorNetwork, NetworkVertex, NetworkEdge, NetworkRegion},
};

/// Current file format version. Bump when schema changes.
/// v3: per-node vector network.
pub const FORMAT_VERSION: u32 = 4;

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
pub struct ProtoStyle {
    #[prost(message, optional, tag = "1")]
    pub fill: Option<ProtoColor>,
    #[prost(message, optional, tag = "2")]
    pub stroke: Option<ProtoColor>,
    #[prost(float, tag = "3")]
    pub stroke_width: f32,
    #[prost(float, optional, tag = "4")]
    pub opacity: Option<f32>,
    #[prost(uint32, tag = "5")]
    pub stroke_cap: u32,
    #[prost(uint32, tag = "6")]
    pub stroke_join: u32,
    #[prost(float, repeated, tag = "7")]
    pub dash_array: Vec<f32>,
    #[prost(float, tag = "8")]
    pub dash_offset: f32,
    #[prost(float, tag = "9")]
    pub corner_radius: f32,
    #[prost(uint32, tag = "10")]
    pub blend_mode: u32,
    #[prost(uint32, tag = "11")]
    pub fill_rule: u32,
    #[prost(float, optional, tag = "12")]
    pub miter_limit: Option<f32>,
    #[prost(float, optional, tag = "13")]
    pub fill_opacity: Option<f32>,
    #[prost(message, optional, tag = "14")]
    pub fill_gradient: Option<ProtoGradient>,
    #[prost(message, optional, tag = "15")]
    pub stroke_gradient: Option<ProtoGradient>,
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
    #[prost(float, repeated, tag = "4")]
    pub transform: Vec<f32>,
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
        }
    }
}

impl From<&Style> for ProtoStyle {
    fn from(s: &Style) -> Self {
        let (fill_color, fill_gradient) = match &s.fill {
            Some(Paint::Solid(c)) => (Some(c.into()), None),
            Some(Paint::Gradient(g)) => (None, Some(g.into())),
            None => (None, None),
        };
        let (stroke_color, stroke_gradient) = match &s.stroke {
            Some(Paint::Solid(c)) => (Some(c.into()), None),
            Some(Paint::Gradient(g)) => (None, Some(g.into())),
            None => (None, None),
        };
        ProtoStyle {
            fill: fill_color,
            stroke: stroke_color,
            fill_gradient,
            stroke_gradient,
            stroke_width: s.stroke_width,
            opacity: Some(s.opacity),
            stroke_cap: s.stroke_cap as u32,
            stroke_join: s.stroke_join as u32,
            dash_array: s.dash_array.clone(),
            dash_offset: s.dash_offset,
            corner_radius: s.corner_radius,
            blend_mode: s.blend_mode as u32,
            fill_rule: s.fill_rule as u32,
            miter_limit: Some(s.miter_limit),
            fill_opacity: Some(s.fill_opacity),
        }
    }
}

impl From<&ProtoStyle> for Style {
    fn from(s: &ProtoStyle) -> Self {
        let fill = if let Some(g) = &s.fill_gradient {
            Some(Paint::Gradient(g.into()))
        } else {
            s.fill.as_ref().map(|c| Paint::Solid(c.into()))
        };
        let stroke = if let Some(g) = &s.stroke_gradient {
            Some(Paint::Gradient(g.into()))
        } else {
            s.stroke.as_ref().map(|c| Paint::Solid(c.into()))
        };
        Style {
            fill,
            stroke,
            stroke_width: s.stroke_width,
            opacity: s.opacity.unwrap_or(1.0),
            stroke_cap: s.stroke_cap as u8,
            stroke_join: s.stroke_join as u8,
            dash_array: s.dash_array.clone(),
            dash_offset: s.dash_offset,
            corner_radius: s.corner_radius,
            blend_mode: s.blend_mode as u8,
            fill_rule: s.fill_rule as u8,
            miter_limit: s.miter_limit.unwrap_or(4.0),
            fill_opacity: s.fill_opacity.unwrap_or(1.0),
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
    }
}

fn u32_to_node_type(v: u32) -> NodeType {
    match v {
        0 => NodeType::Path,
        1 => NodeType::Rect,
        2 => NodeType::Ellipse,
        3 => NodeType::Group,
        4 => NodeType::Text,
        _ => NodeType::Rect,
    }
}

fn geometry_to_proto(g: &Geometry) -> ProtoGeometry {
    match g {
        Geometry::Rect { width, height } => ProtoGeometry {
            rect: Some(ProtoRect { width: *width, height: *height }),
            ellipse: None, path: None, text: None,
        },
        Geometry::Ellipse { radius_x, radius_y } => ProtoGeometry {
            rect: None,
            ellipse: Some(ProtoEllipse { radius_x: *radius_x, radius_y: *radius_y }),
            path: None, text: None,
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
            text: None,
        },
        Geometry::Text { content, font_size, ref font_family, text_align, line_height } => ProtoGeometry {
            rect: None, ellipse: None, path: None,
            text: Some(ProtoText {
                content: content.clone(),
                font_size: *font_size,
                font_family: font_family.clone(),
                text_align: *text_align as u32,
                line_height: *line_height,
            }),
        },
    }
}

fn proto_to_geometry(g: &ProtoGeometry) -> Geometry {
    if let Some(r) = &g.rect {
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
        transform: node.transform.to_vec(),
        style: Some((&node.style).into()),
        geometry: Some(geometry_to_proto(&node.geometry)),
        children: node.children.clone(),
        parent: node.parent,
        visible: node.visible,
        locked: node.locked,
    }
}

fn proto_to_node(pn: &ProtoNode) -> Node {
    let transform: [f32; 9] = if pn.transform.len() == 9 {
        let mut t = [0.0f32; 9];
        t.copy_from_slice(&pn.transform);
        t
    } else {
        [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    };

    Node {
        id: pn.id,
        name: pn.name.clone(),
        node_type: u32_to_node_type(pn.node_type),
        transform,
        style: pn.style.as_ref().map(|s| s.into()).unwrap_or_else(|| Style {
            fill: Some(Paint::Solid(Color { r: 0.5, g: 0.5, b: 0.5, a: 1.0 })),
            stroke: None,
            stroke_width: 1.0,
            opacity: 1.0,
            stroke_cap: 0,
            stroke_join: 0,
            dash_array: Vec::new(),
            dash_offset: 0.0,
            corner_radius: 0.0,
            blend_mode: 0,
            fill_rule: 0,
            miter_limit: 4.0,
            fill_opacity: 1.0,
        }),
        geometry: pn.geometry.as_ref().map(proto_to_geometry).unwrap_or(
            Geometry::Rect { width: 100.0, height: 100.0 }
        ),
        children: pn.children.clone(),
        parent: pn.parent,
        visible: pn.visible,
        locked: pn.locked,
    }
}

// ─── Document-Level Conversion ──────────────────────────────────────────────────

impl ProtoDocument {
    /// Convert the current scene to a ProtoDocument.
    pub fn from_scene(scene: &Scene, next_id: u32) -> Self {
        let nodes: Vec<ProtoNode> = scene.nodes.values().map(node_to_proto).collect();
        let root_ids = scene.root_nodes.clone();

        // Preserve face fills from vector network
        let face_fills: Vec<ProtoFaceFill> = scene.vector_network.faces.values()
            .filter(|f| f.fill.is_some() && !f.is_outer)
            .map(|f| {
                let fill = f.fill.as_ref().unwrap();
                let centroid = crate::vector_network::face_centroid(f);
                ProtoFaceFill {
                    centroid_x: centroid.x,
                    centroid_y: centroid.y,
                    fill: Some(fill.into()),
                }
            })
            .collect();

        ProtoDocument {
            format_version: FORMAT_VERSION,
            nodes,
            root_ids,
            next_id,
            face_fills,
            gap_tolerance: scene.vector_network.gap_tolerance,
            document_width: Some(scene.document_width),
            document_height: Some(scene.document_height),
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
        // Face fills will be re-mapped after the first network rebuild
        // Store them as pending via a field on VectorNetwork
        vn.pending_fills = self.face_fills.iter().filter_map(|ff| {
            ff.fill.as_ref().map(|c| {
                (Vec2::new(ff.centroid_x, ff.centroid_y), Color::from(c))
            })
        }).collect();

        let scene = Scene {
            nodes,
            root_nodes: self.root_ids.clone(),
            selection: Vec::new(),
            vector_network: vn,
            document_width: self.document_width.unwrap_or(1000.0),
            document_height: self.document_height.unwrap_or(1000.0),
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
    use std::collections::HashMap;

    fn make_style() -> ProtoStyle {
        ProtoStyle {
            fill: Some(ProtoColor { r: 1.0, g: 0.0, b: 0.0, a: 1.0 }),
            stroke: None,
            stroke_width: 2.0,
            opacity: Some(1.0),
            stroke_cap: 0,
            stroke_join: 0,
            dash_array: Vec::new(),
            dash_offset: 0.0,
            corner_radius: 0.0,
            blend_mode: 0,
            fill_rule: 0,
            miter_limit: Some(4.0),
            fill_opacity: Some(1.0),
            fill_gradient: None,
            stroke_gradient: None,
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
                transform: vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
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
                }),
                children: Vec::new(),
                parent: None,
                visible: true,
                locked: false,
            }],
            root_ids: vec![1],
            next_id: 2,
            face_fills: Vec::new(),
            gap_tolerance: 2.0,
            document_width: None,
            document_height: None,
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
        };
        doc.nodes.push(ProtoNode {
            id: 1,
            name: "Line".into(),
            node_type: 0,
            transform: vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
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
            }),
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
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
            transform: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 25.0, 30.0, 1.0],
            style: Style {
                fill: Some(Paint::Solid(Color { r: 0.2, g: 0.4, b: 0.6, a: 1.0 })),
                stroke: Some(Paint::Solid(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 })),
                stroke_width: 3.0,
                opacity: 0.5,
                stroke_cap: 1,
                stroke_join: 2,
                dash_array: vec![4.0, 2.0],
                dash_offset: 1.0,
                corner_radius: 0.0,
                blend_mode: 0,
                fill_rule: 1,
                miter_limit: 4.0,
                fill_opacity: 0.75,
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
        });

        let scene = Scene {
            nodes,
            root_nodes: vec![7],
            selection: Vec::new(),
            vector_network: VectorNetwork::default(),
            document_width: 800.0,
            document_height: 600.0,
        };

        let bytes = serialize_to_proto(&scene, 8);
        let (scene2, next_id) = deserialize_from_proto(&bytes).unwrap();
        assert_eq!(next_id, 8);
        assert_eq!(scene2.document_width, 800.0);
        assert_eq!(scene2.document_height, 600.0);

        let node = scene2.nodes.get(&7).unwrap();
        assert_eq!(node.style.opacity, 0.5);
        assert_eq!(node.style.fill_opacity, 0.75);
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
}
