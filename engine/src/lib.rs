use wasm_bindgen::prelude::*;
use glam::{Mat3, Vec2};
use serde::{Serialize, Deserialize};
use std::collections::{HashMap, HashSet};

mod vector_network;
pub use vector_network::{VectorNetwork, NodeVectorNetwork, NetworkVertex, NetworkEdge, NetworkRegion};

mod proto;
pub use proto::FORMAT_VERSION;
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);

    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

/// Log an error to the browser console (or stderr in native tests).
fn log_error(msg: &str) {
    #[cfg(target_arch = "wasm32")]
    console_error(msg);
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{}", msg);
}

#[wasm_bindgen]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum NodeType {
    Path,
    Rect,
    Ellipse,
    Group,
    Text,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Style {
    pub fill: Option<Color>,
    pub stroke: Option<Color>,
    pub stroke_width: f32,
    pub opacity: f32,
    pub stroke_cap: u8, // 0: butt, 1: round, 2: square
    pub stroke_join: u8, // 0: miter, 1: round, 2: bevel
    #[serde(default)]
    pub dash_array: Vec<f32>,
    #[serde(default)]
    pub dash_offset: f32,
    #[serde(default)]
    pub corner_radius: f32,
    #[serde(default)]
    pub blend_mode: u8, // 0: normal, 1: multiply, 2: screen, 3: overlay, 4: darken, 5: lighten,
                        // 6: color-dodge, 7: color-burn, 8: hard-light, 9: soft-light,
                        // 10: difference, 11: exclusion, 12: hue, 13: saturation, 14: color, 15: luminosity
    #[serde(default)]
    pub fill_rule: u8, // 0: nonzero (SVG default), 1: evenodd
    #[serde(default = "default_miter_limit")]
    pub miter_limit: f32, // SVG default is 4.0
    #[serde(default = "default_opacity")]
    pub fill_opacity: f32, // separate fill opacity, default 1.0
}

fn default_miter_limit() -> f32 { 4.0 }
fn default_opacity() -> f32 { 1.0 }

// ─── Precise Path Hit-Testing ───────────────────────────────────────────────────

/// World-space pick tolerance in document pixels (scaled to local space at use).
const HIT_TOLERANCE: f32 = 4.0;

/// Flatten a subpath's cubic segments into a polyline in local space.
/// Includes the closing curve when `closed`.
fn flatten_subpath(sp: &Subpath) -> Vec<Vec2> {
    let n = sp.points.len();
    let mut out = Vec::new();
    if n == 0 {
        return out;
    }
    out.push(Vec2::new(sp.points[0].x, sp.points[0].y));
    for i in 1..n {
        let a = &sp.points[i - 1];
        let b = &sp.points[i];
        vector_network::flatten_cubic(
            Vec2::new(a.x, a.y), a.cp2, b.cp1, Vec2::new(b.x, b.y), 0.25, &mut out,
        );
    }
    if sp.closed && n >= 2 {
        let a = &sp.points[n - 1];
        let b = &sp.points[0];
        vector_network::flatten_cubic(
            Vec2::new(a.x, a.y), a.cp2, b.cp1, Vec2::new(b.x, b.y), 0.25, &mut out,
        );
    }
    out
}

/// Containment test across all subpaths (ray cast toward +x).
/// Open subpaths are implicitly closed for filling, matching SVG semantics.
fn point_in_path_fill(subpaths: &[Subpath], p: Vec2, even_odd: bool) -> bool {
    let mut winding: i32 = 0;
    let mut crossings: u32 = 0;
    for sp in subpaths {
        let poly = flatten_subpath(sp);
        let n = poly.len();
        if n < 3 {
            continue;
        }
        for i in 0..n {
            let a = poly[i];
            let b = poly[(i + 1) % n]; // wrap = implicit close for fill
            if (a.y <= p.y) != (b.y <= p.y) {
                let t = (p.y - a.y) / (b.y - a.y);
                let x = a.x + t * (b.x - a.x);
                if x > p.x {
                    crossings += 1;
                    if b.y > a.y { winding += 1 } else { winding -= 1 }
                }
            }
        }
    }
    if even_odd { crossings % 2 == 1 } else { winding != 0 }
}

/// Squared distance from a point to a polyline (optionally closed).
fn dist_sq_to_polyline(poly: &[Vec2], p: Vec2, closed: bool) -> f32 {
    let n = poly.len();
    if n == 0 {
        return f32::MAX;
    }
    if n == 1 {
        return (poly[0] - p).length_squared();
    }
    let mut best = f32::MAX;
    let seg_count = if closed { n } else { n - 1 };
    for i in 0..seg_count {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let ab = b - a;
        let len_sq = ab.length_squared();
        let t = if len_sq > 1e-12 {
            ((p - a).dot(ab) / len_sq).clamp(0.0, 1.0)
        } else {
            0.0
        };
        best = best.min((a + ab * t - p).length_squared());
    }
    best
}

