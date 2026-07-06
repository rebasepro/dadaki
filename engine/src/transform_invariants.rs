//! Property-based invariant tests for the transform system.
//!
//! Transform bugs are rarely crashes — they're *semantic*: the matrix math
//! runs fine but means the wrong thing (wrong pivot, wrong space, silent
//! no-op). Example-based tests miss these because a hand-picked example is
//! usually symmetric or axis-aligned, exactly the states where wrong and
//! right coincide. So each test here states a geometric CONTRACT and checks
//! it over thousands of randomized transform states:
//!
//!  1. Decompose∘compose is the identity on matrices.
//!  2. Component setters pivot on the geometry center (the shape must not
//!     drift while a value is scrubbed).
//!  3. Component setters are absolute + reversible (set v, set back, get
//!     the original matrix — no compensation residue).
//!  4. flip_h maps EVERY world point to its mirror image about the bounds
//!     center — pointwise, not just "the function did something". This is
//!     the property the old local-space flip violated (it was a perfect
//!     visual no-op for symmetric geometry).
//!  5. Flips are involutions (twice = identity).
//!  6. All of the above hold for nodes nested inside transformed groups
//!     (parent-space conversion is where these bugs love to hide).
//!  7. No sequence of API calls — including hostile NaN/0/±inf inputs —
//!     can ever leave an invalid transform in the scene.

use crate::*;

// ─── Deterministic pseudo-random generator (no dev-dependency needed) ───────

struct Lcg(u64);

impl Lcg {
    fn new(seed: u64) -> Self {
        Lcg(seed.max(1))
    }

    fn next_u32(&mut self) -> u32 {
        // Numerical Recipes LCG constants
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }

