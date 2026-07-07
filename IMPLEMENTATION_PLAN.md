# Implementation Plan — Engine Hardening + SVG Feature Parity

Audience: an implementing AI model (or engineer) with no prior context on this repo.
Read this entire document before writing code. Phases are ordered by dependency;
parallelization rules are explicit in each phase header.

---

## 1. Project context

Browser vector editor. Rust/WASM engine + TypeScript UI, rendered with CanvasKit (Skia) on WebGL.

| Area | Location | Notes |
|---|---|---|
| Engine core | `engine/src/lib.rs` (~4100 lines) | Scene graph, hit-testing, render-buffer writer, History |
| Vector networks | `engine/src/vector_network.rs` | Graph-based path editing, live-paint faces |
| Persistence codec | `engine/src/proto.rs` | Protobuf (prost) — used for `.vec` files and SVG-embedded payloads |
| Transform invariants | `engine/src/transform_invariants.rs` | Property test suite — must keep passing |
| WASM bindings output | `engine/pkg/` (gitignored), mirrored to `engine-wasm/` | Imported by `src/wasm_scene.ts` |
| JS engine wrapper | `src/wasm_scene.ts` | `WasmScene` — ALL mutations go through here (undo discipline) |
| Renderer | `src/renderer.ts` | Reads binary render buffer, draws via CanvasKit |
| Input/tools | `src/input.ts` | Pointer/keyboard handling |
| UI shell | `src/ui.ts` | `UIEngine` — panels, SVG import (`processElement` around line 1968), export glue |
| SVG import helpers | `src/svg_utils.ts` | Path-d parser, transform parser, gradient resolution |
| SVG export | `src/svg_export.ts` | Pure function `buildSVGFromData` (testable without WASM) |
| File I/O | `src/file_io.ts` | `.vec` save/load, autosave; embeds protobuf payload in exported SVG |

### Build & test commands (non-standard — memorize these)

- `npm run` / `pnpm run` / `npx` are ALL broken in this repo (devEngines pin). Use binaries directly:
  - Tests + typecheck: `./test-all.sh` (runs `cargo test` for the engine, then `./node_modules/.bin/vitest run`)
  - Vitest alone: `./node_modules/.bin/vitest run`
- The system rustc lacks the wasm32 target. To rebuild the WASM engine after ANY `engine/src/*.rs` change:
  ```sh
  export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
  cd engine && ./wasm-pack-v0.12.1-x86_64-apple-darwin/wasm-pack build --target web --out-dir pkg
  ```
  If you skip the rebuild, the JS renderer parses a stale/garbled buffer.
- Dev builds expose `window.__editor` (`{scene, ui, input, renderer}`) for scripted browser verification.

### Non-negotiable invariants (violating these has already caused shipped bugs)

1. **Bincode is positional.** Until Phase 0.1 lands, every field on any type reachable from
   `Scene` must use plain `#[serde(default)]` — never `skip_serializing_if`. After Phase 0.1,
   bincode is gone and this rule is retired.
2. **Undo discipline lives in JS.** Every user-visible mutation must go through a `WasmScene`
   wrapper method that calls `saveHistory()` before the engine call (pattern: `setFaceFill` in
   `src/wasm_scene.ts`). Raw `scene.engine.xyz()` calls from input/UI handlers are undo bugs.
   Multi-mutation operations wrap in `scene.transaction(fn)`; multi-event gestures use
   `beginGesture()`/`endGesture()`. These contracts are pinned by `src/gesture_history.test.ts`.
3. **Render protocol is a lockstep pair.** The writer is `write_node_recursive` in
   `engine/src/lib.rs`; the reader is `Renderer.render()` in `src/renderer.ts`. The stream is
   u32-aligned (4-byte alignment everywhere, strings padded) so the renderer takes zero-copy
   Float32Array views. Any layout change requires editing BOTH sides + WASM rebuild.
   Current per-node style block: 13×f32 (fill rgba ×4 … see writer). A `debug_assert` in
   the writer guards alignment.
4. **Transforms:** `Transform2D` is a decomposed representation (T·R·Kx·Ky·S); matrices are
   derived. Mutations must keep `Transform2D::is_valid()` true; setters reject/roll back.