/// Hit test a path node in local space: stroke outline first (within
/// stroke_width/2 + tolerance), then fill containment if the path is filled.
fn path_hit(subpaths: &[Subpath], style: &Style, p: Vec2, tol: f32) -> bool {
    let stroke_reach = if style.stroke.is_some() {
        style.stroke_width * 0.5 + tol
    } else {
        tol
    };
    let reach_sq = stroke_reach * stroke_reach;
    for sp in subpaths {
        let poly = flatten_subpath(sp);
        if poly.len() >= 2 && dist_sq_to_polyline(&poly, p, sp.closed) <= reach_sq {
            return true;
        }
    }
    if style.fill.is_some() {
        return point_in_path_fill(subpaths, p, style.fill_rule == 1);
    }
    false
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum Geometry {
    Rect { width: f32, height: f32 },
    Ellipse { radius_x: f32, radius_y: f32 },
    Path {
        subpaths: Vec<Subpath>,
        /// Per-node vector network (graph-based editing source of truth).
        /// When present, editing goes through the network, which recomputes subpaths.
        /// NOTE: no `skip_serializing_if` here — bincode is positional, so
        /// conditionally skipped fields corrupt history/drag snapshots.
        #[serde(default)]
        network: Option<NodeVectorNetwork>,
    },
    Text { content: String, font_size: f32 },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PathPoint {
    pub x: f32,
    pub y: f32,
    pub cp1: Vec2,
    pub cp2: Vec2,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Subpath {
    pub points: Vec<PathPoint>,
    pub closed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Node {
    pub id: u32,
    pub name: String,
    pub node_type: NodeType,
    pub transform: [f32; 9], // Mat3 as flat array
    pub style: Style,
    pub geometry: Geometry,
    pub children: Vec<u32>,
    pub parent: Option<u32>,
    pub visible: bool,
    pub locked: bool,
}

use rstar::{RTree, RTreeObject, AABB, PointDistance};

#[wasm_bindgen]
pub struct Engine {
    scene: Scene,
    next_id: u32,
    /// Global transforms stored in glam column-major format.
    /// Converted to Skia row-major only at the JS boundary.
    global_transforms: HashMap<u32, [f32; 9]>,
    /// Temporary buffer for returning row-major transform to JS.
    transform_out_buf: [f32; 9],
    spatial_index: RTree<SpatialNode>,
    node_to_spatial: HashMap<u32, SpatialNode>,
    dirty_flags: HashMap<u32, bool>,
    render_buffer: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
struct SpatialNode {
    id: u32,
    aabb: AABB<[f32; 2]>,
}

impl RTreeObject for SpatialNode {
    type Envelope = AABB<[f32; 2]>;
    fn envelope(&self) -> Self::Envelope {
        self.aabb
    }
}

impl PointDistance for SpatialNode {
    fn distance_2(&self, point: &[f32; 2]) -> f32 {
        self.aabb.distance_2(point)
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Scene {
    pub nodes: HashMap<u32, Node>,
    pub root_nodes: Vec<u32>,
    pub selection: Vec<u32>,
    #[serde(default)]
    pub vector_network: VectorNetwork,
    #[serde(default = "default_document_size")]
    pub document_width: f32,
    #[serde(default = "default_document_size")]
    pub document_height: f32,
}

fn default_document_size() -> f32 { 1000.0 }

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console_error_panic_hook::set_once();
        Self {
            scene: Scene {
                nodes: HashMap::new(),
                root_nodes: Vec::new(),
                selection: Vec::new(),
                vector_network: VectorNetwork::default(),
                document_width: 1000.0,
                document_height: 1000.0,
            },
            next_id: 1,
            global_transforms: HashMap::new(),
            transform_out_buf: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            spatial_index: RTree::new(),
            node_to_spatial: HashMap::new(),
            dirty_flags: HashMap::new(),
            render_buffer: Vec::new(),
        }
    }

    pub fn get_render_buffer(&self) -> *const u8 {
        self.render_buffer.as_ptr()
    }

    pub fn get_render_buffer_size(&self) -> usize {
        self.render_buffer.len()
    }

    pub fn update_render_buffer(&mut self, visible_ids: Vec<u32>) {
        self.render_buffer.clear();
        let visible_set: HashSet<u32> = visible_ids.into_iter().collect();
        
        let mut total_nodes = 0;
        // Skip first 4 bytes, we'll write total_nodes there at the end
        self.render_buffer.extend_from_slice(&[0u8; 4]);

        let root_nodes = self.scene.root_nodes.clone();
        for root_id in root_nodes {
            self.write_node_recursive(root_id, &visible_set, &mut total_nodes);
        }

        // Fill in the total node count (number of "commands")
        let count_bytes = (total_nodes as u32).to_le_bytes();
        self.render_buffer[0..4].copy_from_slice(&count_bytes);
    }

    fn write_node_recursive(
        &mut self,
        id: u32,
        visible_set: &HashSet<u32>,
        total_nodes: &mut u32
    ) {
        // Every command must start 4-byte aligned so the JS reader can take
        // zero-copy Float32Array views over the buffer.
        debug_assert_eq!(self.render_buffer.len() % 4, 0, "render buffer misaligned before command");

        let node = match self.scene.nodes.get(&id) {
            Some(n) => n,
            None => return,
        };

        if !node.visible { return; }

        if node.node_type == NodeType::Group {
            // Check if any descendant is visible (optimization: use R-tree indirectly via visible_set)
            // Groups aren't in R-tree themselves, but their children are.
            // If none of the descendants are in visible_set, we can skip.
            // For now, let's be safe and always process groups if they are visible.
            
            // CMD_START_GROUP = 1
            self.render_buffer.extend_from_slice(&1u32.to_le_bytes());
            self.render_buffer.extend_from_slice(&id.to_le_bytes());
            self.render_buffer.extend_from_slice(&node.style.opacity.to_le_bytes());
            *total_nodes += 1;

            let children = node.children.clone();
            for child_id in children {
                self.write_node_recursive(child_id, visible_set, total_nodes);
            }

            // CMD_END_GROUP = 3
            self.render_buffer.extend_from_slice(&3u32.to_le_bytes());
            self.render_buffer.extend_from_slice(&id.to_le_bytes());
            *total_nodes += 1;
        } else {
            // Only draw leaf if it's in the visible set
            if !visible_set.contains(&id) { return; }

            // CMD_DRAW_NODE = 2
            self.render_buffer.extend_from_slice(&2u32.to_le_bytes());
            self.render_buffer.extend_from_slice(&id.to_le_bytes());
            
            // NodeType: Path=0, Rect=1, Ellipse=2, Text=4
            let type_u8 = match node.node_type {
                NodeType::Path => 0u8,
                NodeType::Rect => 1u8,
                NodeType::Ellipse => 2u8,
                NodeType::Group => 3u8, // should not happen here
                NodeType::Text => 4u8,
            };
            self.render_buffer.extend_from_slice(&(type_u8 as u32).to_le_bytes());

            // Global Transform (9 x f32) - Transpose to row-major for Skia
            let m = self.global_transforms.get(&id).cloned().unwrap_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
            let row_major = [
                m[0], m[3], m[6], // Row 0: scaleX, skewX, transX
                m[1], m[4], m[7], // Row 1: skewY, scaleY, transY  
                m[2], m[5], m[8], // Row 2: pers0, pers1, pers2
            ];
            for f in row_major {
                self.render_buffer.extend_from_slice(&f.to_le_bytes());
            }

            // Style: Fill (4xf32), Stroke (4xf32), StrokeWidth, CornerRadius,
            // Dash (on, off, phase) — 13 x f32 total
            let s = &node.style;
            let f = s.fill.clone().unwrap_or(Color { r: 0.0, g: 0.0, b: 0.0, a: 0.0 });
            self.render_buffer.extend_from_slice(&f.r.to_le_bytes());
            self.render_buffer.extend_from_slice(&f.g.to_le_bytes());
            self.render_buffer.extend_from_slice(&f.b.to_le_bytes());
            self.render_buffer.extend_from_slice(&f.a.to_le_bytes());

            let st = s.stroke.clone().unwrap_or(Color { r: 0.0, g: 0.0, b: 0.0, a: 0.0 });
            self.render_buffer.extend_from_slice(&st.r.to_le_bytes());
            self.render_buffer.extend_from_slice(&st.g.to_le_bytes());
            self.render_buffer.extend_from_slice(&st.b.to_le_bytes());
            self.render_buffer.extend_from_slice(&st.a.to_le_bytes());

            self.render_buffer.extend_from_slice(&s.stroke_width.to_le_bytes());
            self.render_buffer.extend_from_slice(&s.corner_radius.to_le_bytes());
            let dash_on = s.dash_array.first().copied().unwrap_or(0.0);
            let dash_off = s.dash_array.get(1).copied().unwrap_or(dash_on);
            self.render_buffer.extend_from_slice(&dash_on.to_le_bytes());
            self.render_buffer.extend_from_slice(&dash_off.to_le_bytes());
            self.render_buffer.extend_from_slice(&s.dash_offset.to_le_bytes());

            // Geometry
            match &node.geometry {
                Geometry::Rect { width, height } => {
                    self.render_buffer.extend_from_slice(&8u32.to_le_bytes()); // Size: 2 * f32
                    self.render_buffer.extend_from_slice(&width.to_le_bytes());
                    self.render_buffer.extend_from_slice(&height.to_le_bytes());
                }
                Geometry::Ellipse { radius_x, radius_y } => {
                    self.render_buffer.extend_from_slice(&8u32.to_le_bytes()); // Size: 2 * f32
                    self.render_buffer.extend_from_slice(&radius_x.to_le_bytes());
                    self.render_buffer.extend_from_slice(&radius_y.to_le_bytes());
                }
                Geometry::Path { subpaths, .. } => {
                    // Pre-calculate size or write a placeholder. 
                    // Let's use a placeholder for Path size.
                    let size_offset = self.render_buffer.len();
                    self.render_buffer.extend_from_slice(&[0u8; 4]);
                    let start_len = self.render_buffer.len();

                    self.render_buffer.extend_from_slice(&(subpaths.len() as u32).to_le_bytes());
                    for sp in subpaths {
                        self.render_buffer.extend_from_slice(&(if sp.closed { 1u32 } else { 0u32 }).to_le_bytes());
                        self.render_buffer.extend_from_slice(&(sp.points.len() as u32).to_le_bytes());
                        for pt in &sp.points {
                            self.render_buffer.extend_from_slice(&pt.x.to_le_bytes());
                            self.render_buffer.extend_from_slice(&pt.y.to_le_bytes());
                            self.render_buffer.extend_from_slice(&pt.cp1.x.to_le_bytes());
                            self.render_buffer.extend_from_slice(&pt.cp1.y.to_le_bytes());
                            self.render_buffer.extend_from_slice(&pt.cp2.x.to_le_bytes());
                            self.render_buffer.extend_from_slice(&pt.cp2.y.to_le_bytes());
                        }
                    }

                    let end_len = self.render_buffer.len();
                    let total_size = (end_len - start_len) as u32;
                    self.render_buffer[size_offset..size_offset+4].copy_from_slice(&total_size.to_le_bytes());
                }
                Geometry::Text { content, font_size } => {
                    let bytes = content.as_bytes();
                    // Pad the UTF-8 payload so the next command stays 4-byte aligned
                    let padding = (4 - (bytes.len() % 4)) % 4;
                    let total_size = 4 + 4 + bytes.len() as u32 + padding as u32; // font_size + len_prefix + bytes + padding
                    self.render_buffer.extend_from_slice(&total_size.to_le_bytes());

                    self.render_buffer.extend_from_slice(&font_size.to_le_bytes());
                    self.render_buffer.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                    self.render_buffer.extend_from_slice(bytes);
                    let padded_len = self.render_buffer.len() + padding;
                    self.render_buffer.resize(padded_len, 0);
                }
            }
            *total_nodes += 1;
        }
    }

    pub fn is_node_dirty(&self, id: u32) -> bool {
        *self.dirty_flags.get(&id).unwrap_or(&true)
    }

    pub fn clear_node_dirty(&mut self, id: u32) {
        self.dirty_flags.insert(id, false);
    }

    fn mark_dirty(&mut self, id: u32) {
        self.dirty_flags.insert(id, true);
        // Invalidate vector network so faces recompute on next query
        self.scene.vector_network.dirty = true;
    }

    pub fn add_rect(&mut self, x: f32, y: f32, w: f32, h: f32) -> u32 {
        let id = self.next_id;
        self.next_id += 1;

        let node = Node {
            id,
            name: format!("Rect {}", id),
            node_type: NodeType::Rect,
            transform: Mat3::from_translation(Vec2::new(x, y)).to_cols_array(),
            style: Style {
                fill: Some(Color { r: 0.5, g: 0.5, b: 1.0, a: 1.0 }),
                stroke: Some(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
                stroke_width: 2.0,
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
            },
            geometry: Geometry::Rect { width: w, height: h },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
        };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        self.update_spatial_index(id);
        self.mark_dirty(id);
        id
    }

    pub fn add_ellipse(&mut self, cx: f32, cy: f32, rx: f32, ry: f32) -> u32 {
        let id = self.next_id;
        self.next_id += 1;

        let node = Node {
            id,
            name: format!("Ellipse {}", id),
            node_type: NodeType::Ellipse,
            transform: Mat3::from_translation(Vec2::new(cx, cy)).to_cols_array(),
            style: Style {
                fill: Some(Color { r: 0.5, g: 0.5, b: 1.0, a: 1.0 }),
                stroke: Some(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
                stroke_width: 2.0,
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
            },
            geometry: Geometry::Ellipse { radius_x: rx, radius_y: ry },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
        };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        self.update_spatial_index(id);
        self.mark_dirty(id);
        id
    }

    pub fn add_path(&mut self, points_json: &str) -> u32 {
        let subpaths: Vec<Subpath> = serde_json::from_str(points_json).unwrap_or_default();
        let id = self.next_id;
        self.next_id += 1;

        // Compute bbox center of all points for local-space normalization
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;
        for sp in &subpaths {
            for pt in &sp.points {
                min_x = min_x.min(pt.x);
                min_y = min_y.min(pt.y);
                max_x = max_x.max(pt.x);
                max_y = max_y.max(pt.y);
            }
        }
        let (center_x, center_y) = if min_x <= max_x && min_y <= max_y {
            ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0)
        } else {
            (0.0, 0.0)
        };

        // Subtract center from all points to make geometry local-space
        let subpaths: Vec<Subpath> = subpaths.into_iter().map(|sp| Subpath {
            points: sp.points.into_iter().map(|mut pt| {
                pt.x -= center_x;
                pt.y -= center_y;
                pt.cp1 -= Vec2::new(center_x, center_y);
                pt.cp2 -= Vec2::new(center_x, center_y);
                pt
            }).collect(),
            closed: sp.closed,
        }).collect();

        let node = Node {
            id,
            name: format!("Path {}", id),
            node_type: NodeType::Path,
            transform: Mat3::from_translation(Vec2::new(center_x, center_y)).to_cols_array(),
            style: Style {
                fill: Some(Color { r: 0.5, g: 0.5, b: 1.0, a: 1.0 }),
                stroke: Some(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
                stroke_width: 2.0,
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
            },
            geometry: Geometry::Path {
                network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                subpaths,
            },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
        };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        self.update_spatial_index(id);
        self.mark_dirty(id);
        id
    }

    pub fn add_polygon(&mut self, cx: f32, cy: f32, radius: f32, sides: u32) -> u32 {
        let sides = sides.max(3);
        let step = std::f32::consts::TAU / sides as f32;
        let mut points = Vec::new();
        for i in 0..sides {
            let angle = i as f32 * step - std::f32::consts::FRAC_PI_2;
            let px = radius * angle.cos();
            let py = radius * angle.sin();
            points.push(PathPoint {
                x: px,
                y: py,
                cp1: Vec2::new(px, py),
                cp2: Vec2::new(px, py),
            });
        }

        let subpaths = vec![Subpath { points, closed: true }];

        let id = self.next_id;
        self.next_id += 1;

        let node = Node {
            id,
            name: format!("Polygon {}", id),
            node_type: NodeType::Path,
            transform: Mat3::from_translation(Vec2::new(cx, cy)).to_cols_array(),
            style: Style {
                fill: Some(Color { r: 0.5, g: 0.8, b: 0.5, a: 1.0 }),
                stroke: Some(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
                stroke_width: 2.0,
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
            },
            geometry: Geometry::Path {
                network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                subpaths,
            },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
        };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        self.update_spatial_index(id);
        self.mark_dirty(id);
        id
    }

    pub fn add_star(&mut self, cx: f32, cy: f32, outer_r: f32, inner_r: f32, num_points: u32) -> u32 {
        let num_points = num_points.max(3);
        let step = std::f32::consts::PI / num_points as f32;
        let mut points = Vec::new();
        let total_verts = num_points * 2;
        for i in 0..total_verts {
            let r = if i % 2 == 0 { outer_r } else { inner_r };
            let angle = i as f32 * step - std::f32::consts::FRAC_PI_2;
            let px = r * angle.cos();
            let py = r * angle.sin();
            points.push(PathPoint {
                x: px,
                y: py,
                cp1: Vec2::new(px, py),
                cp2: Vec2::new(px, py),
            });
        }

        let subpaths = vec![Subpath { points, closed: true }];

        let id = self.next_id;
        self.next_id += 1;

        let node = Node {
            id,
            name: format!("Star {}", id),
            node_type: NodeType::Path,
            transform: Mat3::from_translation(Vec2::new(cx, cy)).to_cols_array(),
            style: Style {
                fill: Some(Color { r: 1.0, g: 0.8, b: 0.2, a: 1.0 }),
                stroke: Some(Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
                stroke_width: 2.0,
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
            },
            geometry: Geometry::Path {
                network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                subpaths,
            },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
        };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        self.update_spatial_index(id);
        self.mark_dirty(id);
        id
    }

    pub fn update_path_points(&mut self, id: u32, subpaths_json: &str) {
        let subpaths: Vec<Subpath> = serde_json::from_str(subpaths_json).unwrap_or_default();
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.geometry = Geometry::Path {
                network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                subpaths,
            };
            self.update_spatial_index(id);
            self.mark_dirty(id);
        }
    }

    pub fn set_node_style(&mut self, id: u32, style_json: &str) {
        if let Ok(style) = serde_json::from_str::<Style>(style_json) {
            if let Some(node) = self.scene.nodes.get_mut(&id) {
                node.style = style;
                self.mark_dirty(id);
            }
        }
    }

    pub fn set_node_visible(&mut self, id: u32, visible: bool) {
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.visible = visible;
            self.mark_dirty(id);
        }
    }

    pub fn set_node_locked(&mut self, id: u32, locked: bool) {
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.locked = locked;
        }
    }

    fn update_spatial_index(&mut self, id: u32) {
        if let Some(old_node) = self.node_to_spatial.remove(&id) {
            self.spatial_index.remove(&old_node);
        }

        let is_group = self.scene.nodes.get(&id)
            .map(|n| matches!(n.node_type, NodeType::Group))
            .unwrap_or(false);

        if is_group {
            // Group AABB = union of all descendant AABBs
            let children = self.scene.nodes.get(&id)
                .map(|n| n.children.clone())
                .unwrap_or_default();
            if children.is_empty() {
                // Empty group — use a point AABB at the group's position
                if let Some(transform_bytes) = self.global_transforms.get(&id) {
                    let transform = Mat3::from_cols_array(transform_bytes);
                    let p = transform.transform_point2(Vec2::ZERO);
                    let aabb = AABB::from_corners([p.x, p.y], [p.x, p.y]);
                    let spatial_node = SpatialNode { id, aabb };
                    self.spatial_index.insert(spatial_node);
                    self.node_to_spatial.insert(id, spatial_node);
                }
                return;
            }
            let mut min_x = f32::MAX;
            let mut min_y = f32::MAX;
            let mut max_x = f32::MIN;
            let mut max_y = f32::MIN;
            self.collect_descendant_bounds(id, &mut min_x, &mut min_y, &mut max_x, &mut max_y);
            if min_x <= max_x && min_y <= max_y {
                let aabb = AABB::from_corners([min_x, min_y], [max_x, max_y]);
                let spatial_node = SpatialNode { id, aabb };
                self.spatial_index.insert(spatial_node);
                self.node_to_spatial.insert(id, spatial_node);
            }
            return;
        }

        if let (Some(node), Some(transform_bytes)) = (self.scene.nodes.get(&id), self.global_transforms.get(&id)) {
            let transform = Mat3::from_cols_array(transform_bytes);
            let aabb = match node.geometry {
                Geometry::Rect { width, height } => {
                    let p1 = transform.transform_point2(Vec2::new(0.0, 0.0));
                    let p2 = transform.transform_point2(Vec2::new(width, 0.0));
                    let p3 = transform.transform_point2(Vec2::new(0.0, height));
                    let p4 = transform.transform_point2(Vec2::new(width, height));
                    
                    let min_x = p1.x.min(p2.x).min(p3.x).min(p4.x);
                    let min_y = p1.y.min(p2.y).min(p3.y).min(p4.y);
                    let max_x = p1.x.max(p2.x).max(p3.x).max(p4.x);
                    let max_y = p1.y.max(p2.y).max(p3.y).max(p4.y);
                    
                    AABB::from_corners([min_x, min_y], [max_x, max_y])
                }
                Geometry::Ellipse { radius_x, radius_y } => {
                    let p = transform.transform_point2(Vec2::ZERO);
                    AABB::from_corners([p.x - radius_x, p.y - radius_y], [p.x + radius_x, p.y + radius_y])
                }
                Geometry::Path { ref subpaths, .. } => {
                    let mut min_x = f32::MAX;
                    let mut min_y = f32::MAX;
                    let mut max_x = f32::MIN;
                    let mut max_y = f32::MIN;
                    let mut has_points = false;
                    // Flatten each subpath into line segments so bounds
                    // reflect the actual curve, not the control polygon.
                    for sp in subpaths {
                        let flattened = flatten_subpath(sp);
                        for lp in &flattened {
                            has_points = true;
                            let p = transform.transform_point2(*lp);
                            min_x = min_x.min(p.x);
                            min_y = min_y.min(p.y);
                            max_x = max_x.max(p.x);
                            max_y = max_y.max(p.y);
                        }
                    }
                    if !has_points {
                        AABB::from_corners([0.0, 0.0], [0.0, 0.0])
                    } else {
                        AABB::from_corners([min_x, min_y], [max_x, max_y])
                    }
                }
                Geometry::Text { ref content, font_size } => {
                    let p = transform.transform_point2(Vec2::ZERO);
                    let approx_w = content.len() as f32 * font_size * 0.6;
                    AABB::from_corners([p.x, p.y - font_size], [p.x + approx_w, p.y])
                }
            };
            
            let spatial_node = SpatialNode { id, aabb };
            self.spatial_index.insert(spatial_node);
            self.node_to_spatial.insert(id, spatial_node);
        }
    }

    /// Recursively collect AABB bounds of all descendants of a node.
    fn collect_descendant_bounds(&self, id: u32, min_x: &mut f32, min_y: &mut f32, max_x: &mut f32, max_y: &mut f32) {
        if let Some(node) = self.scene.nodes.get(&id) {
            for &child_id in &node.children {
                let is_child_group = self.scene.nodes.get(&child_id)
                    .map(|n| matches!(n.node_type, NodeType::Group))
                    .unwrap_or(false);
                if is_child_group {
                    // Recurse into child groups
                    self.collect_descendant_bounds(child_id, min_x, min_y, max_x, max_y);
                } else if let Some(spatial) = self.node_to_spatial.get(&child_id) {
                    let lower = spatial.aabb.lower();
                    let upper = spatial.aabb.upper();
                    *min_x = min_x.min(lower[0]);
                    *min_y = min_y.min(lower[1]);
                    *max_x = max_x.max(upper[0]);
                    *max_y = max_y.max(upper[1]);
                }
            }
        }
    }

    pub fn update_all_spatial_indices(&mut self) {
        self.spatial_index = RTree::new();
        self.node_to_spatial.clear();
        // Process nodes bottom-up (leaves before groups) so that group bounds
        // can read child entries from node_to_spatial.
        let root_ids: Vec<u32> = self.scene.root_nodes.clone();
        for id in root_ids {
            self.update_spatial_index_bottom_up(id);
        }
    }

    /// Recursively update spatial indices bottom-up: children first, then parent.
    fn update_spatial_index_bottom_up(&mut self, id: u32) {
        let children: Vec<u32> = self.scene.nodes.get(&id)
            .map(|n| n.children.clone())
            .unwrap_or_default();
        for child_id in children {
            self.update_spatial_index_bottom_up(child_id);
        }
        self.update_spatial_index(id);
    }

    pub fn set_node_name(&mut self, id: u32, name: &str) {
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.name = name.to_string();
        }
    }

    pub fn remove_node(&mut self, id: u32) {
        if let Some(node) = self.scene.nodes.remove(&id) {
            if let Some(parent_id) = node.parent {
                if let Some(parent) = self.scene.nodes.get_mut(&parent_id) {
                    parent.children.retain(|&c| c != id);
                }
            } else {
                self.scene.root_nodes.retain(|&r| r != id);
            }

            self.scene.selection.retain(|&s| s != id);
            self.global_transforms.remove(&id);
            self.dirty_flags.remove(&id);
            if let Some(old_node) = self.node_to_spatial.remove(&id) {
                self.spatial_index.remove(&old_node);
            }

            let children = node.children.clone();
            for child_id in children {
                self.remove_node(child_id);
            }
        }
    }

    /// Restore a scene from a bincode snapshot (history/undo/drag-restore).
    /// Returns false — and leaves the scene untouched — if the bytes don't
    /// decode. A silent failure here breaks undo invisibly, so callers should
    /// surface it.
    pub fn deserialize_scene(&mut self, data: &[u8]) -> bool {
        match bincode::deserialize::<Scene>(data) {
            Ok(scene) => {
                self.scene = scene;
                self.next_id = self.scene.nodes.keys().max().map(|id| id + 1).unwrap_or(1);
                self.update_all_global_transforms();
                self.update_all_spatial_indices();
                true
            }
            Err(e) => {
                log_error(&format!("deserialize_scene failed: {}", e));
                false
            }
        }
    }

    pub fn set_parent(&mut self, child_id: u32, parent_id: Option<u32>) -> bool {
        // Validate both nodes exist
        if !self.scene.nodes.contains_key(&child_id) {
            return false;
        }
        if let Some(pid) = parent_id {
            if !self.scene.nodes.contains_key(&pid) {
                return false;
            }
            // Prevent cycles
            if self.is_ancestor(child_id, pid) {
                return false;
            }
        }

        // Remove from old parent
        let old_parent = self.scene.nodes.get(&child_id).and_then(|n| n.parent);
        if let Some(old_pid) = old_parent {
            if let Some(old_p) = self.scene.nodes.get_mut(&old_pid) {
                old_p.children.retain(|&c| c != child_id);
            }
        } else {
            self.scene.root_nodes.retain(|&r| r != child_id);
        }

        // Set new parent
        if let Some(node) = self.scene.nodes.get_mut(&child_id) {
            node.parent = parent_id;
        }

        if let Some(pid) = parent_id {
            if let Some(p) = self.scene.nodes.get_mut(&pid) {
                p.children.push(child_id);
            }
        } else {
            self.scene.root_nodes.push(child_id);
        }

        self.update_node_global_transform(child_id);
        self.update_spatial_index_recursive(child_id);
        true
    }

    fn is_ancestor(&self, ancestor_id: u32, node_id: u32) -> bool {
        if ancestor_id == node_id { return true; }
        let mut current = node_id;
        while let Some(node) = self.scene.nodes.get(&current) {
            if let Some(parent_id) = node.parent {
                if parent_id == ancestor_id { return true; }
                current = parent_id;
            } else {
                break;
            }
        }
        false
    }

    pub fn update_all_global_transforms(&mut self) {
        let mut transforms = HashMap::new();
        for &id in &self.scene.root_nodes {
            Self::compute_global_transform_recursive(&self.scene.nodes, id, Mat3::IDENTITY, &mut transforms);
        }
        self.global_transforms = transforms;
    }

    fn update_node_global_transform(&mut self, id: u32) {
        let parent_transform = if let Some(node) = self.scene.nodes.get(&id) {
            if let Some(pid) = node.parent {
                self.global_transforms.get(&pid)
                    .map(|&m| Mat3::from_cols_array(&m))
                    .unwrap_or(Mat3::IDENTITY)
            } else {
                Mat3::IDENTITY
            }
        } else {
            return;
        };

        Self::compute_global_transform_recursive(&self.scene.nodes, id, parent_transform, &mut self.global_transforms);
    }

    fn compute_global_transform_recursive(nodes: &HashMap<u32, Node>, id: u32, parent_transform: Mat3, transforms: &mut HashMap<u32, [f32; 9]>) {
        if let Some(node) = nodes.get(&id) {
            let local_transform = Mat3::from_cols_array(&node.transform);
            let global_transform = parent_transform * local_transform;
            // Store in glam's native column-major format
            transforms.insert(id, global_transform.to_cols_array());

            for &child_id in &node.children {
                Self::compute_global_transform_recursive(nodes, child_id, global_transform, transforms);
            }
        }
    }

    fn update_spatial_index_recursive(&mut self, id: u32) {
        // First, recurse into children (bottom-up: children before parent)
        let children = if let Some(node) = self.scene.nodes.get(&id) {
            node.children.clone()
        } else {
            return;
        };
        for child_id in children {
            self.update_spatial_index_recursive(child_id);
        }
        // Then update this node (for groups, this unions the now-updated child AABBs)
        self.update_spatial_index(id);
    }

    /// Walk up the parent chain and re-update spatial index for each Group ancestor.
    fn update_ancestor_group_bounds(&mut self, id: u32) {
        let mut current = id;
        while let Some(parent_id) = self.scene.nodes.get(&current).and_then(|n| n.parent) {
            let is_group = self.scene.nodes.get(&parent_id)
                .map(|n| matches!(n.node_type, NodeType::Group))
                .unwrap_or(false);
            if is_group {
                self.update_spatial_index(parent_id);
            }
            current = parent_id;
        }
    }

    pub fn move_node(&mut self, id: u32, dx: f32, dy: f32) {
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            let mut transform = Mat3::from_cols_array(&node.transform);
            transform.z_axis.x += dx;
            transform.z_axis.y += dy;
            node.transform = transform.to_cols_array();
            self.update_node_global_transform(id);
            self.update_spatial_index_recursive(id);
            self.update_ancestor_group_bounds(id);
            self.mark_dirty(id);
        }
    }

    pub fn bring_to_front(&mut self, id: u32) {
        let parent_id = self.scene.nodes.get(&id).and_then(|n| n.parent);
        if let Some(pid) = parent_id {
            if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                if let Some(pos) = parent.children.iter().position(|&x| x == id) {
                    parent.children.remove(pos);
                    parent.children.push(id);
                }
            }
        } else {
            if let Some(pos) = self.scene.root_nodes.iter().position(|&x| x == id) {
                self.scene.root_nodes.remove(pos);
                self.scene.root_nodes.push(id);
            }
        }
    }

    pub fn send_to_back(&mut self, id: u32) {
        let parent_id = self.scene.nodes.get(&id).and_then(|n| n.parent);
        if let Some(pid) = parent_id {
            if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                if let Some(pos) = parent.children.iter().position(|&x| x == id) {
                    parent.children.remove(pos);
                    parent.children.insert(0, id);
                }
            }
        } else {
            if let Some(pos) = self.scene.root_nodes.iter().position(|&x| x == id) {
                self.scene.root_nodes.remove(pos);
                self.scene.root_nodes.insert(0, id);
            }
        }
    }

    pub fn bring_forward(&mut self, id: u32) {
        let parent_id = self.scene.nodes.get(&id).and_then(|n| n.parent);
        if let Some(pid) = parent_id {
            if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                if let Some(pos) = parent.children.iter().position(|&x| x == id) {
                    if pos + 1 < parent.children.len() {
                        parent.children.swap(pos, pos + 1);
                    }
                }
            }
        } else {
            if let Some(pos) = self.scene.root_nodes.iter().position(|&x| x == id) {
                if pos + 1 < self.scene.root_nodes.len() {
                    self.scene.root_nodes.swap(pos, pos + 1);
                }
            }
        }
    }

    pub fn send_backward(&mut self, id: u32) {
        let parent_id = self.scene.nodes.get(&id).and_then(|n| n.parent);
        if let Some(pid) = parent_id {
            if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                if let Some(pos) = parent.children.iter().position(|&x| x == id) {
                    if pos > 0 {
                        parent.children.swap(pos, pos - 1);
                    }
                }
            }
        } else {
            if let Some(pos) = self.scene.root_nodes.iter().position(|&x| x == id) {
                if pos > 0 {
                    self.scene.root_nodes.swap(pos, pos - 1);
                }
            }
        }
    }

    pub fn get_scene_json(&self) -> String {
        serde_json::to_string(&self.scene).unwrap_or_default()
    }

    // ─── Per-Node Getters (avoid full-scene JSON serialization) ─────────

    /// Get a single node's full data as JSON. Used by UI panels.
    pub fn get_node_json(&self, id: u32) -> String {
        self.scene.nodes.get(&id)
            .map(|n| serde_json::to_string(n).unwrap_or_default())
            .unwrap_or_default()
    }

    /// Get a node's style as JSON.
    pub fn get_node_style_json(&self, id: u32) -> String {
        self.scene.nodes.get(&id)
            .map(|n| serde_json::to_string(&n.style).unwrap_or_default())
            .unwrap_or_default()
    }

    /// Get a node's geometry as JSON.
    pub fn get_node_geometry_json(&self, id: u32) -> String {
        self.scene.nodes.get(&id)
            .map(|n| serde_json::to_string(&n.geometry).unwrap_or_default())
            .unwrap_or_default()
    }

    /// Get a node's name.
    pub fn get_node_name(&self, id: u32) -> String {
        self.scene.nodes.get(&id)
            .map(|n| n.name.clone())
            .unwrap_or_default()
    }

    /// Get a node's visible flag.
    pub fn get_node_visible(&self, id: u32) -> bool {
        self.scene.nodes.get(&id).map(|n| n.visible).unwrap_or(false)
    }

    /// Get a node's locked flag.
    pub fn get_node_locked(&self, id: u32) -> bool {
        self.scene.nodes.get(&id).map(|n| n.locked).unwrap_or(false)
    }

    /// Get a node's children IDs.
    pub fn get_node_children(&self, id: u32) -> Vec<u32> {
        self.scene.nodes.get(&id)
            .map(|n| n.children.clone())
            .unwrap_or_default()
    }

    /// Get root node IDs.
    pub fn get_root_nodes(&self) -> Vec<u32> {
        self.scene.root_nodes.clone()
    }

    /// Get a node's transform as a Vec<f32> (column-major, 9 elements).
    /// Used by SVG export which needs the local transform, not the global one.
    pub fn get_node_local_transform(&self, id: u32) -> Vec<f32> {
        self.scene.nodes.get(&id)
            .map(|n| n.transform.to_vec())
            .unwrap_or_default()
    }

    // ─── End Per-Node Getters ───────────────────────────────────────────

    pub fn serialize_scene(&self) -> Vec<u8> {
        bincode::serialize(&self.scene).unwrap_or_default()
    }

    /// Returns a pointer to a 9-element f32 array in Skia row-major format.
    /// This transposes from the internal column-major storage.
    pub fn get_node_transform_ptr(&mut self, id: u32) -> *const f32 {
        if let Some(transform) = self.global_transforms.get(&id) {
            let m = *transform; // column-major
            // Transpose to row-major for CanvasKit/Skia
            self.transform_out_buf = [
                m[0], m[3], m[6], // Row 0: scaleX, skewX, transX
                m[1], m[4], m[7], // Row 1: skewY, scaleY, transY  
                m[2], m[5], m[8], // Row 2: pers0, pers1, pers2
            ];
            self.transform_out_buf.as_ptr()
        } else {
            std::ptr::null()
        }
    }

    pub fn hit_test(&self, x: f32, y: f32) -> Option<u32> {
        // Walk the scene in reverse draw order (topmost first) and return the first hit.
        // This ensures we always pick the visually topmost element.
        let point = [x, y];
        
        // Quick spatial filter first
        let candidate_ids: std::collections::HashSet<u32> = self.spatial_index
            .locate_all_at_point(&point)
            .map(|n| n.id)
            .collect();
        
        if candidate_ids.is_empty() {
            return None;
        }

        // Walk scene tree in draw order, collect into flat list
        let mut draw_order = Vec::new();
        for &root_id in &self.scene.root_nodes {
            self.collect_draw_order(root_id, &mut draw_order);
        }

        // Iterate in reverse (topmost first)
        for &id in draw_order.iter().rev() {
            if !candidate_ids.contains(&id) { continue; }
            
            if let (Some(node), Some(transform_bytes)) = (self.scene.nodes.get(&id), self.global_transforms.get(&id)) {
                if !node.visible { continue; }
                if node.locked { continue; }
                
                let global_transform = Mat3::from_cols_array(transform_bytes);
                let inv_transform = global_transform.inverse();
                let local_point = inv_transform.transform_point2(Vec2::new(x, y));

                let is_hit = match node.geometry {
                    Geometry::Rect { width, height } => {
                        local_point.x >= 0.0 && local_point.x <= width &&
                        local_point.y >= 0.0 && local_point.y <= height
                    },
                    Geometry::Ellipse { radius_x, radius_y } => {
                        let dx = local_point.x;
                        let dy = local_point.y;
                        (dx * dx) / (radius_x * radius_x) + (dy * dy) / (radius_y * radius_y) <= 1.0
                    },
                    Geometry::Path { ref subpaths, .. } => {
                        // Precise geometric test against the actual outline.
                        // Tolerance is in world pixels; convert to local space
                        // by dividing by the transform's average scale factor.
                        let det = (global_transform.x_axis.x * global_transform.y_axis.y
                            - global_transform.x_axis.y * global_transform.y_axis.x).abs();
                        let scale = det.sqrt().max(1e-6);
                        let local_tol = HIT_TOLERANCE / scale;
                        path_hit(subpaths, &node.style, local_point, local_tol)
                    },
                    Geometry::Text { ref content, font_size } => {
                        let approx_w = content.len() as f32 * font_size * 0.6;
                        local_point.x >= 0.0 && local_point.x <= approx_w &&
                        local_point.y >= -font_size && local_point.y <= 0.0
                    },
                };

                if is_hit {
                    return Some(id);
                }
            }
        }
        None
    }

    /// Group-aware hit test: finds the deepest leaf hit, then walks up the parent
    /// chain to find the topmost Group ancestor that is a direct child of root
    /// (or of a non-Group parent). Returns that group's ID, or the leaf ID if
    /// no Group ancestor exists.
    pub fn hit_test_grouped(&self, x: f32, y: f32) -> Option<u32> {
        let leaf_id = self.hit_test(x, y)?;
        Some(self.find_topmost_group_ancestor(leaf_id))
    }

    /// Walk the parent chain from `id` upward, returning the topmost Group ancestor
    /// whose parent is either None or a non-Group node. If `id` itself has no
    /// Group ancestor, returns `id`.
    fn find_topmost_group_ancestor(&self, id: u32) -> u32 {
        let mut topmost_group = id;
        let mut current = id;
        while let Some(node) = self.scene.nodes.get(&current) {
            if let Some(pid) = node.parent {
                if let Some(parent_node) = self.scene.nodes.get(&pid) {
                    if matches!(parent_node.node_type, NodeType::Group) {
                        topmost_group = pid;
                    }
                }
                current = pid;
            } else {
                break;
            }
        }
        topmost_group
    }

    /// Get the node type as u32: 0=Path, 1=Rect, 2=Ellipse, 3=Group, 4=Text
    pub fn get_node_type(&self, id: u32) -> Option<u32> {
        self.scene.nodes.get(&id).map(|n| match n.node_type {
            NodeType::Path => 0,
            NodeType::Rect => 1,
            NodeType::Ellipse => 2,
            NodeType::Group => 3,
            NodeType::Text => 4,
        })
    }

    /// Get the parent node ID, or -1 if root.
    pub fn get_node_parent(&self, id: u32) -> i32 {
        self.scene.nodes.get(&id)
            .and_then(|n| n.parent)
            .map(|p| p as i32)
            .unwrap_or(-1)
    }

    /// Filter a list of IDs to only include ancestors — drop any node whose
    /// ancestor is also in the set. Useful for preventing overlapping selections
    /// (e.g., selecting both a group and its child).
    fn filter_ancestors_only(&self, ids: &[u32]) -> Vec<u32> {
        let id_set: std::collections::HashSet<u32> = ids.iter().cloned().collect();
        ids.iter()
            .filter(|&&id| {
                let mut current = id;
                while let Some(node) = self.scene.nodes.get(&current) {
                    if let Some(pid) = node.parent {
                        if id_set.contains(&pid) { return false; }
                        current = pid;
                    } else {
                        break;
                    }
                }
                true
            })
            .cloned()
            .collect()
    }

    /// Dedup a selection: remove any node whose ancestor is also selected.
    pub fn dedup_selection(&self, ids_json: &str) -> Vec<u32> {
        let ids: Vec<u32> = serde_json::from_str(ids_json).unwrap_or_default();
        self.filter_ancestors_only(&ids)
    }

    /// Returns visible node IDs in document draw order (back to front).
    /// Uses the spatial index for fast culling, then sorts by scene tree order.
    pub fn get_visible_nodes(&self, min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> Vec<u32> {
        let envelope = AABB::from_corners([min_x, min_y], [max_x, max_y]);
        let visible_set: std::collections::HashSet<u32> = self.spatial_index
            .locate_in_envelope_intersecting(&envelope)
            .map(|node| node.id)
            .collect();
        
        if visible_set.is_empty() {
            return Vec::new();
        }

        // Walk scene tree in draw order, filtering to visible set
        let mut result = Vec::with_capacity(visible_set.len());
        for &root_id in &self.scene.root_nodes {
            self.collect_visible_in_order(root_id, &visible_set, &mut result);
        }
        result
    }

    /// Depth-first traversal collecting all node IDs in draw order.
    fn collect_draw_order(&self, id: u32, out: &mut Vec<u32>) {
        out.push(id);
        if let Some(node) = self.scene.nodes.get(&id) {
            for &child_id in &node.children {
                self.collect_draw_order(child_id, out);
            }
        }
    }

    /// Depth-first traversal collecting only IDs present in the visible set.
    fn collect_visible_in_order(&self, id: u32, visible_set: &std::collections::HashSet<u32>, out: &mut Vec<u32>) {
        if visible_set.contains(&id) {
            // Only include nodes that are actually visible (not hidden by user)
            if let Some(node) = self.scene.nodes.get(&id) {
                if node.visible {
                    out.push(id);
                }
            }
        }
        if let Some(node) = self.scene.nodes.get(&id) {
            for &child_id in &node.children {
                self.collect_visible_in_order(child_id, visible_set, out);
            }
        }
    }

    pub fn select_node(&mut self, id: u32, multi: bool) {
        if !multi {
            self.scene.selection.clear();
        }
        if !self.scene.selection.contains(&id) {
            self.scene.selection.push(id);
        }
    }

    pub fn clear_selection(&mut self) {
        self.scene.selection.clear();
    }

    pub fn get_selection(&self) -> Vec<u32> {
        self.scene.selection.clone()
    }

    /// Convert any geometry to a Path (editable points).
    /// Rect → 4 corner points (closed). Ellipse → 4 bezier arcs (closed).
    /// Returns true if a conversion happened.
    pub fn convert_to_path(&mut self, id: u32) -> bool {
        let new_geometry = if let Some(node) = self.scene.nodes.get(&id) {
            match &node.geometry {
                Geometry::Rect { width, height } => {
                    let w = *width;
                    let h = *height;
                    // 4 corners, closed subpath (no duplicate closing point)
                    let points = vec![
                        PathPoint { x: 0.0, y: 0.0, cp1: Vec2::new(0.0, 0.0), cp2: Vec2::new(0.0, 0.0) },
                        PathPoint { x: w,   y: 0.0, cp1: Vec2::new(w, 0.0),   cp2: Vec2::new(w, 0.0) },
                        PathPoint { x: w,   y: h,   cp1: Vec2::new(w, h),     cp2: Vec2::new(w, h) },
                        PathPoint { x: 0.0, y: h,   cp1: Vec2::new(0.0, h),   cp2: Vec2::new(0.0, h) },
                    ];
                    {
                        let subpaths = vec![Subpath { points, closed: true }];
                        Some(Geometry::Path {
                            network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                            subpaths,
                        })
                    }
                }
                Geometry::Ellipse { radius_x, radius_y } => {
                    let rx = *radius_x;
                    let ry = *radius_y;
                    let k: f32 = 0.5522847498;
                    let kx = rx * k;
                    let ky = ry * k;
                    // 4 cardinal points, closed subpath (no duplicate)
                    let points = vec![
                        PathPoint { x: 0.0, y: -ry, cp1: Vec2::new(-kx, -ry), cp2: Vec2::new(kx, -ry) },
                        PathPoint { x: rx,  y: 0.0, cp1: Vec2::new(rx, -ky),  cp2: Vec2::new(rx, ky) },
                        PathPoint { x: 0.0, y: ry,  cp1: Vec2::new(kx, ry),   cp2: Vec2::new(-kx, ry) },
                        PathPoint { x: -rx, y: 0.0, cp1: Vec2::new(-rx, ky),  cp2: Vec2::new(-rx, -ky) },
                    ];
                    {
                        let subpaths = vec![Subpath { points, closed: true }];
                        Some(Geometry::Path {
                            network: Some(NodeVectorNetwork::from_subpaths(&subpaths)),
                            subpaths,
                        })
                    }
                }
                Geometry::Path { .. } => None, // Already a path
                Geometry::Text { .. } => None, // Can't convert text
            }
        } else {
            None
        };

        if let Some(geo) = new_geometry {
            if let Some(node) = self.scene.nodes.get_mut(&id) {
                node.geometry = geo;
                node.node_type = NodeType::Path;
                self.update_spatial_index(id);
                self.mark_dirty(id);
            }
            true
        } else {
            false
        }
    }

    /// Resize a node's geometry to new width/height.
    pub fn resize_node(&mut self, id: u32, new_w: f32, new_h: f32) {
        // Groups have placeholder geometry — resize them by scaling the
        // group's transform about the bounds' top-left corner, so the whole
        // subtree scales together.
        let is_group = matches!(
            self.scene.nodes.get(&id).map(|n| n.node_type),
            Some(NodeType::Group)
        );
        if is_group {
            self.resize_group(id, new_w.max(1.0), new_h.max(1.0));
            return;
        }
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            match &mut node.geometry {
                Geometry::Rect { width, height } => {
                    *width = new_w.max(1.0);
                    *height = new_h.max(1.0);
                }
                Geometry::Ellipse { radius_x, radius_y } => {
                    *radius_x = (new_w / 2.0).max(0.5);
                    *radius_y = (new_h / 2.0).max(0.5);
                }
                Geometry::Path { subpaths, ref mut network, .. } => {
                    // Scale all subpath points proportionally using full bounds
                    let mut min_x = f32::MAX; let mut min_y = f32::MAX;
                    let mut max_x = f32::MIN; let mut max_y = f32::MIN;
                    let mut has_points = false;
                    for sp in subpaths.iter() {
                        for pt in &sp.points {
                            has_points = true;
                            min_x = min_x.min(pt.x).min(pt.cp1.x).min(pt.cp2.x);
                            min_y = min_y.min(pt.y).min(pt.cp1.y).min(pt.cp2.y);
                            max_x = max_x.max(pt.x).max(pt.cp1.x).max(pt.cp2.x);
                            max_y = max_y.max(pt.y).max(pt.cp1.y).max(pt.cp2.y);
                        }
                    }
                    if !has_points { return; }
                    let old_w = (max_x - min_x).max(1.0);
                    let old_h = (max_y - min_y).max(1.0);
                    let sx = new_w / old_w;
                    let sy = new_h / old_h;
                    for sp in subpaths.iter_mut() {
                        for pt in sp.points.iter_mut() {
                            pt.x = min_x + (pt.x - min_x) * sx;
                            pt.y = min_y + (pt.y - min_y) * sy;
                            pt.cp1 = Vec2::new(
                                min_x + (pt.cp1.x - min_x) * sx,
                                min_y + (pt.cp1.y - min_y) * sy,
                            );
                            pt.cp2 = Vec2::new(
                                min_x + (pt.cp2.x - min_x) * sx,
                                min_y + (pt.cp2.y - min_y) * sy,
                            );
                        }
                    }
                    // Rebuild network from scaled subpaths to keep in sync
                    *network = Some(NodeVectorNetwork::from_subpaths(subpaths));
                }
                Geometry::Text { .. } => {}
            }
            self.update_spatial_index(id);
            self.update_ancestor_group_bounds(id);
            self.mark_dirty(id);
        }
    }

    /// Resize a group by scaling its transform about its bounds' top-left
    /// corner (world space), so all descendants scale together.
    fn resize_group(&mut self, id: u32, new_w: f32, new_h: f32) {
        let bounds = self.get_node_bounds(id); // [min_x, min_y, max_x, max_y] world
        let old_w = (bounds[2] - bounds[0]).max(1e-3);
        let old_h = (bounds[3] - bounds[1]).max(1e-3);
        let sx = new_w / old_w;
        let sy = new_h / old_h;
        let anchor = Vec2::new(bounds[0], bounds[1]);

        let global = match self.global_transforms.get(&id) {
            Some(m) => Mat3::from_cols_array(m),
            None => return,
        };
        let parent_global = self.scene.nodes.get(&id)
            .and_then(|n| n.parent)
            .and_then(|pid| self.global_transforms.get(&pid))
            .map(Mat3::from_cols_array)
            .unwrap_or(Mat3::IDENTITY);

        // World-space scale about the anchor, applied on top of the global transform
        let scale_about = Mat3::from_translation(anchor)
            * Mat3::from_scale(Vec2::new(sx, sy))
            * Mat3::from_translation(-anchor);
        let new_local = parent_global.inverse() * scale_about * global;

        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.transform = new_local.to_cols_array();
        }
        self.update_node_global_transform(id);
        self.update_spatial_index_recursive(id);
        self.update_ancestor_group_bounds(id);
        // Mark the whole subtree dirty so every descendant re-renders
        let mut stack = vec![id];
        while let Some(cur) = stack.pop() {
            self.dirty_flags.insert(cur, true);
            if let Some(n) = self.scene.nodes.get(&cur) {
                stack.extend(n.children.iter().copied());
            }
        }
        self.scene.vector_network.dirty = true;
    }

    /// Set a node's absolute position (translation part of its local transform).
    pub fn set_node_position(&mut self, id: u32, x: f32, y: f32) {
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            let mut transform = Mat3::from_cols_array(&node.transform);
            transform.z_axis.x = x;
            transform.z_axis.y = y;
            node.transform = transform.to_cols_array();
            self.update_node_global_transform(id);
            self.update_spatial_index_recursive(id);
            self.update_ancestor_group_bounds(id);
            self.mark_dirty(id);
        }
    }

    /// Set a node's full local transform from a JSON array of 9 f32 values (column-major, matching `Mat3::from_cols_array`).
    pub fn set_node_transform(&mut self, id: u32, transform_json: &str) {
        let parsed: [f32; 9] = match serde_json::from_str(transform_json) {
            Ok(v) => v,
            Err(_) => return,
        };
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.transform = parsed;
            self.update_node_global_transform(id);
            self.update_spatial_index_recursive(id);
            self.update_ancestor_group_bounds(id);
            self.mark_dirty(id);
        }
    }

    /// Set a node's rotation (in radians), preserving its translation and
    /// scale. The linear part is decomposed as rotation × scale; only the
    /// rotation component is replaced (a resized group keeps its size).
    pub fn rotate_node(&mut self, id: u32, angle_rad: f32) {
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            let old = Mat3::from_cols_array(&node.transform);
            let tx = old.z_axis.x;
            let ty = old.z_axis.y;
            let sx = (old.x_axis.x * old.x_axis.x + old.x_axis.y * old.x_axis.y).sqrt();
            let sy_len = (old.y_axis.x * old.y_axis.x + old.y_axis.y * old.y_axis.y).sqrt();
            // Negative determinant means a flip — keep it on the y axis
            let det = old.x_axis.x * old.y_axis.y - old.y_axis.x * old.x_axis.y;
            let sy = if det < 0.0 { -sy_len } else { sy_len };
            let new_transform = Mat3::from_translation(Vec2::new(tx, ty))
                * Mat3::from_angle(angle_rad)
                * Mat3::from_scale(Vec2::new(sx.max(1e-6), sy));
            node.transform = new_transform.to_cols_array();
            self.update_node_global_transform(id);
            self.update_spatial_index_recursive(id);
            self.update_ancestor_group_bounds(id);
            self.mark_dirty(id);
        }
    }

    /// Duplicate a node (and its entire subtree if a group) and return the new id.
    pub fn duplicate_node(&mut self, id: u32) -> u32 {
        let new_id = self.deep_clone_subtree(id);
        // Offset the top-level clone by 20px
        if let Some(node) = self.scene.nodes.get_mut(&new_id) {
            let mut t = Mat3::from_cols_array(&node.transform);
            t.z_axis.x += 20.0;
            t.z_axis.y += 20.0;
            node.transform = t.to_cols_array();
            node.parent = None;
        }
        // Remove from any parent it was temporarily added to and add to root
        self.scene.root_nodes.retain(|&r| r != new_id);
        self.scene.root_nodes.push(new_id);
        self.update_node_global_transform(new_id);
        self.update_spatial_index_recursive(new_id);
        self.mark_dirty(new_id);
        new_id
    }

    /// Recursively clone a node and all its descendants, returning the new root ID.
    /// The cloned nodes have fresh IDs and correct parent/children pointers.
    /// The cloned root's parent is set to None (caller is responsible for reparenting).
    fn deep_clone_subtree(&mut self, id: u32) -> u32 {
        let new_id = self.next_id;
        self.next_id += 1;

        if let Some(node) = self.scene.nodes.get(&id).cloned() {
            let old_children = node.children.clone();
            let mut new_node = node;
            new_node.id = new_id;
            new_node.name = format!("{} copy", new_node.name);
            new_node.children = Vec::new();
            new_node.parent = None;

            self.scene.nodes.insert(new_id, new_node);

            // Recursively clone children and reparent them
            for child_id in old_children {
                let new_child_id = self.deep_clone_subtree(child_id);
                // set_parent handles adding to children vec and updating parent pointer
                if let Some(child_node) = self.scene.nodes.get_mut(&new_child_id) {
                    child_node.parent = Some(new_id);
                }
                if let Some(parent_node) = self.scene.nodes.get_mut(&new_id) {
                    parent_node.children.push(new_child_id);
                }
            }
        }
        new_id
    }

    /// Group selected nodes into a new Group node. Returns the group's id.
    /// Deduplicates the selection (drops descendants of selected ancestors).
    /// Places the group at the z-position of the topmost member in the common parent.
    pub fn group_nodes(&mut self, ids_json: &str) -> u32 {
        let raw_ids: Vec<u32> = serde_json::from_str(ids_json).unwrap_or_default();
        if raw_ids.is_empty() { return 0; }

        // Dedup: remove any node whose ancestor is also selected
        let ids = self.filter_ancestors_only(&raw_ids);
        if ids.is_empty() { return 0; }

        let group_id = self.next_id;
        self.next_id += 1;

        // Determine the common parent of all selected nodes
        let first_parent = self.scene.nodes.get(&ids[0]).and_then(|n| n.parent);
        let all_same_parent = ids.iter().all(|&id| {
            self.scene.nodes.get(&id).and_then(|n| n.parent) == first_parent
        });
        let group_parent = if all_same_parent { first_parent } else { None };

        // Find the z-position: insert group at the position of the topmost (last) member
        // in the parent's children list (or root_nodes)
        let insert_index = {
            let sibling_list = if let Some(pid) = group_parent {
                self.scene.nodes.get(&pid).map(|n| n.children.clone()).unwrap_or_default()
            } else {
                self.scene.root_nodes.clone()
            };
            let id_set: std::collections::HashSet<u32> = ids.iter().cloned().collect();
            let mut max_idx = 0usize;
            for (i, &sib_id) in sibling_list.iter().enumerate() {
                if id_set.contains(&sib_id) {
                    max_idx = i;
                }
            }
            max_idx
        };

        // Compute group global transform: use the AABB min corner of selected members
        // so the group origin is at the top-left of the bounding box
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        for &id in &ids {
            if let Some(spatial) = self.node_to_spatial.get(&id) {
                let lower = spatial.aabb.lower();
                min_x = min_x.min(lower[0]);
                min_y = min_y.min(lower[1]);
            }
        }
        if min_x == f32::MAX { min_x = 0.0; }
        if min_y == f32::MAX { min_y = 0.0; }

        // Group local transform: if the group has a parent, compute local from global
        let group_global = Mat3::from_translation(Vec2::new(min_x, min_y));
        let group_local = if let Some(pid) = group_parent {
            let parent_global = self.global_transforms.get(&pid)
                .map(|&m| Mat3::from_cols_array(&m))
                .unwrap_or(Mat3::IDENTITY);
            parent_global.inverse() * group_global
        } else {
            group_global
        };

        let group_node = Node {
            id: group_id,
            name: format!("Group {}", group_id),
            node_type: NodeType::Group,
            transform: group_local.to_cols_array(),
            style: Style {
                fill: None,
                stroke: None,
                stroke_width: 0.0,
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
            },
            geometry: Geometry::Rect { width: 0.0, height: 0.0 },
            children: Vec::new(),
            parent: group_parent,
            visible: true,
            locked: false,
        };
        self.scene.nodes.insert(group_id, group_node);

        // Insert group at the correct z-position in its parent
        if let Some(pid) = group_parent {
            if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                let pos = (insert_index + 1).min(parent.children.len());
                parent.children.insert(pos, group_id);
            }
        } else {
            let pos = (insert_index + 1).min(self.scene.root_nodes.len());
            self.scene.root_nodes.insert(pos, group_id);
        }

        // Compute the group's global transform so we can use it for child reparenting
        self.update_node_global_transform(group_id);
        let group_global_inv = group_global.inverse();

        // Reparent nodes: adjust their local transforms using proper matrix math
        // child_new_local = group_global_inv * child_global
        for &id in &ids {
            let child_global = self.global_transforms.get(&id)
                .map(|&m| Mat3::from_cols_array(&m))
                .unwrap_or(Mat3::IDENTITY);
            let child_new_local = group_global_inv * child_global;

            // Remove from old parent
            let old_parent = self.scene.nodes.get(&id).and_then(|n| n.parent);
            if let Some(old_pid) = old_parent {
                if let Some(old_p) = self.scene.nodes.get_mut(&old_pid) {
                    old_p.children.retain(|&c| c != id);
                }
            } else {
                self.scene.root_nodes.retain(|&r| r != id);
            }

            // Update transform and parent
            if let Some(node) = self.scene.nodes.get_mut(&id) {
                node.transform = child_new_local.to_cols_array();
                node.parent = Some(group_id);
            }
            if let Some(g) = self.scene.nodes.get_mut(&group_id) {
                g.children.push(id);
            }
        }

        // Recompute transforms and spatial index for the entire group subtree
        self.update_node_global_transform(group_id);
        self.update_spatial_index_recursive(group_id);
        self.mark_dirty(group_id);
        group_id
    }

    /// Ungroup a group node, promoting its children to the group's parent level.
    /// Children are inserted at the group's z-position, preserving their global positions.
    pub fn ungroup_node(&mut self, id: u32) {
        let (children, group_parent, group_global) = if let Some(node) = self.scene.nodes.get(&id) {
            if !matches!(node.node_type, NodeType::Group) { return; }
            let global = self.global_transforms.get(&id)
                .map(|&m| Mat3::from_cols_array(&m))
                .unwrap_or(Mat3::IDENTITY);
            (node.children.clone(), node.parent, global)
        } else {
            return;
        };

        // Find the group's index in its parent's children list (or root_nodes)
        let group_index = if let Some(pid) = group_parent {
            self.scene.nodes.get(&pid)
                .and_then(|p| p.children.iter().position(|&c| c == id))
                .unwrap_or(0)
        } else {
            self.scene.root_nodes.iter().position(|&r| r == id).unwrap_or(0)
        };

        // Compute parent's global transform for local transform computation
        let parent_global = if let Some(pid) = group_parent {
            self.global_transforms.get(&pid)
                .map(|&m| Mat3::from_cols_array(&m))
                .unwrap_or(Mat3::IDENTITY)
        } else {
            Mat3::IDENTITY
        };
        let parent_global_inv = parent_global.inverse();

        // Promote children to the group's parent, preserving global positions
        for (offset, &child_id) in children.iter().enumerate() {
            // child_new_local = parent_global_inv * child_global
            // where child_global = group_global * child_old_local
            let child_old_local = self.scene.nodes.get(&child_id)
                .map(|n| Mat3::from_cols_array(&n.transform))
                .unwrap_or(Mat3::IDENTITY);
            let child_global = group_global * child_old_local;
            let child_new_local = parent_global_inv * child_global;

            if let Some(child) = self.scene.nodes.get_mut(&child_id) {
                child.transform = child_new_local.to_cols_array();
                child.parent = group_parent;
            }

            // Insert at the group's former position
            if let Some(pid) = group_parent {
                if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                    let pos = (group_index + offset).min(parent.children.len());
                    parent.children.insert(pos, child_id);
                }
            } else {
                let pos = (group_index + offset).min(self.scene.root_nodes.len());
                self.scene.root_nodes.insert(pos, child_id);
            }
        }

        // Remove the group node itself
        if let Some(group) = self.scene.nodes.get_mut(&id) {
            group.children.clear();
        }
        self.scene.nodes.remove(&id);
        // Remove group from its parent's children list (or root_nodes)
        if let Some(pid) = group_parent {
            if let Some(parent) = self.scene.nodes.get_mut(&pid) {
                parent.children.retain(|&c| c != id);
            }
        } else {
            self.scene.root_nodes.retain(|&r| r != id);
        }
        self.global_transforms.remove(&id);
        if let Some(old) = self.node_to_spatial.remove(&id) {
            self.spatial_index.remove(&old);
        }
        self.scene.selection.retain(|&s| s != id);

        // Update children transforms and spatial indices
        for &child_id in &children {
            self.update_node_global_transform(child_id);
            self.update_spatial_index_recursive(child_id);
            self.mark_dirty(child_id);
        }

        // Update ancestor group bounds if we ungrouped inside another group
        if let Some(pid) = group_parent {
            self.update_ancestor_group_bounds(pid);
        }
    }

    /// Add a text node.
    pub fn add_text(&mut self, x: f32, y: f32, content: &str, font_size: f32) -> u32 {
        let id = self.next_id;
        self.next_id += 1;

        let node = Node {
            id,
            name: format!("Text {}", id),
            node_type: NodeType::Text,
            transform: Mat3::from_translation(Vec2::new(x, y)).to_cols_array(),
            style: Style {
                fill: Some(Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }),
                stroke: None,
                stroke_width: 0.0,
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
            },
            geometry: Geometry::Text { content: content.to_string(), font_size },
            children: Vec::new(),
            parent: None,
            visible: true,
            locked: false,
        };

        self.scene.nodes.insert(id, node);
        self.scene.root_nodes.push(id);
        self.update_node_global_transform(id);
        // Approximate text bounds for spatial index
        let approx_w = content.len() as f32 * font_size * 0.6;
        let approx_h = font_size;
        let spatial_node = SpatialNode {
            id,
            aabb: AABB::from_corners([x, y - approx_h], [x + approx_w, y]),
        };
        self.spatial_index.insert(spatial_node);
        self.node_to_spatial.insert(id, spatial_node);
        self.mark_dirty(id);
        id
    }

    /// Update a text node's content and font size.
    pub fn set_text_content(&mut self, id: u32, content: &str, font_size: f32) {
        let updated = if let Some(node) = self.scene.nodes.get_mut(&id) {
            if let Geometry::Text { content: c, font_size: fs } = &mut node.geometry {
                *c = content.to_string();
                *fs = font_size.max(1.0);
                true
            } else {
                false
            }
        } else {
            false
        };
        if updated {
            self.update_spatial_index(id);
            self.update_ancestor_group_bounds(id);
            self.mark_dirty(id);
        }
    }

    /// Get bounding box of a node in world coordinates: [minX, minY, maxX, maxY]
    pub fn get_node_bounds(&self, id: u32) -> Vec<f32> {
        if let Some(spatial) = self.node_to_spatial.get(&id) {
            let lower = spatial.aabb.lower();
            let upper = spatial.aabb.upper();
            vec![lower[0], lower[1], upper[0], upper[1]]
        } else {
            vec![0.0, 0.0, 0.0, 0.0]
        }
    }

    // ─── Per-Node VectorNetwork Editing API ─────────────────────────────

    /// Get the per-node vector network as JSON.
    pub fn get_node_network_json(&self, id: u32) -> String {
        self.scene.nodes.get(&id)
            .and_then(|n| match &n.geometry {
                Geometry::Path { network, .. } => network.as_ref(),
                _ => None,
            })
            .map(|net| serde_json::to_string(net).unwrap_or_default())
            .unwrap_or_default()
    }

    /// Update a vertex position and handles in a node's network.
    pub fn set_network_vertex(
        &mut self, node_id: u32, vertex_idx: u32,
        x: f32, y: f32,
        hin_x: f32, hin_y: f32, has_hin: bool,
        hout_x: f32, hout_y: f32, has_hout: bool,
    ) {
        if let Some(node) = self.scene.nodes.get_mut(&node_id) {
            if let Geometry::Path { ref mut network, ref mut subpaths, .. } = node.geometry {
                if let Some(net) = network.as_mut() {
                    if let Some(v) = net.vertices.get_mut(vertex_idx as usize) {
                        v.position = Vec2::new(x, y);
                        v.handle_in = if has_hin { Some(Vec2::new(hin_x, hin_y)) } else { None };
                        v.handle_out = if has_hout { Some(Vec2::new(hout_x, hout_y)) } else { None };
                    }
                    *subpaths = net.to_subpaths();
                }
            }
        }
        self.update_spatial_index(node_id);
        self.mark_dirty(node_id);
    }

    /// Add a vertex to a node's network. Returns the new vertex index.
    pub fn add_network_vertex(&mut self, node_id: u32, x: f32, y: f32) -> i32 {
        let result = if let Some(node) = self.scene.nodes.get_mut(&node_id) {
            if let Geometry::Path { ref mut network, ref mut subpaths, .. } = node.geometry {
                if let Some(net) = network.as_mut() {
                    let idx = net.vertices.len() as u32;
                    net.vertices.push(NetworkVertex {
                        position: Vec2::new(x, y),
                        handle_in: None,
                        handle_out: None,
                    });
                    *subpaths = net.to_subpaths();
                    idx as i32
                } else { -1 }
            } else { -1 }
        } else { -1 };
        if result >= 0 {
            self.update_spatial_index(node_id);
            self.mark_dirty(node_id);
        }
        result
    }

    /// Add an edge between two vertices in a node's network. Returns the edge index.
    pub fn add_network_edge(&mut self, node_id: u32, start: u32, end: u32) -> i32 {
        let result = if let Some(node) = self.scene.nodes.get_mut(&node_id) {
            if let Geometry::Path { ref mut network, ref mut subpaths, .. } = node.geometry {
                if let Some(net) = network.as_mut() {
                    let idx = net.edges.len() as u32;
                    net.edges.push(NetworkEdge {
                        start_vertex: start,
                        end_vertex: end,
                    });
                    *subpaths = net.to_subpaths();
                    idx as i32
                } else { -1 }
            } else { -1 }
        } else { -1 };
        if result >= 0 {
            self.update_spatial_index(node_id);
            self.mark_dirty(node_id);
        }
        result
    }

    /// Remove a vertex (and its edges) from a node's network.
    pub fn remove_network_vertex(&mut self, node_id: u32, vertex_idx: u32) {
        if let Some(node) = self.scene.nodes.get_mut(&node_id) {
            if let Geometry::Path { ref mut network, ref mut subpaths, .. } = node.geometry {
                if let Some(net) = network.as_mut() {
                    let vi = vertex_idx as usize;
                    if vi < net.vertices.len() {
                        net.vertices.remove(vi);
                        // Remove edges referencing this vertex, and remap indices
                        net.edges.retain(|e| {
                            e.start_vertex != vertex_idx && e.end_vertex != vertex_idx
                        });
                        for e in &mut net.edges {
                            if e.start_vertex > vertex_idx { e.start_vertex -= 1; }
                            if e.end_vertex > vertex_idx { e.end_vertex -= 1; }
                        }
                        // Also remap region edge references
                        net.regions.clear(); // Regions invalidated by topology change
                        *subpaths = net.to_subpaths();
                    }
                }
            }
        }
        self.update_spatial_index(node_id);
        self.mark_dirty(node_id);
    }

    /// Detect enclosed regions in a node's network (placeholder — uses simple cycle detection).
    pub fn detect_node_regions(&mut self, node_id: u32) {
        if let Some(node) = self.scene.nodes.get_mut(&node_id) {
            if let Geometry::Path { ref mut network, .. } = node.geometry {
                if let Some(_net) = network.as_mut() {
                    // TODO: Implement per-node planar face detection
                    // For now, regions are managed manually via set_node_region_fill
                }
            }
        }
    }

    /// Set fill color on a specific region of a node's network.
    pub fn set_node_region_fill(
        &mut self, node_id: u32, region_idx: u32,
        r: f32, g: f32, b: f32, a: f32,
    ) {
        if let Some(node) = self.scene.nodes.get_mut(&node_id) {
            if let Geometry::Path { ref mut network, .. } = node.geometry {
                if let Some(net) = network.as_mut() {
                    if let Some(region) = net.regions.get_mut(region_idx as usize) {
                        region.fill = Some(Color { r, g, b, a });
                    }
                }
            }
        }
        self.mark_dirty(node_id);
    }

    // ─── End Per-Node VectorNetwork API ─────────────────────────────────
}

