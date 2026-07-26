//! End-to-end guarantees of the `.dadaki` file format.
//!
//! Each test here pins a property that was empirically *false* before the v8
//! container work, verified by probing the old code. They are deliberately
//! written against the public load/save entry points rather than the internals,
//! so they keep holding as the schema grows.

#![cfg(test)]

use crate::proto::{
    self, ProtoDocument, ProtoGeometry, ProtoNode, ProtoPath, ProtoSubpath, ProtoTransform,
    FORMAT_VERSION,
};
use crate::{container, ContainerError, Engine, LoadError};
use prost::Message;

fn ident() -> ProtoTransform {
    ProtoTransform {
        x: 0.0, y: 0.0, rotation_deg: 0.0,
        skew_x_deg: 0.0, skew_y_deg: 0.0,
        scale_x: 1.0, scale_y: 1.0,
    }
}

fn node(id: u32, children: Vec<u32>) -> ProtoNode {
    ProtoNode {
        id,
        name: format!("n{id}"),
        node_type: if children.is_empty() { 1 } else { 3 },
        transform: Some(ident()),
        geometry: Some(ProtoGeometry::rect(10.0, 10.0)),
        children,
        visible: true,
        ..Default::default()
    }
}

/// A bare (pre-v8) protobuf document, as older builds wrote them.
fn legacy_bytes(doc: &ProtoDocument) -> Vec<u8> {
    doc.encode_to_vec()
}

fn simple_doc() -> ProtoDocument {
    ProtoDocument {
        format_version: FORMAT_VERSION,
        nodes: vec![node(1, vec![])],
        root_ids: vec![1],
        next_id: 2,
        ..Default::default()
    }
}

// ─── The data-loss cases ────────────────────────────────────────────────────────

