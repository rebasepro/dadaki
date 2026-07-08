use glam::Vec2;
use ordered_float::OrderedFloat;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::{Color, Engine, Geometry, PathPoint, Subpath};

/// Compute the centroid of a face's boundary polygon.
pub fn face_centroid(face: &PlanarFace) -> Vec2 {
    polygon_centroid(&face.boundary_polygon)
}

/// Sentinel `source_node` for synthetic gap-bridge edges — not a real scene
/// node. Excluded from rendering, painting, and face signatures.
pub const SYNTHETIC_SOURCE: u32 = u32::MAX;

/// Max centroid distance (world units) for the fallback fill re-map, used only
/// when no signature match exists (topology changed). Signature matches are
/// distance-independent, so a filled region survives arbitrary moves as long as
/// the same set of paths still bounds it.
const FILL_REMAP_THRESHOLD: f32 = 50.0;

/// A face fill awaiting re-attachment on the next rebuild (from file load,
/// undo/redo, or a snapshot taken before the graph was recomputed).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PendingFill {
    /// Centroid of the originally-painted face (fallback matching).
    pub centroid: Vec2,
    /// Sorted set of source-node ids that bounded the face (primary matching).
    #[serde(default)]
    pub signature: Vec<u32>,
    pub color: Color,
}

// ─── Data Structures ───────────────────────────────────────────────────────────

/// A vertex in the planar graph.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlanarVertex {
    pub id: u32,
    pub position: Vec2,
    /// Outgoing edge IDs, sorted radially (CCW).
    pub outgoing_edges: Vec<u32>,
    /// Live Paint group this vertex belongs to — coincident points from
    /// different groups are NOT merged (groups are independent).
    #[serde(default)]
    pub group: u32,
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
    /// Synthetic gap-bridge edge — participates in face detection but is not a
    /// real path segment (not rendered, not paintable, excluded from signatures).
    #[serde(default)]
    pub synthetic: bool,
    /// The Live Paint group this edge belongs to (groups are independent).
    #[serde(default)]
    pub group: u32,
    /// Which source curve this half-edge is a fragment of, and the t-range it
    /// covers oriented `from`→`to`. Lets faces/edges be reconstructed as EXACT
    /// béziers instead of the flattened polyline. Derived at rebuild; not saved.
    #[serde(skip)]
    pub frag: Option<Frag>,
}

/// A half-edge's slice of a source curve: covers parameter `ta`→`tb` of
/// `VectorNetwork::curves[curve]`, oriented in the half-edge's direction.
#[derive(Clone, Copy, Debug)]
pub struct Frag {
    pub curve: u32,
    pub ta: f32,
    pub tb: f32,
}

/// A source curve in world space — the exact geometry a face/edge fragment is
/// carved from. Built fresh each rebuild (indexed by `Frag::curve`); not saved.
#[derive(Clone, Copy, Debug)]
pub enum CurveSeg {
    /// Straight segment `a`→`b`, parametrised linearly.
    Line { node: u32, seg: u32, a: Vec2, b: Vec2 },
    /// Cubic bézier with control points `p0,p1,p2,p3`.
    Cubic { node: u32, seg: u32, p: [Vec2; 4] },
}

impl CurveSeg {
    fn node(&self) -> u32 {
        match self { CurveSeg::Line { node, .. } | CurveSeg::Cubic { node, .. } => *node }
    }
    /// Ordinal of this curve within its source node's geometry — stable across
    /// moves/topology changes, so painted edges can re-attach by (node, seg, t).
    fn seg(&self) -> u32 {
        match self { CurveSeg::Line { seg, .. } | CurveSeg::Cubic { seg, .. } => *seg }
    }
    fn point_at(&self, t: f32) -> Vec2 {
        match self {
            CurveSeg::Line { a, b, .. } => *a + (*b - *a) * t,
            CurveSeg::Cubic { p, .. } => cubic_point(p, t),
        }
    }
    /// Control points of the sub-arc over [t0,t1], oriented t0→t1. For a line the
    /// handles are coincident with the endpoints (renders/exports as a line).
    fn subsegment(&self, t0: f32, t1: f32) -> [Vec2; 4] {
        match self {
            CurveSeg::Line { .. } => {
                let (a, b) = (self.point_at(t0), self.point_at(t1));
                [a, a, b, b]
            }
            CurveSeg::Cubic { p, .. } => cubic_subsegment(p, t0, t1),
        }
    }
}

/// A flattened segment that remembers the source curve + t-range it came from,
/// and which Live Paint group it belongs to (segments of different groups never
/// interact, so the planar graph is partitioned per group).
#[derive(Clone, Copy)]
pub(crate) struct FlatSeg {
    a: Vec2,
    b: Vec2,
    node: u32,
    group: u32,
    curve: u32,
    ta: f32,
    tb: f32,
}

/// `FlatSeg` after endpoints are resolved to vertex ids (post `build_vertices`).
#[derive(Clone, Copy)]
struct RemFlat {
    from: u32,
    to: u32,
    node: u32,
    group: u32,
    curve: u32,
    ta: f32,
    tb: f32,
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
    /// The Live Paint group this face belongs to.
    #[serde(default)]
    pub group: u32,
    /// Containment signature: sorted ids of the closed source shapes that
    /// contain this face's interior. This is a topological invariant — it stays
    /// the same when shapes move as long as the inside/outside relationship
    /// holds — so a fill re-attaches to the same region across edits. Two
    /// overlapping circles yield three faces with signatures {a}, {a,b}, {b}.
    #[serde(default)]
    pub signature: Vec<u32>,
}

/// A user-painted edge stroke, stored by identity so it survives graph
/// rebuilds. The anchor is kept in the SOURCE NODE's local space, so moving or
/// transforming that path carries the paint along (the Engine converts to/from
/// world using the node's global transform).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PaintedEdge {
    pub source_node: u32,
    pub local: Vec2,
    pub color: Color,
    pub width: f32,
    /// Structural identity: source-segment ordinal + parameter of the click.
    /// Survives topology changes (a moving crossing) far better than `local`,
    /// which is kept as a fallback for legacy files. -1 = no structural id.
    #[serde(default = "neg_one")]
    pub seg: i32,
    #[serde(default)]
    pub t: f32,
}

fn neg_one() -> i32 { -1 }