#[wasm_bindgen]
pub struct History {
    undo_stack: Vec<Vec<u8>>,
    redo_stack: Vec<Vec<u8>>,
    max_size: usize,
}

#[wasm_bindgen]
impl History {
    #[wasm_bindgen(constructor)]
    pub fn new(max_size: usize) -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_size,
        }
    }

    pub fn push_state(&mut self, data: Vec<u8>) {
        self.undo_stack.push(data);
        if self.undo_stack.len() > self.max_size {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
    }

    pub fn undo(&mut self, current_state: Vec<u8>) -> Option<Vec<u8>> {
        if let Some(state) = self.undo_stack.pop() {
            self.redo_stack.push(current_state);
            Some(state)
        } else {
            None
        }
    }

    pub fn redo(&mut self, current_state: Vec<u8>) -> Option<Vec<u8>> {
        if let Some(state) = self.redo_stack.pop() {
            self.undo_stack.push(current_state);
            Some(state)
        } else {
            None
        }
    }
}

// ─── Live Paint / Vector Network API ────────────────────────────────────────────

#[wasm_bindgen]
impl Engine {
    /// Rebuild the planar graph from all visible paths.
    pub fn rebuild_vector_network(&mut self) {
        let segments = self.collect_segments();
        self.scene.vector_network.rebuild(segments);
    }

