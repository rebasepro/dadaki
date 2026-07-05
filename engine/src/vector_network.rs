use glam::Vec2;
use ordered_float::OrderedFloat;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::{Color, Engine, Geometry, PathPoint};

/// Compute the centroid of a face's boundary polygon.
pub fn face_centroid(face: &PlanarFace) -> Vec2 {
    polygon_centroid(&face.boundary_polygon)
}

// ─── Data Structures ───────────────────────────────────────────────────────────

/// A vertex in the planar graph.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlanarVertex {
    pub id: u32,
    pub position: Vec2,
    /// Outgoing edge IDs, sorted radially (CCW).
    pub outgoing_edges: Vec<u32>,
}

/// A directed half-edge in the planar graph.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlanarEdge {
    pub id: u32,
    pub from_vertex: u32,
    pub to_vertex: u32,
    /// Polyline approximation of this edge segment (for rendering).
    pub polyline: Vec<Vec2>,
    /// Source node this edge was derived from.
    pub source_node: u32,
    /// Twin/opposite half-edge ID.
    pub twin: u32,
    /// Which face this directed half-edge borders (left side).
    pub face: Option<u32>,
}

/// An enclosed region (face) in the planar graph.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlanarFace {
    pub id: u32,
    /// Ordered list of half-edge IDs forming this face's boundary.
    pub boundary_edges: Vec<u32>,
    /// Fill color assigned by the user.
    pub fill: Option<Color>,
    /// Cached boundary polygon vertices for hit-testing and rendering.
    pub boundary_polygon: Vec<[f32; 2]>,
    /// Signed area (negative = clockwise = outer face).
    pub signed_area: f64,
    /// Is this the unbounded outer face?
    pub is_outer: bool,
}

/// The planar graph computed from overlapping scene paths.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VectorNetwork {
    pub vertices: HashMap<u32, PlanarVertex>,
    pub edges: HashMap<u32, PlanarEdge>,
    pub faces: HashMap<u32, PlanarFace>,
    pub next_id: u32,
    /// Gap tolerance in world units.
    pub gap_tolerance: f32,
    /// Whether the graph needs recomputation.
    pub dirty: bool,
    /// Pending face fills from file load — applied on first rebuild.
    #[serde(default)]
    pub pending_fills: Vec<(Vec2, Color)>,
}

impl Default for VectorNetwork {
    fn default() -> Self {
        Self {
            vertices: HashMap::new(),
            edges: HashMap::new(),
            faces: HashMap::new(),
            next_id: 1,
            gap_tolerance: 2.0,
            dirty: true,
            pending_fills: Vec::new(),
        }
    }
}

impl VectorNetwork {
    fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn clear(&mut self) {
        // Preserve face fills for re-mapping after rebuild
        self.vertices.clear();
        self.edges.clear();
        // faces cleared separately after centroid matching
        self.next_id = 1;
    }
}

// ─── Bezier Flattening ─────────────────────────────────────────────────────────

/// Flatten a cubic bezier (p0→p1→p2→p3) into a polyline via adaptive de Casteljau.
/// Pushes interior and end points into `out` (caller seeds `out` with p0).
pub(crate) fn flatten_cubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tolerance: f32, out: &mut Vec<Vec2>) {
    // Check if the curve is flat enough
    let d1 = (p1 - p0).length() + (p2 - p1).length() + (p3 - p2).length();
    let d2 = (p3 - p0).length();
    if (d1 - d2) < tolerance {
        out.push(p3);
        return;
    }
    // Subdivide
    let m01 = (p0 + p1) * 0.5;
    let m12 = (p1 + p2) * 0.5;
    let m23 = (p2 + p3) * 0.5;
    let m012 = (m01 + m12) * 0.5;
    let m123 = (m12 + m23) * 0.5;
    let mid = (m012 + m123) * 0.5;
    flatten_cubic(p0, m01, m012, mid, tolerance, out);
    flatten_cubic(mid, m123, m23, p3, tolerance, out);
}

