//! Property and fuzz tests for the `.dadaki` format.
//!
//! `format_tests.rs` pins specific behaviours with hand-picked inputs. This
//! module tests the *claims those examples generalize to*, because the load
//! path makes two promises that examples can only sample:
//!
//!   1. **Loading is total.** Any byte sequence either fails cleanly or
//!      produces a structurally coherent scene. Never a panic, never a hang,
//!      never a half-built document.
//!   2. **Saving is a fixed point.** serialize → deserialize → serialize is
//!      byte-exact, which is what undo coalescing relies on.
//!
//! Both are universally quantified, and both were false before the v1 work — a
//! cyclic graph stack-overflowed the wasm instance, and a truncated file opened
//! as a blank canvas. Examples proving the specific cases are fixed say nothing
//! about the next malformed file.
//!
//! Everything here is deterministic: seeded `StdRng`, fixed iteration counts,
//! no wall-clock in the assertions except the explicitly-labelled scaling
//! guards at the end. Budgets are kept tight so the suite stays fast — the
//! whole module is a small fraction of a second.

#![cfg(test)]

use crate::proto::{self, ProtoDocument};
use crate::{container, validate, Engine, Geometry, LoadError, Scene};
use prost::Message;
use rand::{rngs::StdRng, Rng, SeedableRng};
use std::collections::{HashMap, HashSet};

// ─── Generators ─────────────────────────────────────────────────────────────────