    /// Mark the vector network as needing recomputation.
    pub fn invalidate_vector_network(&mut self) {
        self.scene.vector_network.dirty = true;
    }

    /// Query which face contains the given point. Returns face ID or -1.
    pub fn query_face_at(&mut self, x: f32, y: f32) -> i32 {
        self.ensure_network_clean();
        match self.scene.vector_network.query_face_at(x, y) {
            Some(id) => id as i32,
            None => -1,
        }
    }

    /// Get the boundary polygon of a face as JSON.
    pub fn get_face_boundary(&mut self, face_id: u32) -> String {
        self.ensure_network_clean();
        match self.scene.vector_network.faces.get(&face_id) {
            Some(face) => serde_json::to_string(&face.boundary_polygon).unwrap_or_default(),
            None => "[]".to_string(),
        }
    }

    /// Assign a fill color to a face.
    pub fn set_face_fill(&mut self, face_id: u32, r: f32, g: f32, b: f32, a: f32) {
        if let Some(face) = self.scene.vector_network.faces.get_mut(&face_id) {
            face.fill = Some(Color { r, g, b, a });
        }
    }

    /// Clear a face's fill.
    pub fn clear_face_fill(&mut self, face_id: u32) {
        if let Some(face) = self.scene.vector_network.faces.get_mut(&face_id) {
            face.fill = None;
        }
    }