/// A logical edge: a maximal chain of same-source planar edges running between
/// graph nodes (vertices where paths cross or a path ends). This is the unit the
/// Live Paint bucket recolors — "the line between two intersections", matching
/// how Illustrator treats a Live Paint edge. Rebuilt with the graph; not saved.
#[derive(Clone, Debug, Default)]
pub struct LogicalEdge {
    pub id: u32,
    pub source_node: u32,
    /// The Live Paint group this edge belongs to.
    pub group: u32,
    /// World-space polyline of the whole chain (hit tests / midpoint identity).
    pub polyline: Vec<Vec2>,
    /// Exact-bézier outline (anchor + handles) of the chain — for rendering.
    pub outline: Vec<PathPoint>,
    /// Source segments this chain covers: `(seg ordinal, t_lo, t_hi)` normalised.
    /// Used to re-attach painted edges by structural identity.
    pub segs: Vec<(u32, f32, f32)>,
    /// Representative identity for painting this edge (middle fragment).
    pub anchor_seg: i32,
    pub anchor_t: f32,
    /// Applied stroke, resolved from the scene's painted-edge list each rebuild.
    pub paint: Option<Color>,
    pub width: f32,
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
    /// Gap-closing distance in world units. Open path ends within this distance
    /// of another vertex/edge are bridged by synthetic edges so the enclosed
    /// region becomes fillable. 0 = off (only coincident endpoints merge).
    #[serde(default)]
    pub gap_bridge_distance: f32,
    /// Pending face fills from file load/undo — applied on first rebuild.
    #[serde(default)]
    pub pending_fills: Vec<PendingFill>,
    /// User-painted edge strokes, by local-space identity (persisted).
    #[serde(default)]
    pub painted_edges: Vec<PaintedEdge>,
    /// Logical edges for painting/hit-testing. Derived from the graph each
    /// rebuild, so it is not serialized.
    #[serde(skip)]
    pub logical_edges: HashMap<u32, LogicalEdge>,
    /// Source curves (world space) that fragments reference for exact-bézier
    /// reconstruction. Rebuilt each pass; not serialized.
    #[serde(skip)]
    pub curves: Vec<CurveSeg>,
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
            gap_bridge_distance: 0.0,
            pending_fills: Vec::new(),
            painted_edges: Vec::new(),
            logical_edges: HashMap::new(),
            curves: Vec::new(),
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
        self.logical_edges.clear();
        self.curves.clear();
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

/// Like `flatten_cubic` but records the curve parameter `t` at each emitted
/// point. Caller seeds `out` with `(p0, t0)`; this appends up to `(p3, t1)`.
fn flatten_cubic_t(
    p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2,
    t0: f32, t1: f32, tolerance: f32, out: &mut Vec<(Vec2, f32)>,
) {
    let d1 = (p1 - p0).length() + (p2 - p1).length() + (p3 - p2).length();
    let d2 = (p3 - p0).length();
    if (d1 - d2) < tolerance {
        out.push((p3, t1));
        return;
    }
    let m01 = (p0 + p1) * 0.5;
    let m12 = (p1 + p2) * 0.5;
    let m23 = (p2 + p3) * 0.5;
    let m012 = (m01 + m12) * 0.5;
    let m123 = (m12 + m23) * 0.5;
    let mid = (m012 + m123) * 0.5;
    let tmid = 0.5 * (t0 + t1);
    flatten_cubic_t(p0, m01, m012, mid, t0, tmid, tolerance, out);
    flatten_cubic_t(mid, m123, m23, p3, tmid, t1, tolerance, out);
}

/// Evaluate a cubic bézier at parameter `t`.
fn cubic_point(p: &[Vec2; 4], t: f32) -> Vec2 {
    let mt = 1.0 - t;
    p[0] * (mt * mt * mt)
        + p[1] * (3.0 * mt * mt * t)
        + p[2] * (3.0 * mt * t * t)
        + p[3] * (t * t * t)
}

/// de Casteljau split of a cubic at `t`; returns the [0,t] (left) and [t,1]
/// (right) control-point quads.
fn cubic_split(p: &[Vec2; 4], t: f32) -> ([Vec2; 4], [Vec2; 4]) {
    let a = p[0].lerp(p[1], t);
    let b = p[1].lerp(p[2], t);
    let c = p[2].lerp(p[3], t);
    let d = a.lerp(b, t);
    let e = b.lerp(c, t);
    let f = d.lerp(e, t);
    ([p[0], a, d, f], [f, e, c, p[3]])
}

/// Control points of the cubic restricted to [t0,t1], oriented t0→t1
/// (reversed if t0 > t1). Exact — this is what makes faces true béziers.
fn cubic_subsegment(p: &[Vec2; 4], t0: f32, t1: f32) -> [Vec2; 4] {
    let (mut lo, mut hi) = (t0, t1);
    let reversed = lo > hi;
    if reversed {
        std::mem::swap(&mut lo, &mut hi);
    }
    // Restrict to [0, hi], then take the [lo/hi, 1] tail of that.
    let (left, _) = cubic_split(p, hi.clamp(0.0, 1.0));
    let u = if hi > 1e-9 { (lo / hi).clamp(0.0, 1.0) } else { 0.0 };
    let (_, seg) = cubic_split(&left, u);
    if reversed { [seg[3], seg[2], seg[1], seg[0]] } else { seg }
}

/// Convert an ordered list of cubic control quads (each `[c0,c1,c2,c3]`, head to
/// tail) into a CLOSED subpath's `PathPoint`s (anchor + cp1/cp2 per point). The
/// final anchor coincides with the first, so it's folded into the first point's
/// incoming handle (the engine's closed-subpath convention).
fn quads_to_closed_pathpoints(quads: &[[Vec2; 4]]) -> Vec<PathPoint> {
    if quads.is_empty() {
        return Vec::new();
    }
    let mut pts: Vec<PathPoint> = Vec::new();
    let first = quads[0][0];
    pts.push(PathPoint { x: first.x, y: first.y, cp1: first, cp2: first, corner_radius: 0.0 });
    for q in quads {
        if let Some(last) = pts.last_mut() {
            last.cp2 = q[1]; // outgoing handle of the current anchor
        }
        pts.push(PathPoint { x: q[3].x, y: q[3].y, cp1: q[2], cp2: q[3], corner_radius: 0.0 });
    }
    if pts.len() > 1 {
        let last = pts.pop().unwrap();
        pts[0].cp1 = last.cp1;
    }
    pts
}

/// Like `quads_to_closed_pathpoints` but for an OPEN chain — every anchor is
/// kept (nothing folded), so painted edges reconstruct as true curves.
fn quads_to_open_pathpoints(quads: &[[Vec2; 4]]) -> Vec<PathPoint> {
    if quads.is_empty() {
        return Vec::new();
    }
    let mut pts: Vec<PathPoint> = Vec::new();
    let first = quads[0][0];
    pts.push(PathPoint { x: first.x, y: first.y, cp1: first, cp2: first, corner_radius: 0.0 });
    for q in quads {
        if let Some(last) = pts.last_mut() {
            last.cp2 = q[1];
        }
        pts.push(PathPoint { x: q[3].x, y: q[3].y, cp1: q[2], cp2: q[3], corner_radius: 0.0 });
    }
    pts
}

/// Flattening tolerance (world units) for building the planar graph. Curves are
/// reconstructed exactly from `curves` for rendering/export, so this only needs
/// to be fine enough for topology (intersections/containment).
const FLATTEN_TOL: f32 = 0.5;

/// Emit one Cubic curve per path segment, plus its flattened `FlatSeg`s.
fn push_path_curves(points: &[PathPoint], node: u32, group: u32, curves: &mut Vec<CurveSeg>, out: &mut Vec<FlatSeg>) {
    if points.len() < 2 {
        return;
    }
    for i in 0..points.len() - 1 {
        let p = [
            Vec2::new(points[i].x, points[i].y),
            points[i].cp2,
            points[i + 1].cp1,
            Vec2::new(points[i + 1].x, points[i + 1].y),
        ];
        push_cubic(p, node, group, i as u32, curves, out);
    }
}

/// Register a cubic in the curve table and append its flattened `FlatSeg`s.
fn push_cubic(p: [Vec2; 4], node: u32, group: u32, seg: u32, curves: &mut Vec<CurveSeg>, out: &mut Vec<FlatSeg>) {
    let ci = curves.len() as u32;
    curves.push(CurveSeg::Cubic { node, seg, p });
    let mut flat: Vec<(Vec2, f32)> = vec![(p[0], 0.0)];
    flatten_cubic_t(p[0], p[1], p[2], p[3], 0.0, 1.0, FLATTEN_TOL, &mut flat);
    for w in flat.windows(2) {
        out.push(FlatSeg { a: w[0].0, b: w[1].0, node, group, curve: ci, ta: w[0].1, tb: w[1].1 });
    }
}

/// Rect → 4 Line curves.
fn push_rect_curves(w: f32, h: f32, transform: &[f32; 9], node: u32, group: u32, curves: &mut Vec<CurveSeg>, out: &mut Vec<FlatSeg>) {
    let c = [
        transform_point(Vec2::new(0.0, 0.0), transform),
        transform_point(Vec2::new(w, 0.0), transform),
        transform_point(Vec2::new(w, h), transform),
        transform_point(Vec2::new(0.0, h), transform),
    ];
    for i in 0..4 {
        let (a, b) = (c[i], c[(i + 1) % 4]);
        let ci = curves.len() as u32;
        curves.push(CurveSeg::Line { node, seg: i as u32, a, b });
        out.push(FlatSeg { a, b, node, group, curve: ci, ta: 0.0, tb: 1.0 });
    }
}

/// Ellipse → 4 cubic arcs (kappa approximation), so the network — and the faces
/// carved from it — are true curves, not a 32-gon.
fn push_ellipse_curves(rx: f32, ry: f32, transform: &[f32; 9], node: u32, group: u32, curves: &mut Vec<CurveSeg>, out: &mut Vec<FlatSeg>) {
    const K: f32 = 0.552_284_75; // 4/3 * (sqrt(2) - 1)
    let arcs = [
        [Vec2::new(rx, 0.0), Vec2::new(rx, K * ry), Vec2::new(K * rx, ry), Vec2::new(0.0, ry)],
        [Vec2::new(0.0, ry), Vec2::new(-K * rx, ry), Vec2::new(-rx, K * ry), Vec2::new(-rx, 0.0)],
        [Vec2::new(-rx, 0.0), Vec2::new(-rx, -K * ry), Vec2::new(-K * rx, -ry), Vec2::new(0.0, -ry)],
        [Vec2::new(0.0, -ry), Vec2::new(K * rx, -ry), Vec2::new(rx, -K * ry), Vec2::new(rx, 0.0)],
    ];
    for (i, arc) in arcs.iter().enumerate() {
        let p = [
            transform_point(arc[0], transform),
            transform_point(arc[1], transform),
            transform_point(arc[2], transform),
            transform_point(arc[3], transform),
        ];
        push_cubic(p, node, group, i as u32, curves, out);
    }
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
    /// Rebuild the entire planar graph from the given scene segments + curves.
    pub(crate) fn rebuild(&mut self, engine_segments: Vec<FlatSeg>, curves: Vec<CurveSeg>) {
        // Snapshot old filled faces as (signature, centroid, color) for re-mapping.
        // The signature (which closed shapes contain the face) lets a fill
        // re-attach to the same region even after shapes move (see remap_fills).
        let old_filled: Vec<(Vec<u32>, Vec2, Color)> = self.faces.values()
            .filter(|f| f.fill.is_some() && !f.is_outer)
            .map(|f| (
                f.signature.clone(),
                polygon_centroid(&f.boundary_polygon),
                f.fill.clone().unwrap(),
            ))
            .collect();

        // Group the incoming (un-split) segments by source node into closed
        // outlines, used to compute each new face's containment signature.
        let node_outlines = build_node_outlines(&engine_segments);

        self.clear();
        self.faces.clear();
        self.curves = curves;

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

        // Step 2: Build vertices (merge endpoints within gap tolerance, per group)
        let segments_remapped = self.build_vertices(split_segments);

        if segments_remapped.is_empty() {
            self.dirty = false;
            return;
        }

        // Step 3: Create half-edges
        self.create_half_edges(segments_remapped);

        // Step 4: Close gaps — bridge dangling open ends within tolerance so
        // not-quite-closed regions become fillable (Illustrator "Gap Options").
        if self.gap_bridge_distance > 0.0 {
            self.bridge_gaps();
        }

        // Step 5: Sort outgoing edges radially at each vertex
        self.sort_edges_radially();

        // Step 6: Detect faces via left-hand turn traversal
        self.detect_faces();

        // Step 7: Tag each face with its containment signature.
        self.compute_face_signatures(&node_outlines);

        // Step 8: Merge planar edges into logical edges (for edge painting).
        self.build_logical_edges();

        // Step 9: Re-attach old + pending fills to the new faces.
        self.remap_fills(old_filled);

        self.dirty = false;
    }

    /// Merge planar half-edges into logical edges: maximal same-source chains
    /// running between graph nodes (vertices of non-synthetic degree ≠ 2).
    /// Synthetic gap bridges are excluded — they are not paintable geometry.
    fn build_logical_edges(&mut self) {
        self.logical_edges.clear();

        // Canonical undirected, non-synthetic edges (id < twin picks one of each pair).
        let mut canon: Vec<u32> = self.edges.values()
            .filter(|e| !e.synthetic && e.id < e.twin)
            .map(|e| e.id)
            .collect();
        canon.sort_unstable();

        // Incident canonical edges per vertex → undirected degree.
        let mut incident: HashMap<u32, Vec<u32>> = HashMap::new();
        for &eid in &canon {
            let e = &self.edges[&eid];
            incident.entry(e.from_vertex).or_default().push(eid);
            incident.entry(e.to_vertex).or_default().push(eid);
        }

        let mut visited: HashSet<u32> = HashSet::new();
        for &start in &canon {
            if visited.contains(&start) {
                continue;
            }
            let src = self.edges[&start].source_node;
            let grp = self.edges[&start].group;
            let (v0, v1) = (self.edges[&start].from_vertex, self.edges[&start].to_vertex);
            visited.insert(start);

            // Ordered vertex sequence of the chain, seeded with the start edge.
            let mut verts: std::collections::VecDeque<u32> = std::collections::VecDeque::new();
            verts.push_back(v0);
            verts.push_back(v1);

            // Extend forward from v1, then backward from v0. A chain continues
            // through a vertex only if it has exactly 2 same-context incident
            // edges (a pass-through point) and the next edge shares the source.
            self.walk_chain(v1, start, src, &incident, &mut visited, &mut verts, false);
            self.walk_chain(v0, start, src, &incident, &mut visited, &mut verts, true);

            let verts: Vec<u32> = verts.into_iter().collect();
            let polyline: Vec<Vec2> = verts.iter()
                .filter_map(|v| self.vertices.get(v).map(|pv| pv.position))
                .collect();
            if polyline.len() < 2 {
                continue;
            }
            // Exact-bézier outline: resolve the chain's ordered half-edges, then
            // merge same-curve fragments into cubics (open chain — keep all pts).
            let chain_edges = self.verts_to_edges(&verts);
            let outline = quads_to_open_pathpoints(&self.edges_to_quads(&chain_edges));
            // Structural identity: which source segments (+ t-ranges) the chain
            // covers, and a representative anchor (its middle fragment).
            let mut segs: Vec<(u32, f32, f32)> = Vec::new();
            for &eid in &chain_edges {
                if let Some(fr) = self.edges.get(&eid).and_then(|e| e.frag) {
                    if let Some(cv) = self.curves.get(fr.curve as usize) {
                        segs.push((cv.seg(), fr.ta.min(fr.tb), fr.ta.max(fr.tb)));
                    }
                }
            }
            let (anchor_seg, anchor_t) = chain_edges.get(chain_edges.len() / 2)
                .and_then(|&eid| self.edges.get(&eid))
                .and_then(|e| e.frag)
                .and_then(|fr| self.curves.get(fr.curve as usize).map(|cv| (cv.seg() as i32, 0.5 * (fr.ta + fr.tb))))
                .unwrap_or((-1, 0.0));
            let id = self.alloc_id();
            self.logical_edges.insert(id, LogicalEdge {
                id, source_node: src, group: grp, polyline, outline, segs, anchor_seg, anchor_t, paint: None, width: 0.0,
            });
        }
    }

    /// Ordered directed half-edges connecting a run of vertices head-to-tail.
    fn verts_to_edges(&self, verts: &[u32]) -> Vec<u32> {
        let mut out = Vec::new();
        for w in verts.windows(2) {
            if let Some(v) = self.vertices.get(&w[0]) {
                if let Some(&eid) = v.outgoing_edges.iter()
                    .find(|&&e| self.edges.get(&e).map(|x| x.to_vertex) == Some(w[1]))
                {
                    out.push(eid);
                }
            }
        }
        out
    }

    /// Walk a degree-2 same-source chain from `from_vertex` (reached via
    /// `came_edge`), appending traversed vertices to `verts`.
    #[allow(clippy::too_many_arguments)]
    fn walk_chain(
        &self,
        from_vertex: u32,
        came_edge: u32,
        src: u32,
        incident: &HashMap<u32, Vec<u32>>,
        visited: &mut HashSet<u32>,
        verts: &mut std::collections::VecDeque<u32>,
        push_front: bool,
    ) {
        let mut cur_v = from_vertex;
        let mut came = came_edge;
        loop {
            let inc = match incident.get(&cur_v) {
                Some(i) if i.len() == 2 => i,
                _ => break, // node vertex (crossing/endpoint) → chain ends here
            };
            let next = if inc[0] == came { inc[1] } else { inc[0] };
            if visited.contains(&next) || self.edges[&next].source_node != src {
                break;
            }
            visited.insert(next);
            let ne = &self.edges[&next];
            let far = if ne.from_vertex == cur_v { ne.to_vertex } else { ne.from_vertex };
            if push_front { verts.push_front(far); } else { verts.push_back(far); }
            if far == cur_v { break; } // degenerate guard
            came = next;
            cur_v = far;
        }
    }

    /// Nearest paintable logical edge to a point, within `tolerance` world units.
    pub fn query_edge_at(&self, x: f32, y: f32, tolerance: f32) -> Option<u32> {
        let p = Vec2::new(x, y);
        let mut best: Option<(u32, f32)> = None;
        for (&id, le) in &self.logical_edges {
            let d = point_to_polyline_distance(p, &le.polyline);
            if d <= tolerance && best.map_or(true, |(_, bd)| d < bd) {
                best = Some((id, d));
            }
        }
        best.map(|(id, _)| id)
    }

    /// Reconstruct a face's boundary as EXACT béziers (anchor + handles): walk
    /// the boundary half-edges, merge consecutive fragments of the same source
    /// curve into one cubic sub-arc, and fall back to straight lines for
    /// synthetic/no-frag edges. Returns a closed subpath's points.
    pub(crate) fn face_outline(&self, face: &PlanarFace) -> Vec<PathPoint> {
        quads_to_closed_pathpoints(&self.edges_to_quads(&face.boundary_edges))
    }

    /// Merge an ordered run of half-edges into cubic control quads: consecutive
    /// fragments of the same source curve with contiguous t collapse into one
    /// exact sub-arc; synthetic/no-frag edges become straight quads.
    fn edges_to_quads(&self, edge_ids: &[u32]) -> Vec<[Vec2; 4]> {
        let mut quads: Vec<[Vec2; 4]> = Vec::new();
        let mut run: Option<(u32, f32, f32)> = None; // (curve, t_start, t_last)
        let flush = |run: &mut Option<(u32, f32, f32)>, quads: &mut Vec<[Vec2; 4]>, curves: &[CurveSeg]| {
            if let Some((c, t0, t1)) = run.take() {
                if let Some(cv) = curves.get(c as usize) {
                    quads.push(cv.subsegment(t0, t1));
                }
            }
        };
        for &eid in edge_ids {
            let e = match self.edges.get(&eid) { Some(e) => e, None => continue };
            match e.frag {
                Some(f) if (f.curve as usize) < self.curves.len() => match run {
                    // Extend when it's the same curve and t is contiguous.
                    Some((c, t0, t1)) if c == f.curve && (f.ta - t1).abs() < 1e-3 => {
                        run = Some((c, t0, f.tb));
                    }
                    _ => {
                        flush(&mut run, &mut quads, &self.curves);
                        run = Some((f.curve, f.ta, f.tb));
                    }
                },
                _ => {
                    flush(&mut run, &mut quads, &self.curves);
                    let a = self.vertices[&e.from_vertex].position;
                    let b = self.vertices[&e.to_vertex].position;
                    quads.push([a, a, b, b]);
                }
            }
        }
        flush(&mut run, &mut quads, &self.curves);
        quads
    }

    /// Compute each non-outer face's containment signature: the sorted ids of
    /// the closed source shapes whose interior contains the face. This is the
    /// stable identity used to re-attach fills across edits.
    fn compute_face_signatures(&mut self, node_outlines: &HashMap<u32, NodeOutline>) {
        for face in self.faces.values_mut() {
            if face.is_outer {
                continue;
            }
            let p = representative_point(&face.boundary_polygon);
            let fg = face.group;
            let mut sig: Vec<u32> = node_outlines.iter()
                .filter(|(_, o)| o.group == fg && o.closed && point_inside_segments(p, &o.segments))
                .map(|(&nid, _)| nid)
                .collect();
            sig.sort_unstable();
            face.signature = sig;
        }
    }

    fn find_intersections_and_split(&self, segments: Vec<FlatSeg>) -> Vec<FlatSeg> {
        // Split points are stored as the flat-local parameter `t` ∈ [0,1] + point.
        let n = segments.len();
        let mut splits: Vec<Vec<(f32, Vec2)>> = vec![Vec::new(); n];

        // Spatial hash: bucket each segment into every cell its AABB touches, so
        // only segments sharing a cell are candidate pairs. Two segments can only
        // cross (or one's endpoint lie on the other) if their AABBs overlap, so
        // shared-cell candidates are a superset of all real intersections — this
        // replaces the old O(n²) pairwise scan.
        const CELL: f32 = 32.0;
        let mut grid: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
        for (i, s) in segments.iter().enumerate() {
            let cx0 = (s.a.x.min(s.b.x) / CELL).floor() as i32;
            let cx1 = (s.a.x.max(s.b.x) / CELL).floor() as i32;
            let cy0 = (s.a.y.min(s.b.y) / CELL).floor() as i32;
            let cy1 = (s.a.y.max(s.b.y) / CELL).floor() as i32;
            for cx in cx0..=cx1 {
                for cy in cy0..=cy1 {
                    grid.entry((cx, cy)).or_default().push(i);
                }
            }
        }
        let mut pairs: HashSet<(usize, usize)> = HashSet::new();
        for ids in grid.values() {
            for a in 0..ids.len() {
                for b in (a + 1)..ids.len() {
                    pairs.insert((ids[a].min(ids[b]), ids[a].max(ids[b])));
                }
            }
        }

        const ON_EPS: f32 = 0.1; // world-space distance for "point lies on segment"
        const T_EPS: f32 = 1e-4; // keep the split strictly interior
        for &(i, j) in &pairs {
            // Different Live Paint groups are independent — they never split each
            // other, so their overlapping shapes form faces independently.
            if segments[i].group != segments[j].group {
                continue;
            }
            // Proper crossing (both interiors).
            if let Some((t, u, pt)) = segment_intersection(
                segments[i].a, segments[i].b, segments[j].a, segments[j].b,
            ) {
                splits[i].push((t, pt));
                splits[j].push((u, pt));
            }
            // T-junctions & collinear overlaps, both directions: an endpoint of
            // one segment lying on the interior of the other (missed by the
            // crossing test — endpoint touch / parallel). Common with aligned
            // rectangles; without it the region stays unsplit and unfillable.
            for &(x, y) in &[(i, j), (j, i)] {
                let (pa, pb) = (segments[x].a, segments[x].b);
                for &p in &[segments[y].a, segments[y].b] {
                    let (proj, t) = project_point_to_segment(p, pa, pb);
                    if t > T_EPS && t < 1.0 - T_EPS && (proj - p).length() < ON_EPS {
                        splits[x].push((t, p));
                    }
                }
            }
        }

        // Split each flat segment at its intersection points, carrying a linearly
        // interpolated CURVE parameter so fragments know their exact sub-arc.
        let mut result = Vec::new();
        for (i, seg) in segments.iter().enumerate() {
            let curve_t = |ft: f32| seg.ta + ft * (seg.tb - seg.ta);
            if splits[i].is_empty() {
                result.push(*seg);
                continue;
            }
            let mut pts = splits[i].clone();
            pts.sort_by_key(|(t, _)| OrderedFloat(*t));
            let mut prev = seg.a;
            let mut prev_ct = seg.ta;
            for (ft, pt) in &pts {
                let ct = curve_t(*ft);
                if (*pt - prev).length() > 1e-6 {
                    result.push(FlatSeg { a: prev, b: *pt, node: seg.node, group: seg.group, curve: seg.curve, ta: prev_ct, tb: ct });
                }
                prev = *pt;
                prev_ct = ct;
            }
            if (seg.b - prev).length() > 1e-6 {
                result.push(FlatSeg { a: prev, b: seg.b, node: seg.node, group: seg.group, curve: seg.curve, ta: prev_ct, tb: seg.tb });
            }
        }
        result
    }

    fn build_vertices(&mut self, segments: Vec<FlatSeg>) -> Vec<RemFlat> {
        let tolerance = self.gap_tolerance;
        // Exact-position dedup keyed by (position, group).
        let mut vertex_map: HashMap<(OrderedVec2, u32), u32> = HashMap::new();

        // Merge endpoints within tolerance, but ONLY within the same group — two
        // groups' coincident points must stay distinct so their graphs don't fuse.
        let get_or_create_vertex = |pos: Vec2, group: u32, vn: &mut VectorNetwork, vmap: &mut HashMap<(OrderedVec2, u32), u32>| -> u32 {
            for v in vn.vertices.values() {
                if v.group == group && (v.position - pos).length() < tolerance {
                    return v.id;
                }
            }
            let key = (OrderedVec2(OrderedFloat(pos.x), OrderedFloat(pos.y)), group);
            if let Some(&id) = vmap.get(&key) {
                return id;
            }
            let id = vn.alloc_id();
            vn.vertices.insert(id, PlanarVertex {
                id,
                position: pos,
                outgoing_edges: Vec::new(),
                group,
            });
            vmap.insert(key, id);
            id
        };

        let mut remapped = Vec::new();
        for seg in &segments {
            let from = get_or_create_vertex(seg.a, seg.group, self, &mut vertex_map);
            let to = get_or_create_vertex(seg.b, seg.group, self, &mut vertex_map);
            if from != to {
                remapped.push(RemFlat { from, to, node: seg.node, group: seg.group, curve: seg.curve, ta: seg.ta, tb: seg.tb });
            }
        }
        remapped
    }

    fn create_half_edges(&mut self, segments: Vec<RemFlat>) {
        // Deduplicate: skip if we already have an edge from→to
        let mut seen: HashSet<(u32, u32)> = HashSet::new();

        for s in segments {
            let (from, to, source_node) = (s.from, s.to, s.node);
            if seen.contains(&(from, to)) || seen.contains(&(to, from)) {
                continue;
            }
            seen.insert((from, to));

            let e1_id = self.alloc_id();
            let e2_id = self.alloc_id();

            let from_pos = self.vertices[&from].position;
            let to_pos = self.vertices[&to].position;

            // Forward half-edge carries the fragment oriented from→to; the twin
            // carries the reverse (tb→ta) so its reconstruction runs backwards.
            self.edges.insert(e1_id, PlanarEdge {
                id: e1_id,
                from_vertex: from,
                to_vertex: to,
                polyline: vec![from_pos, to_pos],
                source_node,
                twin: e2_id,
                face: None,
                synthetic: false,
                group: s.group,
                frag: Some(Frag { curve: s.curve, ta: s.ta, tb: s.tb }),
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
                synthetic: false,
                group: s.group,
                frag: Some(Frag { curve: s.curve, ta: s.tb, tb: s.ta }),
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

    /// Create a half-edge pair `from`↔`to` and register them at both vertices.
    /// Unlike `create_half_edges` this does no dedup — callers ensure uniqueness.
    fn add_half_edge_pair(&mut self, from: u32, to: u32, source_node: u32, synthetic: bool) {
        let e1 = self.alloc_id();
        let e2 = self.alloc_id();
        let from_pos = self.vertices[&from].position;
        let to_pos = self.vertices[&to].position;
        let group = self.vertices.get(&from).map(|v| v.group).unwrap_or(0);
        self.edges.insert(e1, PlanarEdge {
            id: e1, from_vertex: from, to_vertex: to,
            polyline: vec![from_pos, to_pos], source_node, twin: e2, face: None, synthetic, group, frag: None,
        });
        self.edges.insert(e2, PlanarEdge {
            id: e2, from_vertex: to, to_vertex: from,
            polyline: vec![to_pos, from_pos], source_node, twin: e1, face: None, synthetic, group, frag: None,
        });
        self.vertices.get_mut(&from).unwrap().outgoing_edges.push(e1);
        self.vertices.get_mut(&to).unwrap().outgoing_edges.push(e2);
    }

    /// Split the undirected edge `eid` at `pos`, inserting a new vertex there.
    /// Returns the new vertex id. The two resulting sub-edges keep the original
    /// edge's `source_node`/`synthetic` flags.
    fn split_edge_at(&mut self, eid: u32, pos: Vec2) -> u32 {
        let e = self.edges[&eid].clone();
        let (from, to, twin) = (e.from_vertex, e.to_vertex, e.twin);
        // Remove both half-edges and unregister them from their vertices.
        self.edges.remove(&eid);
        self.edges.remove(&twin);
        if let Some(v) = self.vertices.get_mut(&from) { v.outgoing_edges.retain(|&x| x != eid); }
        if let Some(v) = self.vertices.get_mut(&to) { v.outgoing_edges.retain(|&x| x != twin); }
        // New vertex at the split point (inherits the split edge's group).
        let nv = self.alloc_id();
        self.vertices.insert(nv, PlanarVertex { id: nv, position: pos, outgoing_edges: Vec::new(), group: e.group });
        self.add_half_edge_pair(from, nv, e.source_node, e.synthetic);
        self.add_half_edge_pair(nv, to, e.source_node, e.synthetic);
        nv
    }

    /// Close gaps by bridging dangling open ends (degree-1 vertices) to the
    /// nearest vertex or edge within `gap_bridge_distance`, via synthetic edges.
    /// Greedy: once a vertex is bridged it is no longer dangling, so a facing
    /// pair of open ends is joined by exactly one bridge.
    fn bridge_gaps(&mut self) {
        let max_d = self.gap_bridge_distance;
        let max_d2 = max_d * max_d;

        // Deterministic processing order (HashMap iteration is not stable).
        let mut dangling: Vec<u32> = self.vertices.values()
            .filter(|v| v.outgoing_edges.len() == 1)
            .map(|v| v.id)
            .collect();
        dangling.sort_unstable();

        for vid in dangling {
            // Skip if a prior bridge already resolved this open end.
            let out = match self.vertices.get(&vid) {
                Some(v) if v.outgoing_edges.len() == 1 => v.outgoing_edges[0],
                _ => continue,
            };
            let vpos = self.vertices[&vid].position;
            let vgrp = self.vertices[&vid].group;
            let neighbor = self.edges[&out].to_vertex;

            // Nearest non-adjacent vertex (lower id wins ties for determinism).
            // Bridges only join open ends within the same Live Paint group.
            let mut best_vertex: Option<(u32, f32)> = None;
            for (&uid, u) in &self.vertices {
                if uid == vid || uid == neighbor || u.group != vgrp { continue; }
                let d2 = (u.position - vpos).length_squared();
                if d2 > max_d2 || d2 < 1e-6 { continue; }
                match best_vertex {
                    Some((bid, bd)) if d2 > bd || (d2 == bd && uid >= bid) => {}
                    _ => best_vertex = Some((uid, d2)),
                }
            }

            // Nearest interior point on a non-incident edge (one per twin pair).
            let mut best_edge: Option<(u32, f32, Vec2)> = None;
            for (&eid, e) in &self.edges {
                if e.twin < eid { continue; }
                if e.group != vgrp { continue; }
                if e.from_vertex == vid || e.to_vertex == vid { continue; }
                let a = self.vertices[&e.from_vertex].position;
                let b = self.vertices[&e.to_vertex].position;
                let (proj, t) = project_point_to_segment(vpos, a, b);
                if t <= 1e-3 || t >= 1.0 - 1e-3 { continue; } // endpoint → vertex case
                let d2 = (proj - vpos).length_squared();
                if d2 > max_d2 || d2 < 1e-6 { continue; }
                match best_edge {
                    Some((bid, bd, _)) if d2 > bd || (d2 == bd && eid >= bid) => {}
                    _ => best_edge = Some((eid, d2, proj)),
                }
            }

            // Bridge to whichever candidate is closer.
            match (best_vertex, best_edge) {
                (Some((uid, vd)), edge_opt) if edge_opt.map_or(true, |(_, ed, _)| vd <= ed) => {
                    self.add_half_edge_pair(vid, uid, SYNTHETIC_SOURCE, true);
                }
                (_, Some((eid, _, proj))) => {
                    let nv = self.split_edge_at(eid, proj);
                    self.add_half_edge_pair(vid, nv, SYNTHETIC_SOURCE, true);
                }
                _ => {}
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
                // All boundary edges share one group (graph is partitioned).
                let group = face_edges.first()
                    .and_then(|eid| self.edges.get(eid))
                    .map(|e| e.group)
                    .unwrap_or(0);

                let face = PlanarFace {
                    id: face_id,
                    boundary_edges: face_edges.clone(),
                    fill: None,
                    boundary_polygon: polygon,
                    signed_area: area,
                    is_outer: area < 0.0, // CW winding = outer face
                    group,
                    signature: Vec::new(), // filled in by compute_face_signatures
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

    /// Re-attach fills to the freshly-detected faces.
    ///
    /// Matching is two-tier:
    ///   1. **Signature** — a face contained by the exact same set of closed
    ///      shapes is the same region, no matter how far it moved or reshaped.
    ///      Ties (several regions share a signature) break by nearest centroid.
    ///   2. **Centroid fallback** — when no signature matches (topology changed,
    ///      or a pre-v6 file with no stored signature), attach to the nearest
    ///      unclaimed face within `FILL_REMAP_THRESHOLD`, else drop the fill.
    ///
    /// `old_filled` are the fills from before this rebuild; `pending_fills` are
    /// fills loaded from a file/undo snapshot. Both are placed here.
    fn remap_fills(&mut self, old_filled: Vec<(Vec<u32>, Vec2, Color)>) {
        let to_place: Vec<(Vec<u32>, Vec2, Color)> = old_filled.into_iter()
            .chain(self.pending_fills.drain(..)
                .map(|pf| (pf.signature, pf.centroid, pf.color)))
            .collect();
        if to_place.is_empty() {
            return;
        }

        // Precompute candidate faces once: (id, signature, centroid).
        let candidates: Vec<(u32, Vec<u32>, Vec2)> = self.faces.values()
            .filter(|f| !f.is_outer)
            .map(|f| (f.id, f.signature.clone(), polygon_centroid(&f.boundary_polygon)))
            .collect();

        let mut taken: HashSet<u32> = HashSet::new();
        for (sig, centroid, color) in &to_place {
            let mut best: Option<(u32, f32)> = None;

            // Tier 1: exact signature match (distance-independent).
            if !sig.is_empty() {
                for (fid, csig, ccent) in &candidates {
                    if taken.contains(fid) || csig != sig {
                        continue;
                    }
                    let d = (*centroid - *ccent).length();
                    if best.map_or(true, |(_, bd)| d < bd) {
                        best = Some((*fid, d));
                    }
                }
            }

            // Tier 2: nearest centroid within threshold. To avoid a fill bleeding
            // onto an unrelated region (e.g. its defining shapes were deleted),
            // a candidate must still share at least one defining shape with the
            // old fill. Legacy fills with no signature fall back to pure centroid.
            if best.is_none() {
                for (fid, csig, ccent) in &candidates {
                    if taken.contains(fid) {
                        continue;
                    }
                    let shares_shape = sig.is_empty()
                        || csig.iter().any(|n| sig.contains(n));
                    if !shares_shape {
                        continue;
                    }
                    let d = (*centroid - *ccent).length();
                    if d <= FILL_REMAP_THRESHOLD && best.map_or(true, |(_, bd)| d < bd) {
                        best = Some((*fid, d));
                    }
                }
            }

            if let Some((fid, _)) = best {
                taken.insert(fid);
                if let Some(face) = self.faces.get_mut(&fid) {
                    face.fill = Some(color.clone());
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

/// A source node's world-space outline, grouped for containment testing.
struct NodeOutline {
    segments: Vec<(Vec2, Vec2)>,
    /// True when the segments form closed loop(s) — only then is "inside" defined.
    closed: bool,
    /// The Live Paint group this node belongs to (containment is same-group).
    group: u32,
}

/// Group raw scene segments by source node into outlines, flagging which ones
/// are closed (every endpoint has even degree ⇒ the outline forms loops).
fn build_node_outlines(segments: &[FlatSeg]) -> HashMap<u32, NodeOutline> {
    let mut by_node: HashMap<u32, (Vec<(Vec2, Vec2)>, u32)> = HashMap::new();
    for s in segments {
        let e = by_node.entry(s.node).or_insert_with(|| (Vec::new(), s.group));
        e.0.push((s.a, s.b));
    }
    by_node.into_iter().map(|(node, (segs, group))| {
        let mut degree: HashMap<OrderedVec2, i32> = HashMap::new();
        for &(a, b) in &segs {
            *degree.entry(OrderedVec2(OrderedFloat(a.x), OrderedFloat(a.y))).or_insert(0) += 1;
            *degree.entry(OrderedVec2(OrderedFloat(b.x), OrderedFloat(b.y))).or_insert(0) += 1;
        }
        let closed = degree.values().all(|&d| d % 2 == 0);
        (node, NodeOutline { segments: segs, closed, group })
    }).collect()
}

/// Even-odd point-in-outline test via a horizontal ray cast to +x. Correct for
/// closed loops (including multiple subpaths / holes).
fn point_inside_segments(p: Vec2, segments: &[(Vec2, Vec2)]) -> bool {
    let mut crossings = 0u32;
    for &(a, b) in segments {
        // Does the edge straddle the horizontal line y = p.y?
        if (a.y > p.y) != (b.y > p.y) {
            let t = (p.y - a.y) / (b.y - a.y);
            let x = a.x + t * (b.x - a.x);
            if x > p.x {
                crossings += 1;
            }
        }
    }
    crossings % 2 == 1
}

/// A point guaranteed to lie inside the simple polygon. The centroid works for
/// convex faces; for concave ones it may fall outside, so fall back to the
/// midpoint of the first interior span on a horizontal scanline through it.
fn representative_point(polygon: &[[f32; 2]]) -> Vec2 {
    let c = polygon_centroid(polygon);
    if point_in_polygon(&[c.x, c.y], polygon) {
        return c;
    }
    // Scanline at the centroid's y: collect x-crossings, sorted, and take the
    // midpoint of the first inside span (between crossing 0 and 1).
    let y = c.y as f64;
    let n = polygon.len();
    let mut xs: Vec<f64> = Vec::new();
    for i in 0..n {
        let j = (i + 1) % n;
        let (y0, y1) = (polygon[i][1] as f64, polygon[j][1] as f64);
        if (y0 > y) != (y1 > y) {
            let t = (y - y0) / (y1 - y0);
            xs.push(polygon[i][0] as f64 + t * (polygon[j][0] as f64 - polygon[i][0] as f64));
        }
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if xs.len() >= 2 {
        Vec2::new(((xs[0] + xs[1]) * 0.5) as f32, c.y)
    } else {
        c
    }
}

/// Shortest distance from a point to a polyline (min over its segments).
fn point_to_polyline_distance(p: Vec2, polyline: &[Vec2]) -> f32 {
    if polyline.is_empty() {
        return f32::MAX;
    }
    if polyline.len() == 1 {
        return (p - polyline[0]).length();
    }
    let mut best = f32::MAX;
    for w in polyline.windows(2) {
        let (proj, _) = project_point_to_segment(p, w[0], w[1]);
        best = best.min((p - proj).length());
    }
    best
}

/// The point at half the arc length of a polyline — a stable interior marker
/// used as a logical edge's identity anchor.
pub(crate) fn polyline_midpoint(polyline: &[Vec2]) -> Vec2 {
    if polyline.is_empty() {
        return Vec2::ZERO;
    }
    if polyline.len() == 1 {
        return polyline[0];
    }
    let total: f32 = polyline.windows(2).map(|w| (w[1] - w[0]).length()).sum();
    let mut half = total * 0.5;
    for w in polyline.windows(2) {
        let seg = (w[1] - w[0]).length();
        if seg >= half {
            let t = if seg > 0.0 { half / seg } else { 0.0 };
            return w[0] + (w[1] - w[0]) * t;
        }
        half -= seg;
    }
    polyline[polyline.len() - 1]
}

/// Project `p` onto segment `a`→`b`, returning the closest point and its
/// clamped parameter `t` ∈ [0,1] (0 = at `a`, 1 = at `b`).
fn project_point_to_segment(p: Vec2, a: Vec2, b: Vec2) -> (Vec2, f32) {
    let ab = b - a;
    let len2 = ab.length_squared();
    if len2 < 1e-12 {
        return (a, 0.0);
    }
    let t = ((p - a).dot(ab) / len2).clamp(0.0, 1.0);
    (a + ab * t, t)
}

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
    /// Collect all path segments from visible nodes in world space, together
    /// with the source curve table for exact-bézier reconstruction.
    pub(crate) fn collect_segments(&self) -> (Vec<FlatSeg>, Vec<CurveSeg>) {
        let mut segments = Vec::new();
        let mut curves: Vec<CurveSeg> = Vec::new();
        for (&id, node) in &self.scene.nodes {
            if !node.visible {
                continue;
            }
            // A shape participates only if it lives inside a Live Paint group;
            // its `group` is the nearest such flagged ancestor. Groups are
            // independent — segments of different groups never split or merge.
            let group = match self.live_paint_group_of(id) {
                Some(g) => g,
                None => continue,
            };
            let transform = self.global_transforms.get(&id)
                .copied()
                .unwrap_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);

            match &node.geometry {
                Geometry::Path { ref subpaths, .. } => {
                    // Transform subpath points to world space, then extract curves.
                    for sp in subpaths {
                        let mut world_points: Vec<PathPoint> = sp.points.iter().map(|p| {
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
                                corner_radius: p.corner_radius,
                            }
                        }).collect();
                        // A closed subpath adds the wrap segment last → first.
                        if sp.closed && world_points.len() >= 2 {
                            world_points.push(world_points[0].clone());
                        }
                        push_path_curves(&world_points, id, group, &mut curves, &mut segments);
                    }
                }
                Geometry::Rect { width, height } => {
                    push_rect_curves(*width, *height, &transform, id, group, &mut curves, &mut segments);
                }
                Geometry::Ellipse { radius_x, radius_y } => {
                    push_ellipse_curves(*radius_x, *radius_y, &transform, id, group, &mut curves, &mut segments);
                }
                Geometry::Text { .. } => {} // Skip text
                Geometry::Image { .. } => {} // Skip images (no vector segments)
            }
        }
        (segments, curves)
    }

    /// The nearest `live_paint`-flagged ancestor group of `node` (or itself), or
    /// None if the node isn't inside any Live Paint group.
    pub(crate) fn live_paint_group_of(&self, node: u32) -> Option<u32> {
        let mut cur = Some(node);
        while let Some(id) = cur {
            if let Some(n) = self.scene.nodes.get(&id) {
                if n.live_paint {
                    return Some(id);
                }
                cur = n.parent;
            } else {
                break;
            }
        }
        None
    }

    /// True if `node` is `ancestor` or nested anywhere beneath it.
    pub(crate) fn is_descendant_of(&self, node: u32, ancestor: u32) -> bool {
        let mut cur = Some(node);
        while let Some(id) = cur {
            if id == ancestor {
                return true;
            }
            cur = self.scene.nodes.get(&id).and_then(|n| n.parent);
        }
        false
    }

    /// Ensure the vector network is up to date.
    pub(crate) fn ensure_network_clean(&mut self) {
        if self.scene.vector_network.dirty {
            let (segments, curves) = self.collect_segments();
            self.scene.vector_network.rebuild(segments, curves);
            self.resolve_painted_edges();
        }
    }
}

// ─── Per-Node Vector Network ───────────────────────────────────────────────────

/// Per-node vector network — the graph-based path representation.
/// This is the editing source of truth; subpaths are derived from it.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NodeVectorNetwork {
    pub vertices: Vec<NetworkVertex>,
    pub edges: Vec<NetworkEdge>,
    /// Enclosed regions with independent fill styles.
    #[serde(default)]
    pub regions: Vec<NetworkRegion>,
}

// NOTE: these structs are serialized to protobuf inside Scene snapshots
// (history/drag) and files. New fields need a serde default AND a new proto
// tag in proto.rs (never renumber existing tags).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NetworkVertex {
    pub position: Vec2,
    /// Incoming control handle (absolute position). None = sharp corner.
    #[serde(default)]
    pub handle_in: Option<Vec2>,
    /// Outgoing control handle (absolute position). None = sharp corner.
    #[serde(default)]
    pub handle_out: Option<Vec2>,
    /// Parametric corner radius at this vertex (non-destructive rounding).
    #[serde(default)]
    pub corner_radius: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NetworkEdge {
    pub start_vertex: u32,  // index into vertices
    pub end_vertex: u32,    // index into vertices
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NetworkRegion {
    /// Ordered edge indices forming a closed loop.
    pub edge_loop: Vec<u32>,
    /// Fill style for this enclosed area.
    #[serde(default)]
    pub fill: Option<Color>,
}

impl Default for NodeVectorNetwork {
    fn default() -> Self {
        Self {
            vertices: Vec::new(),
            edges: Vec::new(),
            regions: Vec::new(),
        }
    }
}

impl NodeVectorNetwork {
    /// Convert traditional subpaths to a NodeVectorNetwork.
    pub fn from_subpaths(subpaths: &[Subpath]) -> Self {
        let mut vertices = Vec::new();
        let mut edges = Vec::new();

        for sp in subpaths {
            let base = vertices.len() as u32;
            for point in &sp.points {
                let position = Vec2::new(point.x, point.y);
                let handle_in = if (point.cp1 - position).length() > 0.001 {
                    Some(point.cp1)
                } else {
                    None
                };
                let handle_out = if (point.cp2 - position).length() > 0.001 {
                    Some(point.cp2)
                } else {
                    None
                };
                vertices.push(NetworkVertex {
                    position,
                    handle_in,
                    handle_out,
                    corner_radius: point.corner_radius,
                });
            }

            let count = sp.points.len() as u32;
            // Create edges between consecutive vertices
            for i in 0..count.saturating_sub(1) {
                edges.push(NetworkEdge {
                    start_vertex: base + i,
                    end_vertex: base + i + 1,
                });
            }
            // If closed, add closing edge from last to first vertex of this subpath
            if sp.closed && count >= 2 {
                edges.push(NetworkEdge {
                    start_vertex: base + count - 1,
                    end_vertex: base,
                });
            }
        }

        NodeVectorNetwork {
            vertices,
            edges,
            regions: Vec::new(),
        }
    }

    /// Convert the network back to subpaths.
    pub fn to_subpaths(&self) -> Vec<Subpath> {
        if self.edges.is_empty() {
            return Vec::new();
        }

        // Build adjacency map: start_vertex -> Vec<(end_vertex, edge_index)>
        let mut adjacency: HashMap<u32, Vec<(u32, usize)>> = HashMap::new();
        for (idx, edge) in self.edges.iter().enumerate() {
            adjacency.entry(edge.start_vertex).or_default().push((edge.end_vertex, idx));
        }

        let mut visited_edges: HashSet<usize> = HashSet::new();
        let mut subpaths = Vec::new();

        for start_edge_idx in 0..self.edges.len() {
            if visited_edges.contains(&start_edge_idx) {
                continue;
            }

            let mut walk = Vec::new();
            let start_vertex = self.edges[start_edge_idx].start_vertex;
            let mut current_vertex = start_vertex;
            let mut closed = false;

            // Walk the chain
            loop {
                // Find an unvisited edge from current_vertex
                let next = adjacency.get(&current_vertex).and_then(|neighbors| {
                    neighbors.iter().find(|(_, eidx)| !visited_edges.contains(eidx)).copied()
                });

                match next {
                    Some((end_vertex, edge_idx)) => {
                        visited_edges.insert(edge_idx);
                        if walk.is_empty() {
                            walk.push(current_vertex);
                        }
                        if end_vertex == start_vertex {
                            // Closed loop
                            closed = true;
                            break;
                        }
                        walk.push(end_vertex);
                        current_vertex = end_vertex;
                    }
                    None => {
                        // Dead end (open subpath)
                        if walk.is_empty() {
                            walk.push(current_vertex);
                        }
                        break;
                    }
                }
            }

            if walk.is_empty() {
                continue;
            }

            // Convert vertex indices to PathPoints
            let points: Vec<PathPoint> = walk.iter().filter_map(|&vi| {
                self.vertices.get(vi as usize).map(|v| {
                    PathPoint {
                        x: v.position.x,
                        y: v.position.y,
                        cp1: v.handle_in.unwrap_or(v.position),
                        cp2: v.handle_out.unwrap_or(v.position),
                        corner_radius: v.corner_radius,
                    }
                })
            }).collect();

            if !points.is_empty() {
                subpaths.push(Subpath { points, closed });
            }
        }

        subpaths
    }
}