    /// Uniform f32 in [lo, hi).
    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (self.next_u32() as f32 / u32::MAX as f32) * (hi - lo)
    }

    /// A scale factor that is never ~0: magnitude in [0.2, 3], random sign.
    fn scale(&mut self) -> f32 {
        let mag = self.range(0.2, 3.0);
        if self.next_u32() % 2 == 0 { mag } else { -mag }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn mat_near(a: &Mat3, b: &Mat3, tol: f32) -> bool {
    let (a, b) = (a.to_cols_array(), b.to_cols_array());
    a.iter().zip(b.iter()).all(|(x, y)| {
        let scale = x.abs().max(y.abs()).max(1.0);
        (x - y).abs() <= tol * scale
    })
}

fn assert_vec2_near(a: Vec2, b: Vec2, tol: f32, ctx: &str) {
    assert!(
        (a.x - b.x).abs() <= tol && (a.y - b.y).abs() <= tol,
        "{ctx}: expected ({}, {}), got ({}, {})",
        b.x, b.y, a.x, a.y
    );
}

/// World-space positions of a rect node's four geometry corners.
fn world_corners(engine: &Engine, id: u32) -> [Vec2; 4] {
    let node = engine.scene.nodes.get(&id).unwrap();
    let (w, h) = match node.geometry {
        Geometry::Rect { width, height } => (width, height),
        _ => panic!("world_corners expects a Rect node"),
    };
    let g = Mat3::from_cols_array(engine.global_transforms.get(&id).unwrap());
    [
        g.transform_point2(Vec2::new(0.0, 0.0)),
        g.transform_point2(Vec2::new(w, 0.0)),
        g.transform_point2(Vec2::new(w, h)),
        g.transform_point2(Vec2::new(0.0, h)),
    ]
}

fn local_matrix(engine: &Engine, id: u32) -> Mat3 {
    engine.scene.nodes.get(&id).unwrap().transform.to_mat3()
}

/// Put a node into a random (but always valid) transform state through the
/// public API, the same way the UI would.
fn randomize_node(engine: &mut Engine, id: u32, rng: &mut Lcg) {
    engine.set_node_rotation(id, rng.range(-179.0, 179.0));
    engine.set_node_skew(id, rng.range(-60.0, 60.0), rng.range(-60.0, 60.0));
    engine.set_node_scale(id, rng.scale(), rng.scale());
    engine.move_node(id, rng.range(-500.0, 500.0), rng.range(-500.0, 500.0));
}

/// The world position of the node's geometry center (the pivot contract).
fn world_center_of_geometry(engine: &Engine, id: u32) -> Vec2 {
    let node = engine.scene.nodes.get(&id).unwrap();
    let (cx, cy) = match node.geometry {
        Geometry::Rect { width, height } => (width / 2.0, height / 2.0),
        _ => panic!("expects a Rect node"),
    };
    let g = Mat3::from_cols_array(engine.global_transforms.get(&id).unwrap());
    g.transform_point2(Vec2::new(cx, cy))
}

// ─── 1. Decomposition round-trip ─────────────────────────────────────────────

#[test]
fn decompose_compose_roundtrip_over_component_grid() {
    let mut failures = 0;
    for rot in (-170..=180).step_by(35) {
        for skx in (-60..=60).step_by(30) {
            for sky in (-60..=60).step_by(30) {
                for &sx in &[-2.0f32, -0.7, 0.6, 1.0, 1.8] {
                    for &sy in &[-2.0f32, -0.7, 0.6, 1.0, 1.8] {
                        let t = Transform2D {
                            x: 12.5,
                            y: -300.0,
                            rotation_deg: rot as f32,
                            skew_x_deg: skx as f32,
                            skew_y_deg: sky as f32,
                            scale_x: sx,
                            scale_y: sy,
                        };
                        // The contract only covers valid transforms — the
                        // setters guarantee invalid ones never enter the scene
                        // (e.g. skx+sky = ±90° makes the matrix singular).
                        if !t.is_valid() {
                            continue;
                        }
                        let m = t.to_mat3();
                        let rt = Transform2D::from_mat3(&m).to_mat3();
                        if !mat_near(&m, &rt, 1e-3) {
                            failures += 1;
                            if failures < 5 {
                                eprintln!("roundtrip failed for {t:?}\n  m={m:?}\n  rt={rt:?}");
                            }
                        }
                    }
                }
            }
        }
    }
    assert_eq!(failures, 0, "{failures} grid points failed decompose∘compose roundtrip");
}

// ─── 2. Center pivot ─────────────────────────────────────────────────────────

#[test]
fn component_setters_never_move_the_geometry_center() {
    let mut rng = Lcg::new(0xC0FFEE);
    for i in 0..500 {
        let mut engine = Engine::new();
        let id = engine.add_rect(
            rng.range(-200.0, 200.0),
            rng.range(-200.0, 200.0),
            rng.range(10.0, 300.0),
            rng.range(10.0, 300.0),
        );
        randomize_node(&mut engine, id, &mut rng);
        let center = world_center_of_geometry(&engine, id);

        engine.set_node_rotation(id, rng.range(-179.0, 179.0));
        assert_vec2_near(
            world_center_of_geometry(&engine, id), center, 0.05,
            &format!("iter {i}: set_node_rotation moved the center"),
        );

        engine.set_node_skew(id, rng.range(-60.0, 60.0), rng.range(-60.0, 60.0));
        assert_vec2_near(
            world_center_of_geometry(&engine, id), center, 0.05,
            &format!("iter {i}: set_node_skew moved the center"),
        );

        engine.set_node_scale(id, rng.scale(), rng.scale());
        assert_vec2_near(
            world_center_of_geometry(&engine, id), center, 0.05,
            &format!("iter {i}: set_node_scale moved the center"),
        );
    }
}

// ─── 3. Setters are absolute and reversible ──────────────────────────────────

#[test]
fn setting_a_component_and_setting_it_back_restores_the_matrix() {
    let mut rng = Lcg::new(0xBEEF);
    for i in 0..500 {
        let mut engine = Engine::new();
        let id = engine.add_rect(0.0, 0.0, 120.0, 80.0);
        randomize_node(&mut engine, id, &mut rng);

        let before = local_matrix(&engine, id);
        let t0 = engine.scene.nodes.get(&id).unwrap().transform;

        engine.set_node_rotation(id, rng.range(-179.0, 179.0));
        engine.set_node_rotation(id, t0.rotation_deg);
        assert!(
            mat_near(&local_matrix(&engine, id), &before, 1e-2),
            "iter {i}: rotation set/unset left residue"
        );

        engine.set_node_skew(id, rng.range(-60.0, 60.0), rng.range(-60.0, 60.0));
        engine.set_node_skew(id, t0.skew_x_deg, t0.skew_y_deg);
        assert!(
            mat_near(&local_matrix(&engine, id), &before, 1e-2),
            "iter {i}: skew set/unset left residue"
        );

        engine.set_node_scale(id, rng.scale(), rng.scale());
        engine.set_node_scale(id, t0.scale_x, t0.scale_y);
        assert!(
            mat_near(&local_matrix(&engine, id), &before, 1e-2),
            "iter {i}: scale set/unset left residue"
        );
    }
}

// ─── 4. Flip is a pointwise world-space mirror ───────────────────────────────

#[test]
fn flip_mirrors_every_world_point_about_the_bounds_center() {
    let mut rng = Lcg::new(0xF11B);
    for i in 0..500 {
        let mut engine = Engine::new();
        let id = engine.add_rect(0.0, 0.0, rng.range(10.0, 200.0), rng.range(10.0, 200.0));
        randomize_node(&mut engine, id, &mut rng);

        // Horizontal
        let b = engine.get_node_bounds(id);
        let cx = (b[0] + b[2]) / 2.0;
        let before = world_corners(&engine, id);
        engine.flip_node_horizontal(id);
        let after = world_corners(&engine, id);
        for (k, (p, q)) in before.iter().zip(after.iter()).enumerate() {
            assert_vec2_near(
                *q, Vec2::new(2.0 * cx - p.x, p.y), 0.1,
                &format!("iter {i}: flip_h corner {k} is not the mirror image"),
            );
        }

        // Vertical
        let b = engine.get_node_bounds(id);
        let cy = (b[1] + b[3]) / 2.0;
        let before = world_corners(&engine, id);
        engine.flip_node_vertical(id);
        let after = world_corners(&engine, id);
        for (k, (p, q)) in before.iter().zip(after.iter()).enumerate() {
            assert_vec2_near(
                *q, Vec2::new(p.x, 2.0 * cy - p.y), 0.1,
                &format!("iter {i}: flip_v corner {k} is not the mirror image"),
            );
        }
    }
}

#[test]
fn flip_twice_is_identity() {
    let mut rng = Lcg::new(0x7717);
    for i in 0..300 {
        let mut engine = Engine::new();
        let id = engine.add_rect(0.0, 0.0, 150.0, 90.0);
        randomize_node(&mut engine, id, &mut rng);
        let before = world_corners(&engine, id);

        engine.flip_node_horizontal(id);
        engine.flip_node_horizontal(id);
        let after = world_corners(&engine, id);
        for (k, (p, q)) in before.iter().zip(after.iter()).enumerate() {
            assert_vec2_near(*q, *p, 0.1, &format!("iter {i}: double flip_h moved corner {k}"));
        }

        engine.flip_node_vertical(id);
        engine.flip_node_vertical(id);
        let after = world_corners(&engine, id);
        for (k, (p, q)) in before.iter().zip(after.iter()).enumerate() {
            assert_vec2_near(*q, *p, 0.1, &format!("iter {i}: double flip_v moved corner {k}"));
        }
    }
}

/// Regression: the pre-fix flip mirrored in LOCAL space, which is a perfect
/// visual no-op for locally-symmetric geometry (any rect), skewed or not.
#[test]
fn flip_visibly_changes_a_skewed_square() {
    let mut engine = Engine::new();
    let id = engine.add_rect(100.0, 100.0, 120.0, 120.0);
    engine.set_node_skew(id, 30.0, 0.0);

    let before = world_corners(&engine, id);
    engine.flip_node_horizontal(id);
    let after = world_corners(&engine, id);

    let max_move = before
        .iter()
        .zip(after.iter())
        .map(|(p, q)| (*p - *q).length())
        .fold(0.0f32, f32::max);
    assert!(
        max_move > 10.0,
        "flip_h on a skewed square must visibly reverse the slant (max corner move {max_move})"
    );
}

/// Regression: with the symmetric skew matrix [[1,tx],[ty,1]] the combination
/// skew_x + skew_y = 90° (e.g. 30° + 60°) was singular and got rejected. The
/// sequential model must accept BOTH axes independently and stay non-degenerate.
#[test]
fn independent_skew_axes_accept_30_and_60() {
    let mut engine = Engine::new();
    let id = engine.add_rect(0.0, 0.0, 100.0, 100.0);

    engine.set_node_skew(id, 30.0, 60.0);
    let t = engine.scene.nodes.get(&id).unwrap().transform;
    assert!((t.skew_x_deg - 30.0).abs() < 1e-3, "skew_x should stick at 30, got {}", t.skew_x_deg);
    assert!((t.skew_y_deg - 60.0).abs() < 1e-3, "skew_y should stick at 60, got {}", t.skew_y_deg);
    assert!(t.is_valid(), "30°/60° skew must be a valid (non-degenerate) transform");

    // The shape must remain a real parallelogram: no two edges collinear.
    // With sin/cos skew model: det(Kx·Ky) = cos(30°)·cos(60°) ≈ 0.433
    let m = t.to_mat3();
    let det = m.x_axis.x * m.y_axis.y - m.x_axis.y * m.y_axis.x;
    assert!(det.abs() > 0.4, "area must be preserved (det {det}), not collapsed to a line");
}

/// The two skew axes must be genuinely independent: setting one never silently
/// drops the other. Tested over ±60° on both axes — a strong shear that stays
/// a well-conditioned parallelogram. (Beyond ~75° on BOTH axes at once the
/// shape collapses toward a line and the conditioning guard rejects it by
/// design, exactly like a near-zero scale; that boundary is not "independence".)
#[test]
fn skew_axes_are_independent_over_a_grid() {
    for sx in (-60..=60).step_by(20) {
        for sy in (-60..=60).step_by(20) {
            let mut engine = Engine::new();
            let id = engine.add_rect(0.0, 0.0, 100.0, 100.0);
            engine.set_node_skew(id, sx as f32, sy as f32);
            let t = engine.scene.nodes.get(&id).unwrap().transform;
            assert!(t.is_valid(), "skew ({sx}, {sy}) should be valid");
            assert!(
                (t.skew_x_deg - sx as f32).abs() < 1e-3 && (t.skew_y_deg - sy as f32).abs() < 1e-3,
                "skew ({sx}, {sy}) not stored independently: got ({}, {})",
                t.skew_x_deg, t.skew_y_deg
            );
        }
    }
}

// ─── 5. Everything still holds inside a transformed group ───────────────────

#[test]
fn contracts_hold_for_children_of_transformed_groups() {
    let mut rng = Lcg::new(0x6809);
    for i in 0..300 {
        let mut engine = Engine::new();
        let a = engine.add_rect(rng.range(0.0, 100.0), rng.range(0.0, 100.0), 80.0, 60.0);
        let b = engine.add_rect(200.0, 200.0, 50.0, 50.0);
        let group = engine.group_nodes(&format!("[{a},{b}]"));
        // Transform the PARENT group, then operate on the child.
        engine.set_node_rotation(group, rng.range(-90.0, 90.0));
        engine.set_node_scale(group, rng.range(0.5, 2.0), rng.range(0.5, 2.0));
        engine.move_node(group, rng.range(-100.0, 100.0), rng.range(-100.0, 100.0));

        // Center pivot in world space despite the parent transform
        let center = world_center_of_geometry(&engine, a);
        engine.set_node_rotation(a, rng.range(-179.0, 179.0));
        engine.set_node_skew(a, rng.range(-50.0, 50.0), 0.0);
        assert_vec2_near(
            world_center_of_geometry(&engine, a), center, 0.1,
            &format!("iter {i}: child component edit moved center under transformed parent"),
        );

        // Flip mirrors world points despite the parent transform
        let bounds = engine.get_node_bounds(a);
        let cx = (bounds[0] + bounds[2]) / 2.0;
        let before = world_corners(&engine, a);
        engine.flip_node_horizontal(a);
        let after = world_corners(&engine, a);
        for (k, (p, q)) in before.iter().zip(after.iter()).enumerate() {
            assert_vec2_near(
                *q, Vec2::new(2.0 * cx - p.x, p.y), 0.15,
                &format!("iter {i}: child flip_h corner {k} wrong under transformed parent"),
            );
        }
    }
}

// ─── 6. No API sequence can corrupt a transform ──────────────────────────────

#[test]
fn fuzz_no_operation_sequence_leaves_an_invalid_transform() {
    let mut rng = Lcg::new(0xDEAD10CC);
    let hostile = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.0, 1e30, -1e30, 1e-30];

    let mut engine = Engine::new();
    let id = engine.add_rect(0.0, 0.0, 100.0, 100.0);
    let id2 = engine.add_rect(50.0, 50.0, 40.0, 40.0);
    let group = engine.group_nodes(&format!("[{id2}]"));

    for step in 0..3000 {
        let target = if rng.next_u32() % 4 == 0 { group } else { id };
        // 20% of calls use hostile values; the engine must reject them.
        let v = |rng: &mut Lcg| -> f32 {
            if rng.next_u32() % 5 == 0 {
                hostile[(rng.next_u32() as usize) % hostile.len()]
            } else {
                rng.range(-400.0, 400.0)
            }
        };
        match rng.next_u32() % 8 {
            0 => engine.set_node_rotation(target, v(&mut rng)),
            1 => engine.set_node_skew(target, v(&mut rng), v(&mut rng)),
            2 => engine.set_node_scale(target, v(&mut rng) / 100.0, v(&mut rng) / 100.0),
            3 => engine.move_node(target, v(&mut rng), v(&mut rng)),
            4 => engine.set_node_position(target, v(&mut rng), v(&mut rng)),
            5 => engine.flip_node_horizontal(target),
            6 => engine.flip_node_vertical(target),
            _ => engine.resize_node(target, v(&mut rng).abs().max(1.0), v(&mut rng).abs().max(1.0)),
        }

        for check_id in [id, id2, group] {
            let t = engine.scene.nodes.get(&check_id).unwrap().transform;
            assert!(
                t.is_valid(),
                "step {step}: node {check_id} holds an invalid transform: {t:?}"
            );
            let g = engine.global_transforms.get(&check_id).unwrap();
            assert!(
                g.iter().all(|x| x.is_finite()),
                "step {step}: node {check_id} has a non-finite global transform"
            );
        }
    }
}

// ─── 7. Rotation normalization ───────────────────────────────────────────────

#[test]
fn rotation_is_normalized_into_half_open_range() {
    let mut engine = Engine::new();
    let id = engine.add_rect(0.0, 0.0, 100.0, 100.0);
    for deg in [720.0, 540.0, -540.0, 180.0, -180.0, 359.0, -359.0] {
        engine.set_node_rotation(id, deg);
        let stored = engine.scene.nodes.get(&id).unwrap().transform.rotation_deg;
        assert!(
            stored > -180.0 && stored <= 180.0,
            "set_node_rotation({deg}) stored {stored}, outside (-180, 180]"
        );
    }
}