    /// Get all filled faces as JSON for rendering.
    pub fn get_filled_faces(&mut self) -> String {
        self.ensure_network_clean();
        let filled: Vec<serde_json::Value> = self.scene.vector_network.faces.values()
            .filter(|f| f.fill.is_some() && !f.is_outer)
            .map(|f| {
                let fill = f.fill.as_ref().unwrap();
                serde_json::json!({
                    "id": f.id,
                    "boundary": f.boundary_polygon,
                    "fill": { "r": fill.r, "g": fill.g, "b": fill.b, "a": fill.a }
                })
            })
            .collect();
        serde_json::to_string(&filled).unwrap_or_default()
    }

    /// Set gap tolerance for the vector network.
    pub fn set_gap_tolerance(&mut self, tolerance: f32) {
        self.scene.vector_network.gap_tolerance = tolerance;
        self.scene.vector_network.dirty = true;
    }

    /// Check if the vector network is dirty.
    pub fn is_vector_network_dirty(&self) -> bool {
        self.scene.vector_network.dirty
    }
}

// ─── Protobuf File Format API ───────────────────────────────────────────────────

#[wasm_bindgen]
impl Engine {
    /// Serialize scene to protobuf bytes (.vec file format).
    pub fn serialize_proto(&self) -> Vec<u8> {
        proto::serialize_to_proto(&self.scene, self.next_id)
    }