/// Convert a Path's points into a list of polyline segments.
/// Each segment is a pair of consecutive polyline points.
fn path_to_segments(points: &[PathPoint], node_id: u32) -> Vec<(Vec2, Vec2, u32)> {
    let mut segments = Vec::new();
    if points.len() < 2 {
        return segments;
    }
    for i in 0..points.len() - 1 {
        let p0 = Vec2::new(points[i].x, points[i].y);
        let p1 = points[i].cp2;
        let p2 = points[i + 1].cp1;
        let p3 = Vec2::new(points[i + 1].x, points[i + 1].y);

        let mut polyline = vec![p0];
        flatten_cubic(p0, p1, p2, p3, 0.5, &mut polyline);

        for j in 0..polyline.len() - 1 {
            segments.push((polyline[j], polyline[j + 1], node_id));
        }
    }
    segments
}

/// Convert a Rect to 4 line segments.
fn rect_to_segments(w: f32, h: f32, transform: &[f32; 9], node_id: u32) -> Vec<(Vec2, Vec2, u32)> {
    let corners_local = [
        Vec2::new(0.0, 0.0),
        Vec2::new(w, 0.0),
        Vec2::new(w, h),
        Vec2::new(0.0, h),
    ];
    let corners: Vec<Vec2> = corners_local.iter().map(|p| transform_point(*p, transform)).collect();
    vec![
        (corners[0], corners[1], node_id),
        (corners[1], corners[2], node_id),
        (corners[2], corners[3], node_id),
        (corners[3], corners[0], node_id),
    ]
}

/// Convert an Ellipse to polyline segments (approximated with 32 segments).
fn ellipse_to_segments(rx: f32, ry: f32, transform: &[f32; 9], node_id: u32) -> Vec<(Vec2, Vec2, u32)> {
    let n = 32;
    let mut pts = Vec::with_capacity(n);
    for i in 0..n {
        let angle = 2.0 * std::f32::consts::PI * (i as f32) / (n as f32);
        let local = Vec2::new(rx * angle.cos(), ry * angle.sin());
        pts.push(transform_point(local, transform));
    }
    let mut segments = Vec::new();
    for i in 0..n {
        segments.push((pts[i], pts[(i + 1) % n], node_id));
    }
    segments
}

fn transform_point(p: Vec2, t: &[f32; 9]) -> Vec2 {
    // t is column-major Mat3
    Vec2::new(
        t[0] * p.x + t[3] * p.y + t[6],
        t[1] * p.x + t[4] * p.y + t[7],
    )
}

// ─── Segment-Segment Intersection ──────────────────────────────────────────────

/// Find the intersection point of two line segments, if any.
/// Returns the parameter t for seg1 (0..1) and the intersection point.
fn segment_intersection(
    a1: Vec2, a2: Vec2,
    b1: Vec2, b2: Vec2,
) -> Option<(f32, f32, Vec2)> {
    let d1 = a2 - a1;
    let d2 = b2 - b1;
    let cross = d1.x * d2.y - d1.y * d2.x;
    if cross.abs() < 1e-10 {
        return None; // Parallel
    }
    let d = b1 - a1;
    let t = (d.x * d2.y - d.y * d2.x) / cross;
    let u = (d.x * d1.y - d.y * d1.x) / cross;

    const EPS: f32 = 1e-6;
    if t > EPS && t < 1.0 - EPS && u > EPS && u < 1.0 - EPS {
        let point = a1 + d1 * t;
        Some((t, u, point))
    } else {
        None
    }
}

// ─── Core Algorithm ────────────────────────────────────────────────────────────