/// The original bug: the empty byte string is valid protobuf, so a save
/// truncated by a crash or a quota error opened as a blank document and
/// reported success — and autosave then wrote the blank over the original.
#[test]
fn an_empty_file_is_refused_rather_than_opening_blank() {
    let Err(err) = proto::deserialize_from_proto(&[]) else { panic!("empty input must not load") };
    assert_eq!(err, LoadError::Container(ContainerError::Empty));

    let mut engine = Engine::new();
    assert!(!engine.deserialize_proto(&[]));
    let status = engine.load_document(&[]);
    assert!(status.contains(r#""ok":false"#), "{status}");
    assert!(status.contains(r#""error":"empty""#), "{status}");
}

/// Every truncation of a real file must be refused, not silently accepted as a
/// smaller document. Previously 3 of 83 prefixes decoded "successfully".
#[test]
fn no_truncated_prefix_is_ever_accepted() {
    let scene = Engine::new().scene_for_test();
    let full = proto::serialize_to_proto(&scene, 1);
    for cut in 0..full.len() {
        assert!(
            proto::deserialize_from_proto(&full[..cut]).is_err(),
            "a {cut}-byte prefix was accepted as a complete document"
        );
    }
    assert!(proto::deserialize_from_proto(&full).is_ok());
}

/// Corruption in the payload must be caught by the checksum rather than
/// producing a plausible-but-wrong document.
#[test]
fn corrupted_bytes_are_detected() {
    let doc = simple_doc();
    let wrapped = container::wrap(&doc.encode_to_vec(), 2);
    let mut corrupted = wrapped.clone();
    let last = corrupted.len() - 1;
    corrupted[last] ^= 0xFF;
    assert!(proto::deserialize_from_proto(&corrupted).is_err());
}

// ─── Forward compatibility ──────────────────────────────────────────────────────

/// The central future-proofing guarantee. prost cannot preserve fields it does
/// not know, so a build that would silently drop them must decline to open the
/// file instead. Before this, an old build opened a newer file, discarded
/// everything it didn't understand, and stamped it with its own version.
#[test]
fn a_document_needing_a_newer_reader_is_refused_not_silently_downgraded() {
    let future = container::wrap(&simple_doc().encode_to_vec(), FORMAT_VERSION + 1);

    let Err(err) = proto::deserialize_from_proto(&future) else { panic!("a too-new file must not load") };
    assert_eq!(err.required_version(), Some(FORMAT_VERSION + 1));

    let mut engine = Engine::new();
    let status = engine.load_document(&future);
    assert!(status.contains(r#""error":"too_new""#), "{status}");
    assert!(status.contains(&format!(r#""requiredVersion":{}"#, FORMAT_VERSION + 1)), "{status}");
}

/// Refusing to open must leave the document already on screen intact. The old
/// path assigned the scene before it knew the load had worked.
#[test]
fn a_failed_load_does_not_disturb_the_open_document() {
    let mut engine = Engine::new();
    engine.add_rect(5.0, 5.0, 50.0, 50.0);
    let before = engine.serialize_scene();

    let future = container::wrap(&simple_doc().encode_to_vec(), FORMAT_VERSION + 1);
    assert!(engine.load_document(&future).contains(r#""ok":false"#));
    assert!(engine.load_document(&[]).contains(r#""ok":false"#));
    assert!(engine.load_document(b"not a dadaki file at all").contains(r#""ok":false"#));

    assert_eq!(engine.serialize_scene(), before, "a rejected load mutated the scene");
}

/// The floor is content-dependent: a plain document stays openable by old
/// builds, and only documents using newer features raise it.
#[test]
fn the_version_floor_tracks_the_features_actually_used() {
    let plain = simple_doc();
    assert_eq!(
        proto::required_reader_version(&plain),
        2,
        "a plain document must not lock itself to a new build"
    );

    let mut with_network = simple_doc();
    with_network.nodes[0].geometry = Some(ProtoGeometry::path(ProtoPath {
        subpaths: vec![ProtoSubpath { points: vec![], closed: false }],
        network: Some(Default::default()),
        ..Default::default()
    }));
    assert_eq!(proto::required_reader_version(&with_network), 3);

    let mut with_fonts = simple_doc();
    with_fonts.fonts.push(proto::ProtoFontFace {
        family: "Inter".into(), weight: 400, italic: false,
        bytes: vec![0, 1, 2], source: "test".into(),
    });
    assert_eq!(proto::required_reader_version(&with_fonts), 8);
}

/// A geometry or paint variant from a future build is unnameable here, so the
/// floor jumps to the current version — the file is refused rather than opened
/// with the unknown node degraded into a plain rectangle.
#[test]
fn an_unknown_variant_raises_the_floor_to_refusal() {
    let mut doc = simple_doc();
    doc.nodes[0].geometry = Some(ProtoGeometry { kind: None });
    assert_eq!(proto::required_reader_version(&doc), FORMAT_VERSION);
}

// ─── Crash safety ───────────────────────────────────────────────────────────────

/// Opening a file whose node graph contains a cycle used to stack-overflow the
/// wasm instance — an unrecoverable trap from merely opening a document.
#[test]
fn a_cyclic_document_loads_without_crashing() {
    let doc = ProtoDocument {
        format_version: FORMAT_VERSION,
        nodes: vec![node(1, vec![2]), node(2, vec![1])],
        root_ids: vec![1],
        next_id: 3,
        ..Default::default()
    };

    let mut engine = Engine::new();
    let status = engine.load_document(&legacy_bytes(&doc));
    assert!(status.contains(r#""ok":true"#), "{status}");
    assert!(status.contains(r#""repaired":true"#), "{status}");

    // And the engine is still usable afterwards — the walks that overflowed are
    // exercised by rendering and by any further edit.
    engine.add_rect(0.0, 0.0, 10.0, 10.0);
    let _ = engine.serialize_scene();
}

/// A self-referencing node is the degenerate case of the same bug.
#[test]
fn a_self_referencing_node_loads_without_crashing() {
    let doc = ProtoDocument {
        format_version: FORMAT_VERSION,
        nodes: vec![node(1, vec![1])],
        root_ids: vec![1],
        next_id: 2,
        ..Default::default()
    };
    let mut engine = Engine::new();
    assert!(engine.load_document(&legacy_bytes(&doc)).contains(r#""ok":true"#));
}

/// Structural damage short of a cycle is repaired and reported, not ignored.
#[test]
fn dangling_references_are_repaired_and_reported() {
    let doc = ProtoDocument {
        format_version: FORMAT_VERSION,
        nodes: vec![node(1, vec![2, 42]), node(2, vec![])],
        root_ids: vec![1, 777],
        next_id: 3,
        ..Default::default()
    };
    let mut engine = Engine::new();
    let status = engine.load_document(&legacy_bytes(&doc));
    assert!(status.contains(r#""ok":true"#), "{status}");
    assert!(status.contains(r#""dangling_roots":1"#), "{status}");
    assert!(status.contains(r#""dangling_children":1"#), "{status}");
    assert_eq!(engine.get_root_nodes(), vec![1], "the phantom root must be gone");
}

// ─── Back-compatibility with pre-envelope files ─────────────────────────────────

/// Bare protobuf files written before v8 must still open.
#[test]
fn legacy_bare_protobuf_files_still_open() {
    let mut engine = Engine::new();
    let status = engine.load_document(&legacy_bytes(&simple_doc()));
    assert!(status.contains(r#""ok":true"#), "{status}");
    assert_eq!(engine.get_root_nodes(), vec![1]);
}

/// ...and are re-saved in the new enveloped form.
#[test]
fn opening_a_legacy_file_and_saving_produces_an_enveloped_one() {
    let mut engine = Engine::new();
    assert!(engine.deserialize_proto(&legacy_bytes(&simple_doc())));
    let saved = engine.serialize_proto();
    assert!(container::has_envelope(&saved), "re-saved file must carry the envelope");
    assert!(proto::deserialize_from_proto(&saved).is_ok());
}

// ─── Round-trip fidelity ────────────────────────────────────────────────────────

/// Everything the format carries must survive a save/load cycle unchanged.
#[test]
fn a_full_document_round_trips_through_a_real_save() {
    let mut engine = Engine::new();
    engine.add_rect(10.0, 20.0, 100.0, 50.0);
    engine.add_ellipse(200.0, 200.0, 40.0, 30.0);
    engine.set_swatches_json(r#"[{"r":1,"g":0,"b":0,"a":1}]"#.into());
    engine.set_markers_json(r#"{"1":{"start":"arrow","end":"circle"}}"#.into());
    engine.set_text_paths_json(r#"{"7":9}"#.into());
    engine.set_guide_locks_json(r#"{"x":[10,20],"y":[30]}"#.into());
    engine.set_document_meta("doc-uuid-1".into(), 1000.0, 2000.0, "1.2.3".into(), "My Art".into());

    let saved = engine.serialize_proto();

    let mut reloaded = Engine::new();
    assert!(reloaded.load_document(&saved).contains(r#""ok":true"#));

    // Compared as parsed values, not as strings: the editor's input is
    // re-rendered in the format's canonical form (sorted keys, explicit
    // floats), which is deliberate — see `from_scene`.
    // Numbers are compared as f64: serde_json's `Value` treats 1 and 1.0 as
    // different, but the format stores every coordinate as a float.
    fn canonical(v: &serde_json::Value) -> serde_json::Value {
        match v {
            serde_json::Value::Number(n) => {
                serde_json::json!(n.as_f64().unwrap_or(f64::NAN).to_string())
            }
            serde_json::Value::Array(a) => {
                serde_json::Value::Array(a.iter().map(canonical).collect())
            }
            serde_json::Value::Object(o) => serde_json::Value::Object(
                o.iter().map(|(k, x)| (k.clone(), canonical(x))).collect(),
            ),
            other => other.clone(),
        }
    }
    let same_json = |a: String, b: String| {
        let pa: serde_json::Value = serde_json::from_str(&a).unwrap();
        let pb: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(canonical(&pa), canonical(&pb));
    };
    same_json(reloaded.get_swatches_json(), engine.get_swatches_json());
    same_json(reloaded.get_markers_json(), engine.get_markers_json());
    same_json(reloaded.get_text_paths_json(), engine.get_text_paths_json());
    same_json(reloaded.get_guide_locks_json(), engine.get_guide_locks_json());
    assert_eq!(reloaded.get_document_uuid(), "doc-uuid-1");
    assert_eq!(reloaded.get_document_title(), "My Art");
    assert_eq!(reloaded.get_root_nodes(), engine.get_root_nodes());
}

/// The typed fields, not the deprecated JSON strings, are what a v8 reader
/// consumes — proven by blanking the JSON and checking the values survive.
#[test]
fn the_typed_fields_are_authoritative_over_the_deprecated_json() {
    let mut engine = Engine::new();
    engine.set_swatches_json(r#"[{"r":0.25,"g":0.5,"b":0.75,"a":1}]"#.into());
    engine.set_markers_json(r#"{"3":{"start":"square"}}"#.into());

    let saved = engine.serialize_proto();
    let payload = container::unwrap(&saved, FORMAT_VERSION).unwrap();
    let mut doc = ProtoDocument::decode(&payload[..]).unwrap();

    assert_eq!(doc.swatches.len(), 1, "typed swatches must be written");
    assert_eq!(doc.markers.len(), 1, "typed markers must be written");

    // Simulate the post-deprecation world: only the typed form remains.
    doc.swatches_json = String::new();
    doc.markers_json = String::new();
    let stripped = container::wrap(&doc.encode_to_vec(), 2);

    let mut reloaded = Engine::new();
    assert!(reloaded.load_document(&stripped).contains(r#""ok":true"#));
    assert!(reloaded.get_swatches_json().contains("0.25"), "{}", reloaded.get_swatches_json());
    assert!(reloaded.get_markers_json().contains("square"), "{}", reloaded.get_markers_json());
}

/// Both forms are written during the deprecation window, so a v7 reader — which
/// knows only the JSON strings — still finds its data.
#[test]
fn the_deprecated_json_is_still_written_for_older_readers() {
    let mut engine = Engine::new();
    engine.set_swatches_json(r#"[{"r":1,"g":0,"b":0,"a":1}]"#.into());
    let payload = container::unwrap(&engine.serialize_proto(), FORMAT_VERSION).unwrap();
    let doc = ProtoDocument::decode(&payload[..]).unwrap();
    assert!(!doc.swatches_json.is_empty(), "v7 readers would lose their swatches");
}

// ─── Compression ────────────────────────────────────────────────────────────────

/// Geometry is repetitive and compresses well; this is the payoff for the
/// envelope carrying a compression flag.
#[test]
fn a_realistic_document_compresses_substantially() {
    let mut engine = Engine::new();
    for i in 0..500 {
        engine.add_rect(i as f32 * 1.7, i as f32 * 2.3, 40.0, 25.0);
    }
    let saved = engine.serialize_proto();
    let raw = proto::serialize_to_proto_bare(&engine.scene_for_test(), 501);

    assert!(
        saved.len() * 2 < raw.len(),
        "expected >2x compression, got {} -> {}",
        raw.len(),
        saved.len()
    );
    // And it still round-trips.
    assert!(proto::deserialize_from_proto(&saved).is_ok());
}

// ─── Undo snapshots stay bare and byte-exact ────────────────────────────────────

/// Undo snapshots must NOT gain the envelope: they are produced on every
/// mutation and compared byte-for-byte to coalesce history. Compressing them
/// would cost time on every edit and put a checksum in the comparison path.
#[test]
fn undo_snapshots_are_not_enveloped_and_stay_a_fixed_point() {
    let mut engine = Engine::new();
    engine.add_rect(1.0, 2.0, 3.0, 4.0);

    let snap = engine.serialize_scene();
    assert!(!container::has_envelope(&snap), "undo snapshots must stay bare protobuf");

    let mut other = Engine::new();
    other.deserialize_scene(&snap);
    assert_eq!(other.serialize_scene(), snap, "snapshot round-trip must be byte-exact");
}

/// The undo fixed point must hold for the editor-owned blobs too.
///
/// These are stored as JSON strings but written to the file as typed messages
/// and regenerated from them on load, so a naive implementation makes the first
/// save/load hop rewrite the string and undo coalescing silently stops working
/// as soon as a document has a swatch.
#[test]
fn documents_with_editor_blobs_are_a_snapshot_fixed_point() {
    let mut engine = Engine::new();
    engine.add_rect(1.0, 2.0, 3.0, 4.0);
    // Deliberately un-canonical input: unsorted keys, integer-valued floats.
    engine.set_swatches_json(r#"[{"r":1,"g":0,"b":0,"a":1}]"#.into());
    engine.set_markers_json(r#"{"1":{"end":"circle","start":"arrow"}}"#.into());
    engine.set_guide_locks_json(r#"{"y":[30],"x":[10,20]}"#.into());

    let first = engine.serialize_scene();
    let mut round = Engine::new();
    round.deserialize_scene(&first);
    assert_eq!(
        round.serialize_scene(),
        first,
        "serialize→deserialize→serialize must be byte-exact with editor blobs present"
    );
}

/// Document metadata must not be invented during serialization, or two
/// snapshots of an unchanged scene would differ and undo coalescing would break.
#[test]
fn metadata_does_not_make_snapshots_unstable() {
    let mut engine = Engine::new();
    engine.add_rect(1.0, 2.0, 3.0, 4.0);
    engine.set_document_meta("uuid".into(), 111.0, 222.0, "1.0.0".into(), "T".into());

    let a = engine.serialize_scene();
    let b = engine.serialize_scene();
    assert_eq!(a, b, "serializing twice must produce identical bytes");
}