    /// Deserialize scene from protobuf bytes (.vec file format).
    /// Returns true on success.
    pub fn deserialize_proto(&mut self, data: &[u8]) -> bool {
        match proto::deserialize_from_proto(data) {
            Some((scene, next_id)) => {
                self.scene = scene;
                self.next_id = next_id;
                self.update_all_global_transforms();
                self.update_all_spatial_indices();
                true
            }
            None => false,
        }
    }

    /// Serialize scene to base64-encoded protobuf (for SVG embedding).
    pub fn serialize_proto_base64(&self) -> String {
        proto::serialize_to_base64(&self.scene, self.next_id)
    }

    /// Deserialize scene from base64-encoded protobuf (from SVG metadata).
    /// Returns true on success.
    pub fn deserialize_proto_base64(&mut self, b64: &str) -> bool {
        match proto::deserialize_from_base64(b64) {
            Some((scene, next_id)) => {
                self.scene = scene;
                self.next_id = next_id;
                self.update_all_global_transforms();
                self.update_all_spatial_indices();
                true
            }
            None => false,
        }
    }

    /// Get the current format version.
    pub fn get_format_version(&self) -> u32 {
        FORMAT_VERSION
    }

    pub fn get_document_width(&self) -> f32 {
        self.scene.document_width
    }