impl VectorNetwork {
    /// Rebuild the entire planar graph from the given scene segments.
    pub fn rebuild(&mut self, engine_segments: Vec<(Vec2, Vec2, u32)>) {
        // Save old face fills for re-mapping
        let old_faces: Vec<(Vec2, Option<Color>)> = self.faces.values()
            .filter(|f| f.fill.is_some() && !f.is_outer)
            .map(|f| {
                let centroid = polygon_centroid(&f.boundary_polygon);
                (centroid, f.fill.clone())
            })
            .collect();

        self.clear();
        self.faces.clear();

        if engine_segments.is_empty() {
            self.dirty = false;
            return;
        }

        // Step 1: Find all intersections and split segments
        let split_segments = self.find_intersections_and_split(engine_segments);

        if split_segments.is_empty() {
            self.dirty = false;
            return;
        }

        // Step 2: Build vertices (merge endpoints within gap tolerance)
        let (vertex_map, segments_remapped) = self.build_vertices(split_segments);
        let _ = vertex_map; // used internally by build_vertices

        if segments_remapped.is_empty() {
            self.dirty = false;
            return;
        }

        // Step 3: Create half-edges
        self.create_half_edges(segments_remapped);

        // Step 4: Sort outgoing edges radially at each vertex
        self.sort_edges_radially();

        // Step 5: Detect faces via left-hand turn traversal
        self.detect_faces();

        // Step 6: Re-map old fills to new faces by centroid proximity
        self.remap_fills(old_faces);

        self.dirty = false;
    }

    fn find_intersections_and_split(&self, segments: Vec<(Vec2, Vec2, u32)>) -> Vec<(Vec2, Vec2, u32)> {
        // Simple O(n²) for now; Bentley-Ottmann can optimize later
        let n = segments.len();
        // Collect all intersection events: (segment_index, t_parameter, intersection_point)
        let mut splits: Vec<Vec<(f32, Vec2)>> = vec![Vec::new(); n];

        for i in 0..n {
            for j in (i + 1)..n {
                if let Some((t, u, pt)) = segment_intersection(
                    segments[i].0, segments[i].1,
                    segments[j].0, segments[j].1,
                ) {
                    splits[i].push((t, pt));
                    splits[j].push((u, pt));
                }
            }
        }

        // Split each segment at its intersection points
        let mut result = Vec::new();
        for (i, seg) in segments.iter().enumerate() {
            if splits[i].is_empty() {
                result.push(*seg);
            } else {
                // Sort by parameter
                let mut pts = splits[i].clone();
                pts.sort_by_key(|(t, _)| OrderedFloat(*t));
                // Split
                let mut prev = seg.0;
                for (_, pt) in &pts {
                    if (*pt - prev).length() > 1e-6 {
                        result.push((prev, *pt, seg.2));
                    }
                    prev = *pt;
                }
                if (seg.1 - prev).length() > 1e-6 {
                    result.push((prev, seg.1, seg.2));
                }
            }
        }
        result
    }

    fn build_vertices(&mut self, segments: Vec<(Vec2, Vec2, u32)>) -> (HashMap<OrderedVec2, u32>, Vec<(u32, u32, u32)>) {
        let tolerance = self.gap_tolerance;
        let mut vertex_map: HashMap<OrderedVec2, u32> = HashMap::new();
        let mut all_points: Vec<Vec2> = Vec::new();

        // Collect all unique endpoints
        for seg in &segments {
            all_points.push(seg.0);
            all_points.push(seg.1);
        }

        // Merge points within tolerance using a simple grid
        let get_or_create_vertex = |pos: Vec2, vn: &mut VectorNetwork, vmap: &mut HashMap<OrderedVec2, u32>| -> u32 {
            // Check if any existing vertex is close enough
            for (_, v) in vn.vertices.iter() {
                if (v.position - pos).length() < tolerance {
                    return v.id;
                }
            }
            let key = OrderedVec2(OrderedFloat(pos.x), OrderedFloat(pos.y));
            if let Some(&id) = vmap.get(&key) {
                return id;
            }
            let id = vn.alloc_id();
            vn.vertices.insert(id, PlanarVertex {
                id,
                position: pos,
                outgoing_edges: Vec::new(),
            });
            vmap.insert(key, id);
            id
        };

        let mut remapped = Vec::new();
        for seg in &segments {
            let from = get_or_create_vertex(seg.0, self, &mut vertex_map);
            let to = get_or_create_vertex(seg.1, self, &mut vertex_map);
            if from != to {
                remapped.push((from, to, seg.2));
            }
        }

        (vertex_map, remapped)
    }