5. **Every serialized-model change** (new field on Node/Style/Geometry/Paint) needs, in the same
   change: serde default, a `ProtoXxx` field with a NEW tag number (never reuse/renumber tags),
   round-trip coverage in `engine/src/proto.rs` tests, and — if rendered — protocol writer+reader.
6. After engine edits: `./test-all.sh` green + wasm-pack rebuild. After UI edits: vitest green.

---

## 2. Phase 0 — Engine hardening (SEQUENTIAL — must fully land before anything else)

Rationale: every later feature adds serialized fields and mutates the render protocol.
These two tasks eliminate the two classes of silent corruption those changes would risk.

### Task 0.1 — Replace bincode undo/drag snapshots with protobuf

**Problem.** `Engine::serialize_scene()` / `deserialize_scene()` (`engine/src/lib.rs` ~1854/~1415)
use `bincode`, which is positional: a conditionally-skipped or reordered field corrupts the whole
stream. This silently broke undo once already. It also forces the hand-maintained `BincodePaint`
mirror struct (~line 79) and custom `Serialize`/`Deserialize` impls for `Paint`.

**Design.**
- Add to `engine/src/proto.rs` a snapshot wrapper message:
  ```rust
  pub struct ProtoSnapshot {
      #[prost(message, optional, tag = "1")] pub document: Option<ProtoDocument>,
      #[prost(uint32, repeated, tag = "2")]  pub selection: Vec<u32>,
  }
  ```
  `ProtoDocument` deliberately omits selection (files shouldn't carry it), but undo snapshots
  MUST preserve it — `deserialize_from_proto` currently resets `selection: Vec::new()`.
  Audit for any other `Scene` state that `ProtoDocument` drops (compare `Scene` fields —
  `nodes, root_nodes, selection, vector_network, document_width, document_height` — against
  `serialize_to_proto`/`deserialize_from_proto`); anything dropped must be added to
  `ProtoSnapshot` or `ProtoDocument` (new tags only). Note: verify that per-node vector
  networks (`Geometry::Path.network`) and live-paint face fills survive; there are existing
  round-trip tests in proto.rs to extend.
- Reimplement `serialize_scene`/`deserialize_scene` on top of `ProtoSnapshot`. Keep the exact
  same public WASM signatures (`Vec<u8>` in/out, `bool` return) — `src/wasm_scene.ts` and the
  `History` class must not need changes.
- `next_id`: snapshots currently restore it implicitly? Check `deserialize_scene` — if it does
  not restore `next_id`, preserve the existing behavior exactly (undo must not regress node-id
  allocation). `ProtoDocument` already carries `next_id` (tag 4); wire it through the same way
  the current code does, no differently.
- Delete: `BincodePaint`, the custom `impl Serialize/Deserialize for Paint` (replace with
  plain `#[derive(Serialize, Deserialize)]` + `#[serde(untagged)]` ONLY if JSON round-trip
  from JS still works — there is JS code that sends paints as JSON via `setNodeStyle`; verify
  gradient-vs-solid disambiguation, which currently keys off the presence of `gradient_type`.
  If untagged serde is ambiguous, keep the custom JSON impls but delete only the bincode arm).
  Remove the `bincode` dependency from `engine/Cargo.toml` if nothing else uses it.
- Update stale comments: the "bincode is positional" warnings in lib.rs (e.g. on
  `Geometry::Path.network`) and the doc comment on `deserialize_scene`.

**Watch out.**
- `src/gesture_history.test.ts` asserts undo-coalescing via **byte-equal** `serialize_scene()`
  snapshots. Protobuf encoding of a `HashMap`-backed node table may be non-deterministic in
  iteration order. `serialize_to_proto` must emit nodes in a deterministic order (e.g. sort by
  id before encoding) or those tests become flaky. Check current behavior and make ordering
  explicit either way.
- Drag-restore also uses these snapshots (see callers of `serialize_scene` in input paths).

**Acceptance.**
- `./test-all.sh` fully green, including `gesture_history.test.ts` and the existing snapshot
  round-trip tests in lib.rs (~line 3918 region — update names/comments referencing bincode).
- New proto.rs test: snapshot round-trip preserves selection, document size, per-node networks,
  face fills, and `next_id`.
- Two consecutive `serialize_scene()` calls on an unchanged scene are byte-identical
  (determinism test).
- Manual: build wasm, run editor, draw shapes, undo/redo across a drag, a gradient edit, a
  corner-radius edit, and a vector-network edit.

### Task 0.2 — Version + guard the render protocol

**Problem.** The hand-rolled byte stream between `write_node_recursive` (lib.rs) and
`Renderer.render()` (renderer.ts) has no version marker and no per-record framing. Writer/reader
skew (the #1 upcoming risk — Phases 1A, 2A, 2B all touch the layout) produces silently garbled
rendering instead of a loud error.

**Design.**
- Prepend a header to the render buffer: magic `u32` (e.g. `0x56454331` "VEC1") + protocol
  version `u32` (start at `1`). Renderer checks both; on mismatch it throws with a clear
  message ("engine/pkg is stale — rebuild wasm") instead of rendering garbage.
- Per-node framing: writer emits each node record's byte length (u32) before the record;
  reader, after consuming a record, asserts its cursor advanced exactly that many bytes
  (throw in dev, `console.error` + resync-by-skip in prod). This turns any future skew into
  an immediate, located failure.
- Define the version constant ONCE in Rust and export it via wasm-bindgen (e.g.
  `Engine::protocol_version()`); the JS reader compares against the buffer header, not a
  hardcoded JS constant.
- Bump the version in every later task that changes the layout (called out per-task below).

**Acceptance.**
- Rust unit test: buffer starts with magic+version; per-node length matches actual bytes for a
  scene containing every node type (rect/ellipse/path with network/text/group, gradient +
  dashed stroke + multiple fills).
- JS: renderer throws on wrong magic/version (unit-testable by handing it a doctored buffer,
  or at minimum verified manually).
- Manual render check of an existing document looks identical (screenshot compare by eye).

---

## 3. Phase 1 — Parallel tracks (start only after Phase 0 is merged)

Tracks A–D touch disjoint files and may be implemented in parallel branches/worktrees.
Track A is the largest and is the critical path for Phase 2.

### Track A — Masks & clipping (the headline feature)

**Model design — Figma-style node properties, NOT SVG-style referenced defs:**

1. `clips_content: bool` on `Node` (meaningful for Groups; serde + proto default `false`).
   When true, children render clipped to the union geometry of a designated clip source:
   for v1, the group's first child when that child has `is_clip: false`… — NO. Keep v1 simple:
   `clips_content` clips children to the group's own bounding box is meaningless for free
   groups. **v1 semantics:** clipping/masking is expressed ONLY via `is_mask` (below);
   `clips_content` is reserved for a future frame/artboard node — do not implement it now.
2. `is_mask: bool` on `Node` (any leaf or group). Semantics (Figma-compatible):
   within a group's child list, a child with `is_mask=true` masks ALL SIBLINGS ABOVE it
   (later in paint order) until the end of the group. The mask node itself does not paint.
   v1 supports **alpha masks** (mask alpha channel gates siblings). Luminance masks are a
   follow-up; leave a `mask_type: u8` (0=alpha) field so the format doesn't churn — serde
   default 0, proto default 0.

**Engine changes (`engine/src/lib.rs`, `engine/src/proto.rs`):**
- `Node { is_mask: bool, mask_type: u8 }` with `#[serde(default)]`; `ProtoNode` new tags
  (next free tags — inspect ProtoNode, currently up to tag 10; use 11, 12).
- WASM setters: `set_is_mask(id, bool)` (+ getter or include in existing node-info JSON that
  the UI reads — find how `visible`/`locked` are exposed and mirror that exactly).
- Render protocol: add `is_mask` + `mask_type` to the per-node record (keep u32 alignment;
  pack as one u32 flags field or extend the existing `style_flags` u32 — bits 0–15 are free,
  blend_mode uses 16–23, fill_rule 24–31; document the packing in a comment at BOTH writer
  and reader). **Bump protocol version.**
- Hit-testing: a node with `is_mask=true` should not be hit-tested as normal content is a
  UX decision — v1: keep it hittable/selectable (Figma does), but clipped-away sibling areas
  still hit (acceptable v1 simplification; note it in code).
- `serialize_scene` snapshots pick the fields up automatically post-0.1; add proto round-trip
  test for both fields.

**Renderer (`src/renderer.ts`):**
- When entering a group's children loop, scan for mask children. For each contiguous
  "masked span" (mask child M, then siblings above it):
  1. `canvas.saveLayer()` (span layer)
  2. draw the span's sibling content normally
  3. `canvas.saveLayer(paint with BlendMode.DstIn)`
  4. draw M's own content (its fills/strokes, full opacity)
  5. `restore()` × 2
- The mask node is skipped in the normal draw pass.
- Group opacity already uses `saveLayer` (~line 400); compose correctly (opacity layer
  outermost). Mind the pre-existing path cache (`_pathCache`) — reuse it for mask geometry.
- Note the render buffer is flat with explicit group push/pop commands — inspect how groups
  open/close in the reader loop and hook mask-span state there (a small stack mirroring the
  group stack).

**SVG export (`src/svg_export.ts` + `collectNodeData` in `src/ui.ts`):**
- A masked span exports as `<g mask="url(#maskN)">` wrapping the sibling content, with a
  `<mask id="maskN" mask-type="alpha">` in `<defs>` containing the mask node's rendered
  markup. (SVG `mask-type="alpha"` matches our v1 semantics; also set
  `style="mask-type:alpha"` for Firefox compatibility.)
- If the mask node is a plain filled path/rect/ellipse with a solid opaque fill, prefer
  exporting a `<clipPath>` instead (smaller, better-supported); this is an optimization —
  correctness first with `<mask>`.
- Round-trip test in `src/svg_roundtrip.test.ts`: masked group exports and re-imports into an
  equivalent structure.

**SVG import (`src/ui.ts` `processElement`, `src/svg_utils.ts`):**
- Stop skipping `clip-path`/`mask` ATTRIBUTES (the defs elements stay skipped as direct
  render targets).
- Element with `clip-path="url(#id)"`: resolve the `<clipPath>`, import its child shapes as
  nodes with `is_mask=true` (opaque black fill → alpha mask equivalent), group them with the
  clipped element: `[maskNode, content]` with mask FIRST in child order (verify our paint-order
  convention: index 0 = bottom-most; the mask must be the bottom-most child per the semantics
  above — reconcile with "masks siblings above it").
- Element with `mask="url(#id)"`: same, importing the mask contents as-is (alpha approximation
  of luminance is acceptable v1; add a code comment).
- `clipPathUnits`/`maskUnits` `objectBoundingBox` → scale the imported mask shapes by the
  target's bbox (same approach as gradient objectBoundingBox handling in `resolveGradient`).
- Nested/unsupported cases (clip-path on a `<g>` with its own mask, `clip-rule`): import
  best-effort, never crash; add tests for at least: rect clip on path, group clip, mask with
  gradient fill, `objectBoundingBox` units.

**UI (`src/ui.ts`, `src/context_bar.ts`, layer panel):**
- "Use as mask" toggle: context-bar button + right-click menu item when selection is inside a
  group with siblings. Mutation via a new `WasmScene.setIsMask(id, v)` wrapper (saveHistory +
  invalidateCache + autosave — copy the `setFaceFill` pattern).
- Layer panel: mask rows get a distinct icon (add to `src/icons.ts`) and indent/marker.
- Keyboard: none for v1.

**Acceptance (Track A).**
- Engine tests: proto round-trip, snapshot round-trip, flags in render buffer.
- JS tests: import cases above; export round-trip; gesture test still green.
- Manual: create two shapes + a mask sibling, toggle "use as mask", verify masking live,
  undo/redo the toggle, save/reload `.vec`, export SVG and open in a browser — identical.

### Track B — PNG export (parallel-safe: renderer.ts + ui.ts button only)

- Add `Renderer.exportPNG(scale: number): Promise<Blob>`:
  render the document rect (0,0,document_width,document_height) — NOT the current viewport —
  into an offscreen CanvasKit surface at `scale`× (1x/2x/4x), `surface.makeImageSnapshot()`
  → `img.encodeToBytes()` → Blob. Reuse the existing buffer-reading draw path; factor the
  world-draw loop so screen rendering and export share it rather than duplicating. Exclude all
  overlays (selection, snap guides, artboard chrome). Background: transparent.
- UI: "Export PNG" button next to the existing `export-svg` (`ui.ts` ~416, `exportSVG` ~1523),
  simple 1x/2x choice is enough for v1.
- Acceptance: exported PNG of a known scene has correct dimensions
  (`document_width×scale`), non-empty, spot-checked visually; no interference with the live
  canvas (restore GL state / use a separate surface).

### Track C — Gradient import fidelity (parallel-safe: svg_utils.ts + its tests only)

In `resolveGradient` (`src/svg_utils.ts` ~761):
1. **`gradientTransform`** (the common real-world breakage — Figma/Illustrator exports):
   parse with the existing `parseSVGTransform`, apply the matrix to the gradient's
   start/end (and radial center/radius vector) when converting to node-local space.
   Note the engine `Gradient` is a 2-point model — a general matrix on a radial gradient can
   produce ellipses we can't represent; take the major-axis approximation and comment it.
2. **`spreadMethod`**: engine model has no spread — clamp (current behavior) for `pad`;
   for `repeat`/`reflect`, approximate by synthesizing repeated stops across an extended
   start→end span (cap at ~4 repetitions), or document-and-skip if the approximation looks
   worse than clamping. Decide by visual test; either way add a test locking the choice.
3. **Focal radials (`fx`/`fy`)**: engine can't represent focal offset — map focal point to
   center approximation, comment it, test that it doesn't crash and stays within bounds.
4. Also honor `href`/`xlink:href` template inheritance for ALL attributes (stops already
   chain — verify coordinates/transform inherit too; the current hop loop only chases stops).
- Acceptance: new cases in `src/svg_utils.test.ts` with exact expected coordinates for a
  rotated linear gradient and a translated radial; existing 429-line suite stays green.

### Track D — Repo hygiene (parallel-safe: root files only)

- Delete `old_lib.rs` (142 KB — it's in git history), `debug_bounds.ts`.
- Move `puppeteer_bounds.ts`, `puppeteer_test_flatten.ts`, `renderer_test.ts`, `test_ck.cjs`
  into a `scripts/` dir (they're ad-hoc harnesses; keep them runnable) or delete if broken —
  try running each first; report which still work.
- `.gitignore`: ensure `dist/`, `.DS_Store`, `.idea/` are ignored; `git rm --cached` anything
  tracked that shouldn't be.
- Acceptance: `./test-all.sh` green; `git status` clean; app still builds (`./node_modules/.bin/vite build`).

---

## 4. Phase 2 — Sequential features (each starts only after Track A is merged; 2A before 2B)

These share the same hot files as masks (NodeType/Geometry, proto tags, render protocol,
renderer reader). Do NOT parallelize them with Track A or with each other unless you accept
rebase pain on `lib.rs`.

### Task 2A — Raster images

- **Model:** new `NodeType::Image` + `Geometry::Image { width: f32, height: f32, image_id: u32 }`.
  Image bytes live in a scene-level store: `Scene.images: HashMap<u32, ImageData>` where
  `ImageData { bytes: Vec<u8> /* original encoded PNG/JPEG */, mime: String }`, serde default.
  Rationale: bytes-in-scene keeps `.vec` self-contained and snapshots consistent; encoded
  (not raw RGBA) keeps memory sane. Dedupe by content hash on insert.
  - Undo snapshots (post-0.1) will re-serialize image bytes per snapshot — mitigate: images
    are immutable and content-addressed, so in `serialize_to_proto` for SNAPSHOTS this is
    still O(bytes). Acceptable for v1 (documents are small); leave a `// PERF:` note.
- **Proto:** `ProtoImageData` (id, bytes, mime) repeated on `ProtoDocument` (new tag), `ProtoGeometry.image`
  (new tag). Round-trip test with a tiny 1×1 PNG.
- **Engine API:** `add_image(x, y, w, h, image_id)`, `register_image(bytes, mime) -> u32`.
  Render protocol: new node-type tag (5) + geometry record `{w, h, image_id}`; **bump version**.
  Bounds/hit-test: rect semantics (mirror the `Rect` arms in bounds, hit-test, `node_type_u32`,
  and every `match` on `Geometry`/`NodeType` — the compiler will list them; do not add
  `_ =>` catch-alls).
- **Renderer:** image cache `Map<image_id, CanvasKit Image>`; decode via
  `ck.MakeImageFromEncoded` on first sight (fetch bytes from engine via a
  `get_image_bytes(id) -> Vec<u8>` binding); draw with `canvas.drawImageRect` honoring
  opacity/blend from the style block. Handle decode failure (draw magenta placeholder).
- **UI/IO:** toolbar "Place image" (file picker) + drag-drop of PNG/JPEG files in
  `InputManager.onFileDrop` (drop target `#canvas-container` — SVG/.vec drop already lives
  there; add image MIME branch). Center at drop point at natural size (cap to 50% of document).
  All via `WasmScene` wrappers + `transaction`.
- **SVG:** export as `<image href="data:mime;base64,...">` with the node transform; import
  `<image>` (data-URI href; external URLs: skip with a console warning, v1).
- Acceptance: place, move, resize, undo, save/reload .vec, SVG export shows the image,
  re-import round-trips it.

### Task 2B — Blur & drop-shadow effects

- **Model:** `Style.effects: Vec<Effect>` (serde default empty);
  `enum Effect { Blur { radius: f32 }, DropShadow { dx, dy, blur, color: Color } }`.
  Proto: `ProtoEffect` with type tag + fields, new tag on `ProtoStyle`.
- **Protocol:** append effects block to style record (count u32 + fixed-size records, keep
  alignment); **bump version**.
- **Renderer:** `ImageFilter.MakeBlur` / `ImageFilter.MakeDropShadow` set on a `saveLayer`
  paint wrapping the node (works uniformly for groups and leaves). Cache filters keyed by params.
- **UI:** effects section in the properties panel — add/remove/edit, sliders use
  `beginGesture`/`endGesture` for undo coalescing (see existing slider handling).
- **SVG export:** `<filter>` with `feGaussianBlur` / `feDropShadow` in defs, referenced via
  `filter=`. Import: parse ONLY these two primitives from `<filter>` (attribute
  `stdDeviation`, `dx/dy/flood-color/flood-opacity`); anything else in the filter → skip the
  whole filter with a warning (current behavior) rather than half-applying.
- Acceptance: proto + snapshot round-trip; visual check blur and shadow on shape/group/text;
  export→browser render comparable; undo coalescing on slider drag (extend gesture test if
  cheap).

### Task 2C — Text weight/style (can run parallel with 2B after 2A; touches Text geometry only)

- `Geometry::Text` gains `font_weight: u16 (default 400)`, `italic: bool`, `letter_spacing: f32`
  (serde defaults; ProtoText new tags 6–8; protocol text record + version bump).
- Renderer: `src/fonts.ts` currently loads a limited font set — check what's registered;
  select typeface by weight/style via CanvasKit `FontMgr.matchFamilyStyle` equivalent
  (paragraph API: set `fontStyle` in paragraph style). Fall back gracefully when the weight
  isn't loaded.
- UI: Bold/Italic toggles + letter-spacing input in the text section of the properties panel
  (find where font_size/text_align are edited and mirror). Wrappers + gestures as usual.
- SVG: export `font-weight`/`font-style`/`letter-spacing`; import them in the text branch of
  `processElement` (`resolveAttr` cascade, like font-size).
- Acceptance: round-trips (proto, SVG), renders bold/italic, undo works.

---

## 5. Explicitly OUT of scope (do not build)

- SVG patterns, full `<filter>` primitive graph, `textPath`, luminance masks (field reserved),
  `clips_content` frames, command-based/delta undo, engine-side auto-history, image `Paint`
  fills, external image URLs.

## 6. Definition of done (every task)

1. `./test-all.sh` green (never skip; never weaken an existing assertion to pass).
2. WASM rebuilt if `engine/src` changed (see §1 commands) — and note `engine-wasm/` mirror:
   check how `engine/pkg` ↔ `engine-wasm` sync happens (compare files) and keep them consistent.
3. New serialized fields: proto round-trip test + snapshot round-trip test.
4. Protocol changes: version bumped, writer+reader updated together, framing asserts pass.
5. Mutations reachable from UI: `WasmScene` wrapper with `saveHistory`, transactions for
   compound ops, and a manual undo/redo check.
6. Update `CLAUDE.md`/comments only where behavior changed; no drive-by refactors of
   unrelated code.