    pub fn get_document_height(&self) -> f32 {
        self.scene.document_height
    }

    pub fn set_document_size(&mut self, w: f32, h: f32) {
        self.scene.document_width = w;
        self.scene.document_height = h;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_rect() {
        let mut engine = Engine::new();
        let id = engine.add_rect(10.0, 20.0, 100.0, 50.0);
        assert_eq!(id, 1);
        assert_eq!(engine.scene.nodes.len(), 1);
        
        let node = engine.scene.nodes.get(&id).unwrap();
        assert_eq!(node.name, "Rect 1");
        let transform = Mat3::from_cols_array(&node.transform);
        assert_eq!(transform.z_axis.x, 10.0);
        assert_eq!(transform.z_axis.y, 20.0);
    }

    #[test]
    fn test_hierarchical_transforms() {
        let mut engine = Engine::new();
        let parent_id = engine.add_rect(100.0, 100.0, 200.0, 200.0);
        let child_id = engine.add_rect(10.0, 10.0, 50.0, 50.0);
        
        assert!(engine.set_parent(child_id, Some(parent_id)));
        
        // Verify internal column-major storage directly
        let global = engine.global_transforms.get(&child_id).unwrap();
        let mat = Mat3::from_cols_array(global);
        
        // Global position should be parent (100, 100) + child (10, 10) = (110, 110)
        assert_eq!(mat.z_axis.x, 110.0);
        assert_eq!(mat.z_axis.y, 110.0);

        // Also verify the JS-facing pointer returns row-major format
        let ptr = engine.get_node_transform_ptr(child_id);
        let row_major = unsafe { std::slice::from_raw_parts(ptr, 9) };
        // In row-major: [scaleX, skewX, transX, skewY, scaleY, transY, ...]
        assert_eq!(row_major[2], 110.0); // transX
        assert_eq!(row_major[5], 110.0); // transY
    }

    #[test]
    fn test_hit_test() {
        let mut engine = Engine::new();
        let rect_id = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        
        assert_eq!(engine.hit_test(50.0, 50.0), Some(rect_id));
        assert_eq!(engine.hit_test(150.0, 50.0), None);
        
        // Move and test again
        engine.move_node(rect_id, 100.0, 0.0);
        assert_eq!(engine.hit_test(50.0, 50.0), None);
        assert_eq!(engine.hit_test(150.0, 50.0), Some(rect_id));
    }

    #[test]
    fn test_hit_test_z_order() {
        let mut engine = Engine::new();
        // rect_a is added first → drawn first (bottom)
        let rect_a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        // rect_b is added second → drawn on top
        let rect_b = engine.add_rect(50.0, 50.0, 100.0, 100.0);
        
        // In the overlap region (50-100, 50-100), rect_b should win (it's on top)
        assert_eq!(engine.hit_test(75.0, 75.0), Some(rect_b));
        
        // In rect_a-only region, rect_a should be hit
        assert_eq!(engine.hit_test(25.0, 25.0), Some(rect_a));
        
        // In rect_b-only region, rect_b should be hit
        assert_eq!(engine.hit_test(125.0, 125.0), Some(rect_b));
        
        // After send_to_back(rect_b), rect_a should be on top in overlap
        engine.send_to_back(rect_b);
        assert_eq!(engine.hit_test(75.0, 75.0), Some(rect_a));
        
        // After bring_to_front(rect_b), rect_b should be on top again
        engine.bring_to_front(rect_b);
        assert_eq!(engine.hit_test(75.0, 75.0), Some(rect_b));
    }

    #[test]
    fn test_visible_nodes_z_order() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 50.0, 50.0);
        let b = engine.add_rect(10.0, 10.0, 50.0, 50.0);
        let c = engine.add_rect(20.0, 20.0, 50.0, 50.0);
        
        // All visible in a large viewport
        let visible = engine.get_visible_nodes(0.0, 0.0, 200.0, 200.0);
        // Must be in draw order: a first (bottom), c last (top)
        assert_eq!(visible, vec![a, b, c]);
        