    fn create_half_edges(&mut self, segments: Vec<(u32, u32, u32)>) {
        // Deduplicate: skip if we already have an edge from→to
        let mut seen: HashSet<(u32, u32)> = HashSet::new();

        for (from, to, source_node) in segments {
            if seen.contains(&(from, to)) || seen.contains(&(to, from)) {
                continue;
            }
            seen.insert((from, to));

            let e1_id = self.alloc_id();
            let e2_id = self.alloc_id();

            let from_pos = self.vertices[&from].position;
            let to_pos = self.vertices[&to].position;

            // Forward half-edge
            self.edges.insert(e1_id, PlanarEdge {
                id: e1_id,
                from_vertex: from,
                to_vertex: to,
                polyline: vec![from_pos, to_pos],
                source_node,
                twin: e2_id,
                face: None,
            });

            // Backward half-edge (twin)
            self.edges.insert(e2_id, PlanarEdge {
                id: e2_id,
                from_vertex: to,
                to_vertex: from,
                polyline: vec![to_pos, from_pos],
                source_node,
                twin: e1_id,
                face: None,
            });

            // Register outgoing edges at vertices
            if let Some(v) = self.vertices.get_mut(&from) {
                v.outgoing_edges.push(e1_id);
            }
            if let Some(v) = self.vertices.get_mut(&to) {
                v.outgoing_edges.push(e2_id);
            }
        }
    }

    fn sort_edges_radially(&mut self) {
        let edge_angles: HashMap<u32, f64> = self.edges.iter().map(|(&eid, e)| {
            let from_pos = self.vertices[&e.from_vertex].position;
            let to_pos = self.vertices[&e.to_vertex].position;
            let d = to_pos - from_pos;
            let angle = (d.y as f64).atan2(d.x as f64);
            (eid, angle)
        }).collect();

        for v in self.vertices.values_mut() {
            v.outgoing_edges.sort_by(|a, b| {
                let angle_a = edge_angles.get(a).copied().unwrap_or(0.0);
                let angle_b = edge_angles.get(b).copied().unwrap_or(0.0);
                angle_a.partial_cmp(&angle_b).unwrap_or(std::cmp::Ordering::Equal)
            });
        }
    }

