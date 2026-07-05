use wasm_bindgen::prelude::*;
use glam::{Mat3, Vec2};
use serde::{Serialize, Deserialize};
use std::collections::HashMap;

mod vector_network;
pub use vector_network::VectorNetwork;

mod proto;
pub use proto::FORMAT_VERSION;
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[wasm_bindgen]
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum Geometry {
    Rect { width: f32, height: f32 },
    Ellipse { radius_x: f32, radius_y: f32 },
    Path { points: Vec<PathPoint> },
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
}

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
            },
            next_id: 1,
            global_transforms: HashMap::new(),
            transform_out_buf: [0.0; 9],
            spatial_index: RTree::new(),
            node_to_spatial: HashMap::new(),
            dirty_flags: HashMap::new(),
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
        let points: Vec<PathPoint> = serde_json::from_str(points_json).unwrap_or_default();
        let id = self.next_id;
        self.next_id += 1;

        let node = Node {
            id,
            name: format!("Path {}", id),
            node_type: NodeType::Path,
            transform: Mat3::IDENTITY.to_cols_array(),
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
            geometry: Geometry::Path { points },
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
        for i in 0..=sides {
            let angle = i as f32 * step - std::f32::consts::FRAC_PI_2;
            let px = cx + radius * angle.cos();
            let py = cy + radius * angle.sin();
            points.push(PathPoint {
                x: px,
                y: py,
                cp1: Vec2::new(px, py),
                cp2: Vec2::new(px, py),
            });
        }
        // Close: last point equals first
        if let Some(first) = points.first().cloned() {
            if let Some(last) = points.last_mut() {
                last.x = first.x;
                last.y = first.y;
                last.cp1 = first.cp1;
                last.cp2 = first.cp2;
            }
        }

        let id = self.next_id;
        self.next_id += 1;

        let node = Node {
            id,
            name: format!("Polygon {}", id),
            node_type: NodeType::Path,
            transform: Mat3::IDENTITY.to_cols_array(),
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
            geometry: Geometry::Path { points },
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
        for i in 0..=total_verts {
            let r = if (i % total_verts) % 2 == 0 { outer_r } else { inner_r };
            let angle = i as f32 * step - std::f32::consts::FRAC_PI_2;
            let px = cx + r * angle.cos();
            let py = cy + r * angle.sin();
            points.push(PathPoint {
                x: px,
                y: py,
                cp1: Vec2::new(px, py),
                cp2: Vec2::new(px, py),
            });
        }
        // Close: last point equals first
        if let Some(first) = points.first().cloned() {
            if let Some(last) = points.last_mut() {
                last.x = first.x;
                last.y = first.y;
                last.cp1 = first.cp1;
                last.cp2 = first.cp2;
            }
        }

        let id = self.next_id;
        self.next_id += 1;

        let node = Node {
            id,
            name: format!("Star {}", id),
            node_type: NodeType::Path,
            transform: Mat3::IDENTITY.to_cols_array(),
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
            geometry: Geometry::Path { points },
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

    pub fn update_path_points(&mut self, id: u32, points_json: &str) {
        let points: Vec<PathPoint> = serde_json::from_str(points_json).unwrap_or_default();
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            node.geometry = Geometry::Path { points };
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
                Geometry::Path { ref points } => {
                    if points.is_empty() {
                        AABB::from_corners([0.0, 0.0], [0.0, 0.0])
                    } else {
                        let mut min_x = f32::MAX;
                        let mut min_y = f32::MAX;
                        let mut max_x = f32::MIN;
                        let mut max_y = f32::MIN;
                        for pt in points {
                            // Include anchor point
                            let p = transform.transform_point2(Vec2::new(pt.x, pt.y));
                            min_x = min_x.min(p.x);
                            min_y = min_y.min(p.y);
                            max_x = max_x.max(p.x);
                            max_y = max_y.max(p.y);
                            // Include control points (curve is within convex hull of control polygon)
                            let c1 = transform.transform_point2(pt.cp1);
                            min_x = min_x.min(c1.x);
                            min_y = min_y.min(c1.y);
                            max_x = max_x.max(c1.x);
                            max_y = max_y.max(c1.y);
                            let c2 = transform.transform_point2(pt.cp2);
                            min_x = min_x.min(c2.x);
                            min_y = min_y.min(c2.y);
                            max_x = max_x.max(c2.x);
                            max_y = max_y.max(c2.y);
                        }
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

    pub fn update_all_spatial_indices(&mut self) {
        self.spatial_index = RTree::new();
        self.node_to_spatial.clear();
        let ids: Vec<u32> = self.scene.nodes.keys().cloned().collect();
        for id in ids {
            self.update_spatial_index(id);
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

    pub fn deserialize_scene(&mut self, data: &[u8]) {
        if let Ok(scene) = bincode::deserialize::<Scene>(data) {
            self.scene = scene;
            self.next_id = self.scene.nodes.keys().max().map(|id| id + 1).unwrap_or(1);
            self.update_all_global_transforms();
            self.update_all_spatial_indices();
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
        self.update_spatial_index(id);
        let children = if let Some(node) = self.scene.nodes.get(&id) {
            node.children.clone()
        } else {
            return;
        };
        for child_id in children {
            self.update_spatial_index_recursive(child_id);
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
                    Geometry::Path { ref points } => {
                        if points.is_empty() {
                            false
                        } else {
                            let mut min_x = f32::MAX;
                            let mut min_y = f32::MAX;
                            let mut max_x = f32::MIN;
                            let mut max_y = f32::MIN;
                            for pt in points {
                                min_x = min_x.min(pt.x);
                                min_y = min_y.min(pt.y);
                                max_x = max_x.max(pt.x);
                                max_y = max_y.max(pt.y);
                            }
                            local_point.x >= min_x && local_point.x <= max_x &&
                            local_point.y >= min_y && local_point.y <= max_y
                        }
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
            out.push(id);
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
                    // 4 corners + closing point
                    let points = vec![
                        PathPoint { x: 0.0, y: 0.0, cp1: Vec2::new(0.0, 0.0), cp2: Vec2::new(0.0, 0.0) },
                        PathPoint { x: w,   y: 0.0, cp1: Vec2::new(w, 0.0),   cp2: Vec2::new(w, 0.0) },
                        PathPoint { x: w,   y: h,   cp1: Vec2::new(w, h),     cp2: Vec2::new(w, h) },
                        PathPoint { x: 0.0, y: h,   cp1: Vec2::new(0.0, h),   cp2: Vec2::new(0.0, h) },
                        PathPoint { x: 0.0, y: 0.0, cp1: Vec2::new(0.0, 0.0), cp2: Vec2::new(0.0, 0.0) },
                    ];
                    Some(Geometry::Path { points })
                }
                Geometry::Ellipse { radius_x, radius_y } => {
                    let rx = *radius_x;
                    let ry = *radius_y;
                    // Standard bezier circle approximation: kappa = 4 * (sqrt(2) - 1) / 3
                    let k: f32 = 0.5522847498;
                    let kx = rx * k;
                    let ky = ry * k;
                    // 4 cardinal points + closing, with cubic bezier control points
                    let points = vec![
                        // Top (0, -ry)
                        PathPoint { x: 0.0, y: -ry, cp1: Vec2::new(-kx, -ry), cp2: Vec2::new(kx, -ry) },
                        // Right (rx, 0)
                        PathPoint { x: rx,  y: 0.0, cp1: Vec2::new(rx, -ky),  cp2: Vec2::new(rx, ky) },
                        // Bottom (0, ry)
                        PathPoint { x: 0.0, y: ry,  cp1: Vec2::new(kx, ry),   cp2: Vec2::new(-kx, ry) },
                        // Left (-rx, 0)
                        PathPoint { x: -rx, y: 0.0, cp1: Vec2::new(-rx, ky),  cp2: Vec2::new(-rx, -ky) },
                        // Close back to top
                        PathPoint { x: 0.0, y: -ry, cp1: Vec2::new(-kx, -ry), cp2: Vec2::new(kx, -ry) },
                    ];
                    Some(Geometry::Path { points })
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
                Geometry::Path { points } => {
                    // Scale path points proportionally using full bounds (including control points)
                    if points.is_empty() { return; }
                    let mut min_x = f32::MAX; let mut min_y = f32::MAX;
                    let mut max_x = f32::MIN; let mut max_y = f32::MIN;
                    for pt in points.iter() {
                        min_x = min_x.min(pt.x).min(pt.cp1.x).min(pt.cp2.x);
                        min_y = min_y.min(pt.y).min(pt.cp1.y).min(pt.cp2.y);
                        max_x = max_x.max(pt.x).max(pt.cp1.x).max(pt.cp2.x);
                        max_y = max_y.max(pt.y).max(pt.cp1.y).max(pt.cp2.y);
                    }
                    let old_w = (max_x - min_x).max(1.0);
                    let old_h = (max_y - min_y).max(1.0);
                    let sx = new_w / old_w;
                    let sy = new_h / old_h;
                    for pt in points.iter_mut() {
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
                Geometry::Text { .. } => {}
            }
            self.update_spatial_index(id);
            self.mark_dirty(id);
        }
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
            self.mark_dirty(id);
        }
    }

    /// Apply a rotation (in radians) to a node's local transform.
    pub fn rotate_node(&mut self, id: u32, angle_rad: f32) {
        if let Some(node) = self.scene.nodes.get_mut(&id) {
            let old = Mat3::from_cols_array(&node.transform);
            let tx = old.z_axis.x;
            let ty = old.z_axis.y;
            let rotation = Mat3::from_angle(angle_rad);
            let new_transform = Mat3::from_translation(Vec2::new(tx, ty)) * rotation;
            node.transform = new_transform.to_cols_array();
            self.update_node_global_transform(id);
            self.update_spatial_index_recursive(id);
            self.mark_dirty(id);
        }
    }

    /// Duplicate a node and return the new id.
    pub fn duplicate_node(&mut self, id: u32) -> u32 {
        let new_id = self.next_id;
        self.next_id += 1;

        if let Some(node) = self.scene.nodes.get(&id).cloned() {
            let mut new_node = node;
            new_node.id = new_id;
            new_node.name = format!("{} copy", new_node.name);
            // Offset position by 20px
            let mut t = Mat3::from_cols_array(&new_node.transform);
            t.z_axis.x += 20.0;
            t.z_axis.y += 20.0;
            new_node.transform = t.to_cols_array();
            new_node.parent = None;
            new_node.children = Vec::new();

            self.scene.nodes.insert(new_id, new_node);
            self.scene.root_nodes.push(new_id);
            self.update_node_global_transform(new_id);
            self.update_spatial_index(new_id);
            self.mark_dirty(new_id);
        }
        new_id
    }

    /// Group selected nodes into a new Group node. Returns the group's id.
    pub fn group_nodes(&mut self, ids_json: &str) -> u32 {
        let ids: Vec<u32> = serde_json::from_str(ids_json).unwrap_or_default();
        if ids.is_empty() { return 0; }

        let group_id = self.next_id;
        self.next_id += 1;

        // Compute the group center (average of node positions)
        let mut sum_x = 0.0f32;
        let mut sum_y = 0.0f32;
        let mut count = 0;
        for &id in &ids {
            if let Some(transform) = self.global_transforms.get(&id) {
                let m = Mat3::from_cols_array(transform);
                sum_x += m.z_axis.x;
                sum_y += m.z_axis.y;
                count += 1;
            }
        }
        let cx = if count > 0 { sum_x / count as f32 } else { 0.0 };
        let cy = if count > 0 { sum_y / count as f32 } else { 0.0 };

        let group_node = Node {
            id: group_id,
            name: format!("Group {}", group_id),
            node_type: NodeType::Group,
            transform: Mat3::from_translation(Vec2::new(cx, cy)).to_cols_array(),
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
            parent: None,
            visible: true,
            locked: false,
        };
        self.scene.nodes.insert(group_id, group_node);
        self.scene.root_nodes.push(group_id);

        // Reparent nodes — adjust their local transforms to be relative to group
        for &id in &ids {
            if let Some(node) = self.scene.nodes.get_mut(&id) {
                let mut t = Mat3::from_cols_array(&node.transform);
                t.z_axis.x -= cx;
                t.z_axis.y -= cy;
                node.transform = t.to_cols_array();
            }
            self.set_parent(id, Some(group_id));
        }

        self.update_node_global_transform(group_id);
        self.update_spatial_index(group_id);
        self.mark_dirty(group_id);
        group_id
    }

    /// Ungroup a group node, promoting its children to the parent level.
    pub fn ungroup_node(&mut self, id: u32) {
        let (children, group_transform) = if let Some(node) = self.scene.nodes.get(&id) {
            if !matches!(node.node_type, NodeType::Group) { return; }
            (node.children.clone(), Mat3::from_cols_array(&node.transform))
        } else {
            return;
        };

        // Move children to root, adjusting their transforms
        for child_id in &children {
            if let Some(child) = self.scene.nodes.get_mut(child_id) {
                let child_t = Mat3::from_cols_array(&child.transform);
                let new_t = group_transform * child_t;
                child.transform = new_t.to_cols_array();
                child.parent = None;
            }
            self.scene.root_nodes.push(*child_id);
        }

        // Remove the group node itself
        if let Some(group) = self.scene.nodes.get_mut(&id) {
            group.children.clear();
        }
        self.scene.nodes.remove(&id);
        self.scene.root_nodes.retain(|&r| r != id);
        self.global_transforms.remove(&id);
        if let Some(old) = self.node_to_spatial.remove(&id) {
            self.spatial_index.remove(&old);
        }

        // Update children transforms and spatial indices
        for child_id in &children {
            self.update_node_global_transform(*child_id);
            self.update_spatial_index_recursive(*child_id);
            self.mark_dirty(*child_id);
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
}