        // After reordering, draw order changes
        engine.send_to_back(c);
        let visible2 = engine.get_visible_nodes(0.0, 0.0, 200.0, 200.0);
        assert_eq!(visible2, vec![c, a, b]);
    }

    #[test]
    fn test_history() {
        let mut engine = Engine::new();
        let mut history = History::new(10);
        
        let state0 = engine.serialize_scene();
        history.push_state(state0.clone());
        
        engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let state1 = engine.serialize_scene();
        
        let restored0 = history.undo(state1.clone()).unwrap();
        assert_eq!(restored0, state0);
        
        let restored1 = history.redo(restored0).unwrap();
        assert_eq!(restored1, state1);
    }

    #[test]
    fn test_cycle_prevention() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let b = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let c = engine.add_rect(0.0, 0.0, 10.0, 10.0);
        
        assert!(engine.set_parent(b, Some(a)));
        assert!(engine.set_parent(c, Some(b)));
        assert!(!engine.set_parent(a, Some(c))); // Cycle!
    }

    #[test]
    fn test_stress_and_consistency() {
        let mut engine = Engine::new();
        let mut history = History::new(100);
        let mut ids = Vec::new();
        
        use rand::Rng;
        let mut rng = rand::thread_rng();
        
        for i in 0..1000 {
            let op = rng.gen_range(0..6);
            match op {
                0 => { // Add
                    let id = engine.add_rect(rng.gen(), rng.gen(), rng.gen(), rng.gen());
                    ids.push(id);
                }
                1 => { // Move
                    if !ids.is_empty() {
                        let idx = rng.gen_range(0..ids.len());
                        engine.move_node(ids[idx], rng.gen(), rng.gen());
                    }
                }
                2 => { // Set Parent
                    if ids.len() >= 2 {
                        let c_idx = rng.gen_range(0..ids.len());
                        let p_idx = rng.gen_range(0..ids.len());
                        if c_idx != p_idx {
                            engine.set_parent(ids[c_idx], Some(ids[p_idx]));
                        }
                    }
                }
                3 => { // Remove
                    if !ids.is_empty() {
                        let idx = rng.gen_range(0..ids.len());
                        let id = ids.remove(idx);
                        engine.remove_node(id);
                    }
                }
                4 => { // History
                    let state = engine.serialize_scene();
                    history.push_state(state);
                }
                5 => { // Undo
                    let current = engine.serialize_scene();
                    if let Some(prev) = history.undo(current) {
                        engine.deserialize_scene(&prev);
                        // Re-sync ids list (simplification)
                        ids = engine.scene.nodes.keys().cloned().collect();
                    }
                }
                _ => {}
            }
            
            // Periodically check consistency
            if i % 100 == 0 {
                // All nodes in root_nodes or children must exist in nodes map
                for &id in &engine.scene.root_nodes {
                    assert!(engine.scene.nodes.contains_key(&id));
                }
                for node in engine.scene.nodes.values() {
                    for &child_id in &node.children {
                        assert!(engine.scene.nodes.contains_key(&child_id));
                        assert_eq!(engine.scene.nodes.get(&child_id).unwrap().parent, Some(node.id));
                    }
                }
            }
        }
    }

    #[test]
    fn test_visible_nodes_partial_overlap() {
        let mut engine = Engine::new();
        // Rect at (50, 50) with size 100x100 -> covers (50,50)-(150,150)
        let id = engine.add_rect(50.0, 50.0, 100.0, 100.0);
        
        // Viewport (0,0)-(100,100) partially overlaps the rect
        let visible = engine.get_visible_nodes(0.0, 0.0, 100.0, 100.0);
        assert!(visible.contains(&id), "Partially visible nodes must be returned");
        
        // Viewport fully contains the rect
        let visible2 = engine.get_visible_nodes(0.0, 0.0, 200.0, 200.0);
        assert!(visible2.contains(&id));
        
        // Viewport doesn't overlap at all
        let visible3 = engine.get_visible_nodes(200.0, 200.0, 300.0, 300.0);
        assert!(!visible3.contains(&id), "Non-overlapping viewport should not contain node");
    }

    #[test]
    fn test_set_parent_updates_spatial_index() {
        let mut engine = Engine::new();
        let parent = engine.add_rect(100.0, 100.0, 50.0, 50.0);
        let child = engine.add_rect(10.0, 10.0, 20.0, 20.0);
        
        // Child is at (10,10) as root, hit test should work there
        assert_eq!(engine.hit_test(15.0, 15.0), Some(child));
        
        // After reparenting, child should be at (110,110) globally
        engine.set_parent(child, Some(parent));
        assert_eq!(engine.hit_test(15.0, 15.0), None, "Should not hit at old position");
        assert_eq!(engine.hit_test(115.0, 115.0), Some(child), "Should hit at new global position");
    }

    #[test]
    fn test_group_bounds_union() {
        let mut engine = Engine::new();
        // Rect A at (0,0) size 100x50 → covers (0,0)-(100,50)
        let a = engine.add_rect(0.0, 0.0, 100.0, 50.0);
        // Rect B at (200,100) size 60x80 → covers (200,100)-(260,180)
        let b = engine.add_rect(200.0, 100.0, 60.0, 80.0);

        let group_id = engine.group_nodes(&format!("[{},{}]", a, b));
        assert!(group_id > 0);

        // Group AABB should be the union: (0,0)-(260,180)
        let bounds = engine.get_node_bounds(group_id);
        assert!(bounds[0] <= 0.1, "minX should be ~0, got {}", bounds[0]);
        assert!(bounds[1] <= 0.1, "minY should be ~0, got {}", bounds[1]);
        assert!((bounds[2] - 260.0).abs() < 1.0, "maxX should be ~260, got {}", bounds[2]);
        assert!((bounds[3] - 180.0).abs() < 1.0, "maxY should be ~180, got {}", bounds[3]);
    }

    #[test]
    fn test_duplicate_group_deep_copies() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 50.0, 50.0);
        let b = engine.add_rect(100.0, 0.0, 50.0, 50.0);

        let group_id = engine.group_nodes(&format!("[{},{}]", a, b));
        let clone_id = engine.duplicate_node(group_id);

        // Clone should exist and be a Group
        let clone_node = engine.scene.nodes.get(&clone_id).unwrap();
        assert!(matches!(clone_node.node_type, NodeType::Group));

        // Clone should have 2 children, all with fresh IDs
        assert_eq!(clone_node.children.len(), 2, "Cloned group should have 2 children");
        for &child_id in &clone_node.children {
            assert_ne!(child_id, a, "Cloned child should have fresh ID");
            assert_ne!(child_id, b, "Cloned child should have fresh ID");
            assert!(engine.scene.nodes.contains_key(&child_id), "Cloned child must exist in nodes");
            let child = engine.scene.nodes.get(&child_id).unwrap();
            assert_eq!(child.parent, Some(clone_id), "Cloned child's parent should be clone");
        }

        // Original children should be unaffected
        assert_eq!(engine.scene.nodes.get(&a).unwrap().parent, Some(group_id));
        assert_eq!(engine.scene.nodes.get(&b).unwrap().parent, Some(group_id));
    }

    #[test]
    fn test_ungroup_nested_preserves_positions() {
        let mut engine = Engine::new();
        let a = engine.add_rect(50.0, 50.0, 30.0, 30.0);
        let b = engine.add_rect(150.0, 150.0, 30.0, 30.0);

        // Record global positions before grouping
        let a_global_before = engine.global_transforms.get(&a).cloned().unwrap();
        let b_global_before = engine.global_transforms.get(&b).cloned().unwrap();

        // Group them
        let inner = engine.group_nodes(&format!("[{},{}]", a, b));
        // Create an outer group containing the inner group
        let c = engine.add_rect(300.0, 300.0, 20.0, 20.0);
        let outer = engine.group_nodes(&format!("[{},{}]", inner, c));

        // Now ungroup the inner group (which is nested inside outer)
        engine.ungroup_node(inner);

        // a and b should have the same global positions as before
        let a_global_after = engine.global_transforms.get(&a).cloned().unwrap();
        let b_global_after = engine.global_transforms.get(&b).cloned().unwrap();

        let a_before = Mat3::from_cols_array(&a_global_before);
        let a_after = Mat3::from_cols_array(&a_global_after);
        assert!((a_before.z_axis.x - a_after.z_axis.x).abs() < 1.0,
            "a global X should be preserved: before={}, after={}", a_before.z_axis.x, a_after.z_axis.x);
        assert!((a_before.z_axis.y - a_after.z_axis.y).abs() < 1.0,
            "a global Y should be preserved: before={}, after={}", a_before.z_axis.y, a_after.z_axis.y);

        let b_before = Mat3::from_cols_array(&b_global_before);
        let b_after = Mat3::from_cols_array(&b_global_after);
        assert!((b_before.z_axis.x - b_after.z_axis.x).abs() < 1.0,
            "b global X should be preserved");
        assert!((b_before.z_axis.y - b_after.z_axis.y).abs() < 1.0,
            "b global Y should be preserved");

        // a and b should now be children of outer (not root)
        assert_eq!(engine.scene.nodes.get(&a).unwrap().parent, Some(outer));
        assert_eq!(engine.scene.nodes.get(&b).unwrap().parent, Some(outer));
    }

    #[test]
    fn test_group_children_of_group_preserves_positions() {
        let mut engine = Engine::new();
        let a = engine.add_rect(10.0, 10.0, 40.0, 40.0);
        let b = engine.add_rect(100.0, 100.0, 40.0, 40.0);
        let c = engine.add_rect(200.0, 200.0, 40.0, 40.0);

        // Group all three
        let outer = engine.group_nodes(&format!("[{},{},{}]", a, b, c));

        // Record global positions
        let a_global = Mat3::from_cols_array(&engine.global_transforms[&a]);
        let b_global = Mat3::from_cols_array(&engine.global_transforms[&b]);

        // Now group a and b (children of outer) into a sub-group
        let sub_group = engine.group_nodes(&format!("[{},{}]", a, b));

        // a and b should still be at the same global positions
        let a_after = Mat3::from_cols_array(&engine.global_transforms[&a]);
        let b_after = Mat3::from_cols_array(&engine.global_transforms[&b]);

        assert!((a_global.z_axis.x - a_after.z_axis.x).abs() < 1.0,
            "a global X should be preserved after sub-grouping");
        assert!((a_global.z_axis.y - a_after.z_axis.y).abs() < 1.0,
            "a global Y should be preserved after sub-grouping");
        assert!((b_global.z_axis.x - b_after.z_axis.x).abs() < 1.0,
            "b global X should be preserved after sub-grouping");

        // sub_group should be a child of outer
        assert_eq!(engine.scene.nodes.get(&sub_group).unwrap().parent, Some(outer));
    }

    #[test]
    fn test_hit_test_grouped() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 100.0, 100.0);
        let b = engine.add_rect(200.0, 0.0, 100.0, 100.0);

        let group_id = engine.group_nodes(&format!("[{},{}]", a, b));

        // Raw hit_test should return the leaf (rect a)
        let raw_hit = engine.hit_test(50.0, 50.0);
        assert_eq!(raw_hit, Some(a), "Raw hit test should return leaf node");

        // hit_test_grouped should return the group
        let grouped_hit = engine.hit_test_grouped(50.0, 50.0);
        assert_eq!(grouped_hit, Some(group_id), "Grouped hit test should return group");

        // Hit on rect b should also return the group
        let grouped_hit_b = engine.hit_test_grouped(250.0, 50.0);
        assert_eq!(grouped_hit_b, Some(group_id), "Grouped hit on b should return group");

        // Miss should return None
        assert_eq!(engine.hit_test_grouped(500.0, 500.0), None);
    }

    #[test]
    fn test_dedup_selection() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 50.0, 50.0);
        let b = engine.add_rect(100.0, 0.0, 50.0, 50.0);

        let group_id = engine.group_nodes(&format!("[{},{}]", a, b));

        // Selecting group and its child 'a': dedup should drop 'a'
        let deduped = engine.dedup_selection(&format!("[{},{}]", group_id, a));
        assert_eq!(deduped, vec![group_id], "Dedup should drop child when parent is selected");

        // Selecting only leaves: both should remain
        let deduped2 = engine.dedup_selection(&format!("[{},{}]", a, b));
        assert_eq!(deduped2.len(), 2, "Dedup should keep both when neither is ancestor");
    }

    #[test]
    fn test_path_hit_precise_triangle() {
        let mut engine = Engine::new();
        // Right triangle with vertices (0,0), (100,0), (0,100).
        // Its bbox is (0,0)-(100,100), but the region near (90,90) is OUTSIDE.
        let subpaths = r#"[{"points":[
            {"x":0,"y":0,"cp1":[0,0],"cp2":[0,0]},
            {"x":100,"y":0,"cp1":[100,0],"cp2":[100,0]},
            {"x":0,"y":100,"cp1":[0,100],"cp2":[0,100]}
        ],"closed":true}]"#;
        let id = engine.add_path(subpaths);

        assert_eq!(engine.hit_test(20.0, 20.0), Some(id), "inside the triangle");
        assert_eq!(engine.hit_test(90.0, 90.0), None, "bbox corner outside the triangle must miss");
        // On the hypotenuse (stroke) — should hit
        assert_eq!(engine.hit_test(50.0, 50.0), Some(id), "point on the hypotenuse stroke");
    }

    #[test]
    fn test_path_hit_open_stroke_only() {
        let mut engine = Engine::new();
        // Open diagonal line from (0,0) to (100,100), no fill.
        let subpaths = r#"[{"points":[
            {"x":0,"y":0,"cp1":[0,0],"cp2":[0,0]},
            {"x":100,"y":100,"cp1":[100,100],"cp2":[100,100]}
        ],"closed":false}]"#;
        let id = engine.add_path(subpaths);
        // Remove the fill so only the stroke hits
        let style = r#"{"fill":null,"stroke":{"r":0,"g":0,"b":0,"a":1},"stroke_width":2.0,
            "opacity":1.0,"stroke_cap":0,"stroke_join":0,"dash_array":[],"dash_offset":0,
            "corner_radius":0,"blend_mode":0,"fill_rule":0,"miter_limit":4.0,"fill_opacity":1.0}"#;
        engine.set_node_style(id, style);

        assert_eq!(engine.hit_test(50.0, 50.0), Some(id), "on the line");
        assert_eq!(engine.hit_test(50.0, 53.0), Some(id), "within tolerance of the line");
        assert_eq!(engine.hit_test(30.0, 70.0), None, "inside bbox but far from the line");
    }

    #[test]
    fn test_path_hit_donut_even_odd() {
        let mut engine = Engine::new();
        // Outer square (0,0)-(100,100) and inner square (30,30)-(70,70) hole.
        let subpaths = r#"[
            {"points":[
                {"x":0,"y":0,"cp1":[0,0],"cp2":[0,0]},
                {"x":100,"y":0,"cp1":[100,0],"cp2":[100,0]},
                {"x":100,"y":100,"cp1":[100,100],"cp2":[100,100]},
                {"x":0,"y":100,"cp1":[0,100],"cp2":[0,100]}
            ],"closed":true},
            {"points":[
                {"x":30,"y":30,"cp1":[30,30],"cp2":[30,30]},
                {"x":70,"y":30,"cp1":[70,30],"cp2":[70,30]},
                {"x":70,"y":70,"cp1":[70,70],"cp2":[70,70]},
                {"x":30,"y":70,"cp1":[30,70],"cp2":[30,70]}
            ],"closed":true}
        ]"#;
        let id = engine.add_path(subpaths);
        // Even-odd fill rule, no stroke (so the hole isn't hit via stroke reach)
        let style = r#"{"fill":{"r":0,"g":0,"b":0,"a":1},"stroke":null,"stroke_width":0.0,
            "opacity":1.0,"stroke_cap":0,"stroke_join":0,"dash_array":[],"dash_offset":0,
            "corner_radius":0,"blend_mode":0,"fill_rule":1,"miter_limit":4.0,"fill_opacity":1.0}"#;
        engine.set_node_style(id, style);

        assert_eq!(engine.hit_test(15.0, 50.0), Some(id), "in the ring");
        assert_eq!(engine.hit_test(50.0, 50.0), None, "center of the hole must miss");
    }

    #[test]
    fn test_group_resize_scales_children() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 50.0, 50.0);
        let b = engine.add_rect(150.0, 150.0, 50.0, 50.0);
        let group_id = engine.group_nodes(&format!("[{},{}]", a, b));

        // Group bounds: (0,0)-(200,200). Resize to 100x100 → everything halves.
        engine.resize_node(group_id, 100.0, 100.0);

        let gb = engine.get_node_bounds(group_id);
        assert!((gb[0] - 0.0).abs() < 0.5 && (gb[1] - 0.0).abs() < 0.5,
            "anchor (top-left) stays fixed, got {:?}", gb);
        assert!((gb[2] - 100.0).abs() < 0.5 && (gb[3] - 100.0).abs() < 0.5,
            "new bounds must be 100x100, got {:?}", gb);

        // Child b was at (150,150)-(200,200) → now (75,75)-(100,100)
        let bb = engine.get_node_bounds(b);
        assert!((bb[0] - 75.0).abs() < 0.5 && (bb[2] - 100.0).abs() < 0.5,
            "child scales with the group, got {:?}", bb);

        // Hit-testing still works at the new positions
        assert_eq!(engine.hit_test_grouped(90.0, 90.0), Some(group_id));
        assert_eq!(engine.hit_test(150.0, 150.0), None, "old position must miss");
    }

    #[test]
    fn test_rotate_preserves_scale() {
        let mut engine = Engine::new();
        let a = engine.add_rect(0.0, 0.0, 50.0, 50.0);
        let b = engine.add_rect(150.0, 150.0, 50.0, 50.0);
        let group_id = engine.group_nodes(&format!("[{},{}]", a, b));

        // Bake a 2x scale into the group transform, then rotate it.
        engine.resize_node(group_id, 400.0, 400.0);
        engine.rotate_node(group_id, std::f32::consts::FRAC_PI_4);

        // The linear part must still have magnitude 2 on both axes —
        // rotation must not reset the scale that resize_group applied.
        let node = engine.scene.nodes.get(&group_id).unwrap();
        let m = Mat3::from_cols_array(&node.transform);
        let sx = (m.x_axis.x * m.x_axis.x + m.x_axis.y * m.x_axis.y).sqrt();
        let sy = (m.y_axis.x * m.y_axis.x + m.y_axis.y * m.y_axis.y).sqrt();
        assert!((sx - 2.0).abs() < 1e-3, "x scale lost by rotate: {}", sx);
        assert!((sy - 2.0).abs() < 1e-3, "y scale lost by rotate: {}", sy);

        // Both children sit on the main diagonal, so at 45° they line up
        // along the y axis: the far corner of child b (local 200,200 →
        // scaled 400,400) rotates to (0, 400·√2). If the rotate had reset
        // the scale, this span would be 200·√2 instead.
        let gb = engine.get_node_bounds(group_id);
        let h = gb[3] - gb[1];
        assert!((h - 400.0 * std::f32::consts::SQRT_2).abs() < 1.0,
            "rotated bounds must reflect the preserved 2x scale, got {}", h);
    }

    #[test]
    fn test_snapshot_roundtrip_with_paths_and_fills() {
        // Regression: `skip_serializing_if` on network fields corrupted the
        // positional bincode stream, so undo/drag snapshots silently failed
        // for any scene containing a Path node.
        let mut engine = Engine::new();
        let path_id = engine.add_path(
            r#"[{"closed":true,"points":[
                {"x":100.0,"y":100.0,"cp1":[100.0,100.0],"cp2":[100.0,100.0]},
                {"x":400.0,"y":100.0,"cp1":[400.0,100.0],"cp2":[400.0,100.0]},
                {"x":400.0,"y":400.0,"cp1":[400.0,400.0],"cp2":[400.0,400.0]}
            ]}]"#,
        );
        // Compute faces and fill one, so the planar network has content too
        let face = engine.query_face_at(300.0, 200.0);
        assert!(face >= 0, "expected a face inside the triangle");
        engine.set_face_fill(face as u32, 1.0, 0.0, 0.0, 1.0);

        let snapshot = engine.serialize_scene();
        engine.move_node(path_id, 50.0, 50.0);
        engine.set_face_fill(face as u32, 0.0, 1.0, 0.0, 1.0);

        assert!(engine.deserialize_scene(&snapshot), "snapshot must decode");

        let b = engine.get_node_bounds(path_id);
        assert!((b[0] - 100.0).abs() < 0.5, "position must be restored, got {:?}", b);
        let filled = engine.get_filled_faces();
        assert!(filled.contains("\"r\":1.0"), "face fill must be restored, got {}", filled);
    }
}
