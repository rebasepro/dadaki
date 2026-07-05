//! Protobuf serialization for .vec file format.
//!
//! Uses prost derive macros — no protoc or build.rs needed.
//! Provides conversion between internal serde types and proto types.

use prost::Message;
use base64::{Engine as B64Engine, engine::general_purpose::STANDARD as BASE64};
use glam::Vec2;

use crate::{
    Color, Geometry, Node, NodeType, PathPoint, Scene, Style,
    vector_network::VectorNetwork,
};

/// Current file format version. Bump when schema changes.
pub const FORMAT_VERSION: u32 = 1;

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
    #[prost(float, tag = "4")]
    pub opacity: f32,
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
    #[prost(float, tag = "12")]
    pub miter_limit: f32,
    #[prost(float, tag = "13")]
    pub fill_opacity: f32,
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
    #[prost(message, repeated, tag = "1")]
    pub points: Vec<ProtoPathPoint>,
}

#[derive(Clone, PartialEq, Message)]
pub struct ProtoText {
    #[prost(string, tag = "1")]
    pub content: String,
    #[prost(float, tag = "2")]
    pub font_size: f32,
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

impl From<&Style> for ProtoStyle {
    fn from(s: &Style) -> Self {
        ProtoStyle {
            fill: s.fill.as_ref().map(|c| c.into()),
            stroke: s.stroke.as_ref().map(|c| c.into()),
            stroke_width: s.stroke_width,
            opacity: s.opacity,
            stroke_cap: s.stroke_cap as u32,
            stroke_join: s.stroke_join as u32,
            dash_array: s.dash_array.clone(),
            dash_offset: s.dash_offset,
            corner_radius: s.corner_radius,
            blend_mode: s.blend_mode as u32,
            fill_rule: s.fill_rule as u32,
            miter_limit: s.miter_limit,
            fill_opacity: s.fill_opacity,
        }
    }
}

impl From<&ProtoStyle> for Style {
    fn from(s: &ProtoStyle) -> Self {
        Style {
            fill: s.fill.as_ref().map(|c| c.into()),
            stroke: s.stroke.as_ref().map(|c| c.into()),
            stroke_width: s.stroke_width,
            opacity: if s.opacity == 0.0 && s.fill.is_none() && s.stroke.is_none() {
                1.0 // default
            } else {
                s.opacity
            },
            stroke_cap: s.stroke_cap as u8,
            stroke_join: s.stroke_join as u8,
            dash_array: s.dash_array.clone(),
            dash_offset: s.dash_offset,
            corner_radius: s.corner_radius,
            blend_mode: s.blend_mode as u8,
            fill_rule: s.fill_rule as u8,
            miter_limit: if s.miter_limit == 0.0 { 4.0 } else { s.miter_limit },
            fill_opacity: if s.fill_opacity == 0.0 { 1.0 } else { s.fill_opacity },
        }
    }
}

impl From<&PathPoint> for ProtoPathPoint {
    fn from(p: &PathPoint) -> Self {
        ProtoPathPoint {
            x: p.x, y: p.y,
            cp1_x: p.cp1.x, cp1_y: p.cp1.y,
            cp2_x: p.cp2.x, cp2_y: p.cp2.y,
        }
    }
}

impl From<&ProtoPathPoint> for PathPoint {
    fn from(p: &ProtoPathPoint) -> Self {
        PathPoint {
            x: p.x, y: p.y,
            cp1: Vec2::new(p.cp1_x, p.cp1_y),
            cp2: Vec2::new(p.cp2_x, p.cp2_y),
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
        Geometry::Path { points } => ProtoGeometry {
            rect: None, ellipse: None,
            path: Some(ProtoPath {
                points: points.iter().map(|p| p.into()).collect(),
            }),
            text: None,
        },
        Geometry::Text { content, font_size } => ProtoGeometry {
            rect: None, ellipse: None, path: None,
            text: Some(ProtoText {
                content: content.clone(),
                font_size: *font_size,
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
        Geometry::Path {
            points: p.points.iter().map(|pp| pp.into()).collect(),
        }
    } else if let Some(t) = &g.text {
        Geometry::Text {
            content: t.content.clone(),
            font_size: t.font_size,
        }
    } else {
        Geometry::Rect { width: 100.0, height: 100.0 }
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
            fill: Some(Color { r: 0.5, g: 0.5, b: 0.5, a: 1.0 }),
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
    match doc.format_version {
        0 | 1 => { /* v1 is current, no migration needed */ }
        _ => {
            // Future: add migrations here as schema evolves
            // e.g., if v2 renames a field, transform it here
        }
    }
    doc.format_version = FORMAT_VERSION;
}