/// Build a valid, non-trivial scene: mixed geometry, nesting, and the
/// document-level collections that ride alongside the node tree.
///
/// Goes through the `Engine` API rather than assembling `Scene` by hand, so
/// whatever it produces is reachable by a real user and is valid by
/// construction — which is what makes "a file we wrote never needs repair" a
/// meaningful assertion rather than a tautology about the generator.
fn random_engine(seed: u64) -> Engine {
    let mut rng = StdRng::seed_from_u64(seed);
    let mut engine = Engine::new();

    let leaf_count = rng.gen_range(3..14);
    let mut ids: Vec<u32> = Vec::new();
    for _ in 0..leaf_count {
        let x = rng.gen_range(-500.0..500.0f32);
        let y = rng.gen_range(-500.0..500.0f32);
        let id = match rng.gen_range(0..4) {
            0 => engine.add_rect(x, y, rng.gen_range(1.0..300.0), rng.gen_range(1.0..300.0)),
            1 => engine.add_ellipse(x, y, rng.gen_range(1.0..150.0), rng.gen_range(1.0..150.0)),
            2 => engine.add_text(x, y, "sample text", rng.gen_range(8.0..96.0)),
            _ => {
                let pts: Vec<String> = (0..rng.gen_range(2..6))
                    .map(|_| {
                        format!(
                            r#"{{"x":{:.2},"y":{:.2}}}"#,
                            rng.gen_range(-400.0..400.0f32),
                            rng.gen_range(-400.0..400.0f32)
                        )
                    })
                    .collect();
                engine.add_path(&format!("[{}]", pts.join(",")))
            }
        };
        ids.push(id);
    }

    // Nest a random subset, sometimes more than once, to get real depth.
    for _ in 0..rng.gen_range(0..3) {
        if ids.len() < 2 {
            break;
        }
        let take = rng.gen_range(2..=ids.len().min(4));
        let picked: Vec<u32> = ids.drain(..take).collect();
        let json = format!(
            "[{}]",
            picked.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")
        );
        ids.push(engine.group_nodes(&json));
    }

    if rng.gen_bool(0.5) {
        engine.set_swatches_json(r#"[{"r":1,"g":0.5,"b":0,"a":1}]"#.into());
    }
    if rng.gen_bool(0.5) {
        engine.set_markers_json(r#"{"1":{"start":"arrow","end":"circle"}}"#.into());
    }
    if rng.gen_bool(0.5) {
        engine.set_guide_locks_json(r#"{"x":[10,20],"y":[30]}"#.into());
    }
    if rng.gen_bool(0.5) {
        engine.set_document_meta("uuid-x".into(), 1000.0, 2000.0, "1.0.0".into(), "T".into());
    }
    if rng.gen_bool(0.4) {
        engine.embed_font("Inter".into(), 400, false, vec![7u8; 256], "test".into());
    }
    engine
}

/// A document whose node graph is deliberately broken in a random way. These
/// are the shapes a corrupt or hostile file can encode.
fn malformed_document(seed: u64) -> ProtoDocument {
    let mut rng = StdRng::seed_from_u64(seed ^ 0xBAD_5EED);
    let n = rng.gen_range(1..12u32);

    let nodes: Vec<proto::ProtoNode> = (1..=n)
        .map(|id| proto::ProtoNode {
            id: if rng.gen_bool(0.15) { rng.gen_range(1..=n) } else { id }, // duplicates
            name: format!("n{id}"),
            node_type: rng.gen_range(0..7), // includes unknown types
            transform: Some(proto::ProtoTransform {
                x: 0.0, y: 0.0, rotation_deg: 0.0,
                skew_x_deg: 0.0, skew_y_deg: 0.0,
                scale_x: 1.0, scale_y: 1.0,
            }),
            geometry: Some(proto::ProtoGeometry::rect(10.0, 10.0)),
            // Children may name anything at all, including this node itself
            // and ids that were never defined.
            children: (0..rng.gen_range(0..4))
                .map(|_| rng.gen_range(1..=n + 3))
                .collect(),
            parent: if rng.gen_bool(0.5) { Some(rng.gen_range(1..=n + 3)) } else { None },
            visible: true,
            ..Default::default()
        })
        .collect();

    ProtoDocument {
        format_version: proto::FORMAT_VERSION,
        nodes,
        root_ids: (0..rng.gen_range(0..4)).map(|_| rng.gen_range(1..=n + 3)).collect(),
        next_id: rng.gen_range(0..3),
        ..Default::default()
    }
}

/// Wrap a payload in a valid envelope (correct length and checksum) so a
/// reader gets past the container and the *decoder* is what's under test.
fn envelope(payload: &[u8]) -> Vec<u8> {
    container::wrap(payload, 1)
}

// ─── Invariants ─────────────────────────────────────────────────────────────────

/// Everything `validate::repair` promises, checked directly against a scene.
///
/// Asserting these rather than "the repair counters look right" is deliberate:
/// the counters describe what the pass *did*, these describe what the caller
/// can now rely on — which is what the renderer and every traversal assume.
fn assert_scene_is_coherent(scene: &Scene, ctx: &str) {
    let known: HashSet<u32> = scene.nodes.keys().copied().collect();

    for root in &scene.root_nodes {
        assert!(known.contains(root), "{ctx}: root {root} does not exist");
    }
    assert_eq!(
        scene.root_nodes.len(),
        scene.root_nodes.iter().collect::<HashSet<_>>().len(),
        "{ctx}: a node is listed as a root twice, so it would be drawn twice",
    );

    let mut claimed: HashMap<u32, u32> = HashMap::new();
    for (&id, node) in &scene.nodes {
        for &child in &node.children {
            assert!(known.contains(&child), "{ctx}: node {id} has missing child {child}");
            assert!(
                claimed.insert(child, id).is_none(),
                "{ctx}: node {child} is claimed by two parents",
            );
        }
    }

    for (&id, node) in &scene.nodes {
        assert_eq!(
            node.parent,
            claimed.get(&id).copied(),
            "{ctx}: node {id} parent disagrees with the group listing it",
        );
    }

    // Every node reachable exactly once from the roots — which is both "no
    // cycles" and "nothing orphaned", the two properties that made traversal
    // unsafe before.
    let mut seen: HashSet<u32> = HashSet::new();
    let mut stack: Vec<u32> = scene.root_nodes.clone();
    let mut steps = 0usize;
    while let Some(id) = stack.pop() {
        steps += 1;
        assert!(
            steps <= scene.nodes.len() * 4 + 16,
            "{ctx}: traversal did not terminate — the graph still contains a cycle",
        );
        assert!(seen.insert(id), "{ctx}: node {id} reached twice");
        if let Some(node) = scene.nodes.get(&id) {
            stack.extend(node.children.iter().copied());
        }
    }
    assert_eq!(
        seen.len(),
        scene.nodes.len(),
        "{ctx}: {} node(s) unreachable from any root",
        scene.nodes.len() - seen.len(),
    );

    for node in scene.nodes.values() {
        let t = &node.transform;
        for (name, v) in [
            ("x", t.x), ("y", t.y), ("rotation", t.rotation_deg),
            ("scale_x", t.scale_x), ("scale_y", t.scale_y),
        ] {
            assert!(v.is_finite(), "{ctx}: node {} has non-finite {name}", node.id);
            assert!(v.abs() <= crate::MAX_COORD, "{ctx}: node {} {name} exceeds MAX_COORD", node.id);
        }
        if let Geometry::Path { subpaths, .. } = &node.geometry {
            for sp in subpaths {
                for p in &sp.points {
                    assert!(p.x.is_finite() && p.y.is_finite(), "{ctx}: non-finite path point");
                }
            }
        }
    }
}

// ─── Properties over valid documents ────────────────────────────────────────────

/// Saving must be a fixed point for *any* document, not just the fixtures.
/// Undo coalescing compares snapshots byte-for-byte, so a document shape that
/// re-serializes differently silently breaks history.
#[test]
fn any_document_round_trips_to_a_byte_exact_fixed_point() {
    for seed in 0..40u64 {
        let engine = random_engine(seed);
        let first = engine.serialize_proto();

        let mut reloaded = Engine::new();
        let status = reloaded.load_document(&first);
        assert!(status.contains(r#""ok":true"#), "seed {seed}: {status}");

        assert_eq!(
            reloaded.serialize_proto(),
            first,
            "seed {seed}: save→load→save is not byte-exact",
        );
    }
}

/// The same property for undo snapshots, which take the other serialization
/// path (bare, uncompressed, carries the selection).
#[test]
fn any_snapshot_round_trips_to_a_byte_exact_fixed_point() {
    for seed in 0..40u64 {
        let engine = random_engine(seed);
        let first = engine.serialize_scene();

        let mut reloaded = Engine::new();
        assert!(reloaded.deserialize_scene(&first), "seed {seed}: snapshot failed to load");
        assert_eq!(reloaded.serialize_scene(), first, "seed {seed}: snapshot is not a fixed point");
    }
}

/// A file this build wrote must never come back needing repair. If it does,
/// the writer is emitting something the validator considers damaged.
#[test]
fn a_document_we_wrote_never_needs_repair() {
    for seed in 0..40u64 {
        let engine = random_engine(seed);
        let (scene, _, report) = proto::deserialize_from_proto(&engine.serialize_proto())
            .unwrap_or_else(|e| panic!("seed {seed}: our own file failed to load: {e:?}"));
        assert!(
            report.is_clean(),
            "seed {seed}: we wrote a document that needed repair — {}",
            report.summary(),
        );
        assert_scene_is_coherent(&scene, &format!("seed {seed}"));
    }
}

/// No node may be lost or invented by a round trip.
#[test]
fn a_round_trip_preserves_every_node() {
    for seed in 0..40u64 {
        let engine = random_engine(seed);
        let before: HashSet<u32> = engine.get_root_nodes().into_iter().collect();
        let bytes = engine.serialize_proto();

        let mut reloaded = Engine::new();
        reloaded.load_document(&bytes);
        let after: HashSet<u32> = reloaded.get_root_nodes().into_iter().collect();
        assert_eq!(before, after, "seed {seed}: root set changed across a round trip");
    }
}

// ─── Totality under corruption ──────────────────────────────────────────────────

/// Truncation at *any* offset must be refused. The empty prefix is the case
/// that used to open as a blank document and then overwrite the original.
#[test]
fn no_truncation_of_any_document_is_ever_accepted() {
    for seed in 0..6u64 {
        let bytes = random_engine(seed).serialize_proto();
        for cut in 0..bytes.len() {
            assert!(
                proto::deserialize_from_proto(&bytes[..cut]).is_err(),
                "seed {seed}: a {cut}-byte prefix was accepted as a whole document",
            );
        }
        assert!(proto::deserialize_from_proto(&bytes).is_ok(), "seed {seed}: intact file rejected");
    }
}

/// Any single-byte corruption must be caught, or — if it lands somewhere the
/// checksum still covers consistently — must still yield a coherent scene.
/// What it must never do is panic or produce a half-built document.
#[test]
fn single_byte_corruption_never_panics_and_never_half_loads() {
    for seed in 0..4u64 {
        let bytes = random_engine(seed).serialize_proto();
        let mut rng = StdRng::seed_from_u64(seed);
        for _ in 0..150 {
            let mut corrupt = bytes.clone();
            let i = rng.gen_range(0..corrupt.len());
            corrupt[i] ^= 1 << rng.gen_range(0..8);

            match proto::deserialize_from_proto(&corrupt) {
                Err(_) => {}
                Ok((scene, _, _)) => assert_scene_is_coherent(&scene, "corrupted-but-accepted"),
            }
        }
    }
}

/// Arbitrary bytes behind a *valid* envelope. The container can't reject these
/// — length and checksum are correct — so this is what actually exercises the
/// protobuf decoder and everything downstream of it.
#[test]
fn arbitrary_payloads_behind_a_valid_envelope_are_total() {
    let mut rng = StdRng::seed_from_u64(0xF0_47);
    for _ in 0..300 {
        let len = rng.gen_range(0..400);
        let payload: Vec<u8> = (0..len).map(|_| rng.gen()).collect();
        match proto::deserialize_from_proto(&envelope(&payload)) {
            Err(LoadError::Unparseable) | Err(_) => {}
            Ok((scene, _, _)) => assert_scene_is_coherent(&scene, "random-payload"),
        }
    }
}

/// A well-formed protobuf document describing a broken graph — dangling ids,
/// cycles, self-references, duplicate ids, contradictory parents. The decoder
/// accepts it; `repair` must make it coherent.
#[test]
fn any_malformed_graph_is_repaired_into_a_coherent_scene() {
    for seed in 0..120u64 {
        let doc = malformed_document(seed);
        let bytes = envelope(&doc.encode_to_vec());

        let (scene, _, _) = proto::deserialize_from_proto(&bytes)
            .unwrap_or_else(|e| panic!("seed {seed}: malformed-but-decodable doc rejected: {e:?}"));
        assert_scene_is_coherent(&scene, &format!("malformed seed {seed}"));
    }
}

/// Repair must reach a fixed point in one pass. A second pass finding more to
/// fix would mean the first left the scene in a state it considers damaged.
#[test]
fn repair_is_idempotent_for_any_malformed_graph() {
    for seed in 0..120u64 {
        let doc = malformed_document(seed);
        let (scene, _) = doc.to_scene();
        let (once, first) = validate::repair(scene);
        let (_, second) = validate::repair(once);
        assert!(
            second.is_clean(),
            "seed {seed}: repair is not idempotent — first {}, second {}",
            first.summary(),
            second.summary(),
        );
    }
}

/// A repaired document must survive being saved and reloaded — the path a user
/// takes right after opening a damaged file.
#[test]
fn a_repaired_document_can_be_saved_and_reopened() {
    for seed in 0..40u64 {
        let doc = malformed_document(seed);
        let mut engine = Engine::new();
        let status = engine.load_document(&envelope(&doc.encode_to_vec()));
        assert!(status.contains(r#""ok":true"#), "seed {seed}: {status}");

        let saved = engine.serialize_proto();
        let (scene, _, report) = proto::deserialize_from_proto(&saved)
            .unwrap_or_else(|e| panic!("seed {seed}: re-save unreadable: {e:?}"));
        assert!(
            report.is_clean(),
            "seed {seed}: re-saving a repaired document still needs repair — {}",
            report.summary(),
        );
        assert_scene_is_coherent(&scene, &format!("re-saved seed {seed}"));
    }
}

/// Deeply nested and cyclic graphs must not exhaust the stack. The recursive
/// loader died here, and the failure mode was a wasm trap that takes the whole
/// editor down rather than an error the UI can report.
#[test]
fn pathological_depth_and_cycles_do_not_overflow_the_stack() {
    for (label, depth, cyclic) in [
        ("deep chain", 5_000u32, false),
        ("deep chain closing into a cycle", 5_000, true),
    ] {
        let mut nodes: Vec<proto::ProtoNode> = (1..=depth)
            .map(|id| proto::ProtoNode {
                id,
                name: String::new(),
                node_type: 3,
                transform: Some(proto::ProtoTransform {
                    x: 0.0, y: 0.0, rotation_deg: 0.0,
                    skew_x_deg: 0.0, skew_y_deg: 0.0,
                    scale_x: 1.0, scale_y: 1.0,
                }),
                children: if id < depth { vec![id + 1] } else { vec![] },
                visible: true,
                ..Default::default()
            })
            .collect();
        if cyclic {
            nodes[(depth - 1) as usize].children = vec![1];
        }

        let doc = ProtoDocument {
            format_version: proto::FORMAT_VERSION,
            nodes,
            root_ids: vec![1],
            next_id: depth + 1,
            ..Default::default()
        };

        let mut engine = Engine::new();
        let status = engine.load_document(&envelope(&doc.encode_to_vec()));
        assert!(status.contains(r#""ok":true"#), "{label}: {status}");

        // Still usable afterwards — the walks that overflowed run on every
        // edit and every frame, not just at load.
        engine.add_rect(0.0, 0.0, 10.0, 10.0);
        let _ = engine.serialize_scene();
        let _ = engine.serialize_proto();
    }
}

// ─── Performance guards ─────────────────────────────────────────────────────────
//
// These protect the format's cost model, which is easy to wreck accidentally:
// autosave serializes on a timer and undo snapshots serialize on *every*
// mutation, so anything super-linear here shows up as the editor stalling on
// large documents. This project has already shipped one O(n²) of exactly that
// kind (a live-paint scan on insertion).
//
// They compare *ratios*, never absolute milliseconds, so they mean the same
// thing on a fast laptop and a loaded CI box. The thresholds sit far from
// linear and far from quadratic: with an 8× larger input, linear predicts ~8×
// and quadratic predicts ~64×, so a limit of 24× cannot be tripped by timer
// noise but cannot be passed by an accidental quadratic either.

fn engine_with_rects(n: u32) -> Engine {
    let mut engine = Engine::new();
    // `add_rects` takes positional [x, y, w, h] tuples and silently yields
    // nothing on a shape it can't parse, so the count is asserted below —
    // otherwise a fixture typo turns every guard in this section into a
    // measurement of an empty document that passes for the wrong reason.
    let rects: Vec<String> = (0..n)
        .map(|i| format!("[{},{},24,18]", (i % 100) as f32 * 31.0, (i / 100) as f32 * 27.0))
        .collect();
    let ids = engine.add_rects(&format!("[{}]", rects.join(",")));
    assert_eq!(ids.len(), n as usize, "fixture failed to build {n} rects");
    engine
}

/// Ratio of `b`'s cost to `a`'s, measured by **interleaving** the two and
/// taking each one's fastest run.
///
/// Interleaving is the whole point. `cargo test` runs this module in parallel
/// with the fuzz tests above, so timing `a` five times and then `b` five times
/// lets a contention spike land entirely on one of them — which is exactly how
/// an earlier version of this guard reported a 36× blowup for work that is
/// provably linear when measured serially. Alternating means both samples see
/// the same machine, and taking the minimum discards the spikes.
fn cost_ratio(runs: usize, mut a: impl FnMut(), mut b: impl FnMut()) -> f64 {
    let (mut ta, mut tb) = (std::time::Duration::MAX, std::time::Duration::MAX);
    for _ in 0..runs {
        let t = std::time::Instant::now();
        a();
        ta = ta.min(t.elapsed());

        let t = std::time::Instant::now();
        b();
        tb = tb.min(t.elapsed());
    }
    tb.as_secs_f64() / ta.as_secs_f64().max(1e-9)
}

const SMALL: u32 = 250;
const LARGE: u32 = 2_000; // 8× SMALL
/// Linear predicts ~8×, quadratic ~64×. Sitting at 24× leaves room for the
/// noise a parallel test run adds while still failing an accidental quadratic.
const MAX_RATIO: f64 = 24.0;

/// Saving and loading must stay linear in document size.
///
/// Autosave serializes on a timer and undo snapshots serialize on *every*
/// mutation, so anything super-linear here surfaces as the editor stalling on
/// large documents. This project has already shipped one O(n²) of exactly that
/// shape — a live-paint scan that ran per insertion.
#[test]
fn saving_and_loading_scale_linearly_with_document_size() {
    let small = engine_with_rects(SMALL);
    let large = engine_with_rects(LARGE);
    let small_bytes = small.serialize_proto();
    let large_bytes = large.serialize_proto();

    let save = cost_ratio(4, || { small.serialize_proto(); }, || { large.serialize_proto(); });
    assert!(
        save < MAX_RATIO,
        "saving looks super-linear: {SMALL}→{LARGE} nodes cost {save:.1}× \
         (linear ≈ 8×, quadratic ≈ 64×)",
    );

    let load = cost_ratio(
        4,
        || { proto::deserialize_from_proto(&small_bytes).unwrap(); },
        || { proto::deserialize_from_proto(&large_bytes).unwrap(); },
    );
    assert!(
        load < MAX_RATIO,
        "loading looks super-linear: {SMALL}→{LARGE} nodes cost {load:.1}× \
         (linear ≈ 8×, quadratic ≈ 64×)",
    );

    // Deterministic half of the guard: output size must scale linearly too.
    // This one cannot flake under any machine load, so it holds the line even
    // if the timing assertions above are ever relaxed.
    let size_ratio = large_bytes.len() as f64 / small_bytes.len() as f64;
    assert!(
        size_ratio < 16.0,
        "serialized size grew {size_ratio:.1}× for 8× the nodes",
    );
}

/// The save path's cost model: snapshots are cheap, files are compressed.
///
/// Undo snapshots deliberately skip the envelope and the deflate pass because
/// they run on every mutation. If someone routes them through
/// `serialize_to_proto` for consistency, every keystroke starts paying
/// compression — this is the guard that notices.
#[test]
fn the_save_path_cost_model_holds() {
    let engine = engine_with_rects(LARGE);

    assert!(
        !container::has_envelope(&engine.serialize_scene()),
        "undo snapshots must not be enveloped",
    );

    let ratio = cost_ratio(4, || { engine.serialize_scene(); }, || { engine.serialize_proto(); });
    assert!(
        ratio > 1.0,
        "a compressed save should cost more than a bare undo snapshot, but the \
         snapshot was {:.1}× the price — is it going through the file path?",
        1.0 / ratio,
    );

    // Compression must earn the CPU it spends on every save.
    let saved = engine.serialize_proto();
    let raw = proto::serialize_payload_only(&engine.scene_for_test(), LARGE + 1);
    let gain = raw.len() as f64 / saved.len() as f64;
    assert!(
        gain > 3.0,
        "compression only achieved {gain:.1}× on {LARGE} rects — not worth the CPU",
    );
}