    fn detect_faces(&mut self) {
        let mut visited: HashSet<u32> = HashSet::new();
        let edge_ids: Vec<u32> = self.edges.keys().copied().collect();

        for start_edge_id in edge_ids {
            if visited.contains(&start_edge_id) {
                continue;
            }

            let mut face_edges = Vec::new();
            let mut current = start_edge_id;
            let max_steps = self.edges.len() + 1;
            let mut steps = 0;

            loop {
                if visited.contains(&current) && !face_edges.is_empty() {
                    // If we hit a visited edge that's our start, we found a face
                    if current == start_edge_id {
                        break;
                    }
                    // Otherwise this path leads nowhere useful
                    face_edges.clear();
                    break;
                }

                visited.insert(current);
                face_edges.push(current);

                // Get the twin of current edge, then find next edge CCW at that vertex
                let edge = match self.edges.get(&current) {
                    Some(e) => e.clone(),
                    None => break,
                };
                let twin_id = edge.twin;
                let twin = match self.edges.get(&twin_id) {
                    Some(e) => e.clone(),
                    None => break,
                };

                // At the vertex where twin starts (= edge.to_vertex), find the next edge
                // after twin in the radial order (this implements the left-hand turn rule)
                let vertex = match self.vertices.get(&twin.from_vertex) {
                    Some(v) => v,
                    None => break,
                };

                let twin_pos = vertex.outgoing_edges.iter().position(|&e| e == twin_id);
                current = match twin_pos {
                    Some(pos) => {
                        // Next edge in CW order = previous in our CCW-sorted list
                        let n = vertex.outgoing_edges.len();
                        if n == 0 { break; }
                        let next_idx = (pos + n - 1) % n;
                        vertex.outgoing_edges[next_idx]
                    }
                    None => break,
                };

                steps += 1;
                if steps > max_steps {
                    face_edges.clear();
                    break;
                }
            }

            if face_edges.len() >= 3 {
                // Build boundary polygon
                let mut polygon = Vec::new();
                for &eid in &face_edges {
                    if let Some(e) = self.edges.get(&eid) {
                        let pos = self.vertices[&e.from_vertex].position;
                        polygon.push([pos.x, pos.y]);
                    }
                }

                let area = signed_polygon_area(&polygon);
                let face_id = self.alloc_id();

                let face = PlanarFace {
                    id: face_id,
                    boundary_edges: face_edges.clone(),
                    fill: None,
                    boundary_polygon: polygon,
                    signed_area: area,
                    is_outer: area < 0.0, // CW winding = outer face
                };

                // Assign face to all its edges
                for &eid in &face_edges {
                    if let Some(e) = self.edges.get_mut(&eid) {
                        e.face = Some(face_id);
                    }
                }

                self.faces.insert(face_id, face);
            }
        }
    }

    fn remap_fills(&mut self, old_faces: Vec<(Vec2, Option<Color>)>) {
        let all_fills: Vec<(Vec2, Option<Color>)> = old_faces.into_iter()
            .chain(self.pending_fills.drain(..).map(|(c, color)| (c, Some(color))))
            .collect();

        if all_fills.is_empty() {
            return;
        }
        for (old_centroid, fill) in &all_fills {
            // Find the new face whose centroid is closest
            let mut best_face: Option<u32> = None;
            let mut best_dist = f32::MAX;
            for (fid, face) in &self.faces {
                if face.is_outer || face.fill.is_some() {
                    continue;
                }
                let centroid = polygon_centroid(&face.boundary_polygon);
                let dist = (*old_centroid - centroid).length();
                if dist < best_dist {
                    best_dist = dist;
                    best_face = Some(*fid);
                }
            }
            if let Some(fid) = best_face {
                if best_dist < 50.0 {
                    // Only re-map if centroid is reasonably close
                    if let Some(face) = self.faces.get_mut(&fid) {
                        face.fill = fill.clone();
                    }
                }
            }
        }
    }

    /// Query which face contains the given point.
    pub fn query_face_at(&self, x: f32, y: f32) -> Option<u32> {
        let point = [x, y];
        // Find the smallest non-outer face containing the point
        let mut best: Option<(u32, f64)> = None;
        for (fid, face) in &self.faces {
            if face.is_outer {
                continue;
            }
            if point_in_polygon(&point, &face.boundary_polygon) {
                let area = face.signed_area.abs();
                match best {
                    Some((_, best_area)) if area < best_area => {
                        best = Some((*fid, area));
                    }
                    None => {
                        best = Some((*fid, area));
                    }
                    _ => {}
                }
            }
        }
        best.map(|(id, _)| id)
    }
}

// ─── Geometry Helpers ──────────────────────────────────────────────────────────

#[derive(Hash, Eq, PartialEq, Clone)]
struct OrderedVec2(OrderedFloat<f32>, OrderedFloat<f32>);

fn signed_polygon_area(polygon: &[[f32; 2]]) -> f64 {
    let n = polygon.len();
    if n < 3 {
        return 0.0;
    }
    let mut area = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        area += polygon[i][0] as f64 * polygon[j][1] as f64;
        area -= polygon[j][0] as f64 * polygon[i][1] as f64;
    }
    area * 0.5
}

fn polygon_centroid(polygon: &[[f32; 2]]) -> Vec2 {
    if polygon.is_empty() {
        return Vec2::ZERO;
    }
    let mut cx = 0.0_f32;
    let mut cy = 0.0_f32;
    for p in polygon {
        cx += p[0];
        cy += p[1];
    }
    let n = polygon.len() as f32;
    Vec2::new(cx / n, cy / n)
}

/// Winding number point-in-polygon test.
fn point_in_polygon(point: &[f32; 2], polygon: &[[f32; 2]]) -> bool {
    let n = polygon.len();
    if n < 3 {
        return false;
    }
    let mut winding = 0i32;
    let px = point[0] as f64;
    let py = point[1] as f64;
    for i in 0..n {
        let j = (i + 1) % n;
        let y0 = polygon[i][1] as f64;
        let y1 = polygon[j][1] as f64;
        if y0 <= py {
            if y1 > py {
                let x0 = polygon[i][0] as f64;
                let x1 = polygon[j][0] as f64;
                let cross = (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0);
                if cross > 0.0 {
                    winding += 1;
                }
            }
        } else if y1 <= py {
            let x0 = polygon[i][0] as f64;
            let x1 = polygon[j][0] as f64;
            let cross = (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0);
            if cross < 0.0 {
                winding -= 1;
            }
        }
    }
    winding != 0
}

// ─── Engine Integration ────────────────────────────────────────────────────────

impl Engine {
    /// Collect all path segments from visible nodes in world space.
    pub(crate) fn collect_segments(&self) -> Vec<(Vec2, Vec2, u32)> {
        let mut segments = Vec::new();
        for (&id, node) in &self.scene.nodes {
            if !node.visible {
                continue;
            }
            let transform = self.global_transforms.get(&id)
                .copied()
                .unwrap_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);

            match &node.geometry {
                Geometry::Path { subpaths } => {
                    // Transform subpath points to world space, then extract segments
                    for sp in subpaths {
                        let world_points: Vec<PathPoint> = sp.points.iter().map(|p| {
                            PathPoint {
                                x: transform[0] * p.x + transform[3] * p.y + transform[6],
                                y: transform[1] * p.x + transform[4] * p.y + transform[7],
                                cp1: Vec2::new(
                                    transform[0] * p.cp1.x + transform[3] * p.cp1.y + transform[6],
                                    transform[1] * p.cp1.x + transform[4] * p.cp1.y + transform[7],
                                ),
                                cp2: Vec2::new(
                                    transform[0] * p.cp2.x + transform[3] * p.cp2.y + transform[6],
                                    transform[1] * p.cp2.x + transform[4] * p.cp2.y + transform[7],
                                ),
                            }
                        }).collect();
                        segments.extend(path_to_segments(&world_points, id));
                        // If closed, add closing segment from last to first
                        if sp.closed && world_points.len() >= 2 {
                            let last = &world_points[world_points.len() - 1];
                            let first = &world_points[0];
                            let closing = vec![last.clone(), first.clone()];
                            segments.extend(path_to_segments(&closing, id));
                        }
                    }
                }
                Geometry::Rect { width, height } => {
                    segments.extend(rect_to_segments(*width, *height, &transform, id));
                }
                Geometry::Ellipse { radius_x, radius_y } => {
                    segments.extend(ellipse_to_segments(*radius_x, *radius_y, &transform, id));
                }
                Geometry::Text { .. } => {} // Skip text
            }
        }
        segments
    }

    /// Ensure the vector network is up to date.
    pub(crate) fn ensure_network_clean(&mut self) {
        if self.scene.vector_network.dirty {
            let segments = self.collect_segments();
            self.scene.vector_network.rebuild(segments);
        }
    }
}
