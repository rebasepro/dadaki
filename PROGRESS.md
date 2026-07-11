# Progress log — autonomous Illustrator-features build

Read `FEATURES-PLAN.md` for the mission, constraints, and workflow. This file is
the live state: check off items, keep a dated log, always leave a clear "next step".

## Status board
- [x] Tier 1 baseline (eyedropper, swatches/global colors, rulers+guides+grid, transform reference point) — committed `8486fe2`
- [x] 1. Offset Path — committed `cceab38` (src/offset_path.ts; context-bar distance control, negative=inset)
- [ ] 2. Text on a path — DEFERRED (needs a dedicated session; see note below)
- [ ] 3. Shape Builder tool — BLOCKED without plumbing (see note)
- [x] 4. Variable-width stroke (width profile) — committed `15d3a77` (src/width_profile.ts; one-shot tapered outline via ContourMeasure; context-bar Width dropdown: Uniform/Taper/Taper both/Bulge, open-path only)
- [ ] 5. Clipping frame (clip_content) — DEFERRED, data-model mismatch (see note)
- [x] 6. Blend tool — committed `ae02e44` (src/blend.ts; ContourMeasure arc-length morph + color lerp, grouped; context-bar steps field)
- [ ] 7. Reusable components / symbols (stretch)
- [x] 8. Simplify Path — committed `06e8630` (src/simplify_path.ts; RDP + Catmull-Rom refit; context-bar tolerance field, progressive-disclosed at 6+ pts)
- [x] 9. Smart measurements (Figma hover-distances) — committed `c9d7226` (renderer drawMeasurements; pink gap lines + labels, anchored to selection center axes)

## Next step
NOTE (verified this session): **distribute spacing (equal gaps) is ALREADY done**
(align.ts::distributeSelection computes equal gaps, not center-based — my earlier note
was wrong) and **corner radius already works for paths** (ui.ts applyRadius sets
per-vertex corner_radius; engine expands it). Don't rebuild those.

Good remaining candidates:
- **Pathfinder ops (face-graph-free)** via CanvasKit path-ops on the selection: Minus
  Back (front minus union-of-rest — reverse of existing Subtract, genuinely missing),
  Crop (lower shapes ∩ top, discard top). Extend boolean_ops; low risk.
- **Measurement while dragging** — extend the new smart-measurements to also show gaps
  during a move drag (currently hover-only). Small, high-value follow-on.
- **Reverse path direction**, **Average points** — small path utilities.

Bigger/blocked items below need dedicated sessions:

- **Item 5 (clip_content) — deferred:** on THIS branch a group's bounds == its children's
  extent, so "clip to own bounds" is a no-op. A real frame needs either an explicit stored
  clip-rect on the node (engine field + a render-stream clip command — the render buffer is
  u32-aligned zero-copy, so adding a command is delicate) or the `artwork-containment`
  branch's frame↔contents model. Too risky for one window; needs a dedicated session with
  a render-protocol change. Alpha/luminance/geometric MASKS already provide clipping today.
- **Item 3 (Shape Builder) — blocked:** the face graph (`query_face_at`/`get_face_boundary`)
  only exists inside a Live Paint group — `query_face_at` returns -1 on arbitrary overlapping
  shapes. Shape Builder would need to build a temporary vector network from the selection
  first (the Live Paint machinery). Feasible but multi-part; pair it with extended
  Pathfinders (Divide/Trim/Crop) in a dedicated session that stands up the network.

Remaining after that: item 2 (text-on-path, dedicated session), item 7 (components, stretch),
item 4 (variable-width). For a safe next single-window win, consider more single-action path
ops (they've all landed cleanly): e.g. a Pathfinder that works via CanvasKit path-ops on the
selection directly (Divide-by-boolean, Outline), or "Distribute spacing (equal gaps)".

### Deferred: item 2 — Text on a path
Investigated this session. It's genuinely multi-part: (a) persist the text→path link
(engine field on the Text node, following guides/swatches proto pattern), (b) render via
per-glyph RSXform layout — `font.getGlyphIDs`/`getGlyphWidths` DO work here, and a real
Typeface can be built from the loaded Google-font bytes (see fonts.ts) for accurate
metrics + drawTextBlob with RSXform along an arc-length-sampled path (use ContourMeasure,
now proven working — see blend.ts), (c) SVG `<textPath>` export, (d) attach/detach UX.
Too much for one ~1h window at the "no half-features" bar, so it was reordered. Give it a
dedicated session; the ContourMeasure + typeface pieces are the key enablers.

## Log
- 2026-07-10 13:47 (Fri) — Baseline committed (`8486fe2`). Plan + timers set up.
  Mac caffeinated. Manual vite serving worktree at http://localhost:5312.
- 2026-07-10 13:57 (Fri) — Item 1 **Offset Path** done + committed (`cceab38`).
  Verified in browser: 100×100 square → outset +15 = new 130×130 path (non-destructive),
  inset −15 = 70×70. tsc + biome + vitest (221) all green. Next: item 2 (Text on a path).
  Note: Offset is Path-only (no auto-convert of rect/ellipse) to stay non-destructive;
  a future nicety is offsetting rects/ellipses by resolving them to subpaths first.
- 2026-07-10 18:09 (Fri) — Item 6 **Blend tool** done + committed (`ae02e44`). Also
  reordered: item 2 (text-on-path) deferred to a dedicated session (see above) since it's
  too deep for one window; Blend was the cleanly-completable win. Verified in browser:
  red ellipse → blue rect with 5 steps produced a Group of 7 with a purple midpoint
  (0.5,0.2,0.53) centered between them; smooth circle→square morph. Context-bar Blend
  control (steps field + button) renders natively on any 2 combinable shapes. tsc + biome
  + vitest (221) green. Load flash was also fixed earlier this window run (`de1d1d6`).
  Learned: getResolvedSubpaths returns [] for Rect/Ellipse (Path-only) — sample the world
  CanvasKit path via ContourMeasure instead (now exported nodeToWorldPath from boolean_ops).
  Next: item 5 (Clipping frame / clip_content).
- 2026-07-10 22:09 (Fri) — Item 8 **Simplify Path** done + committed (`06e8630`). Reordered
  again: items 5 (clip_content) and 3 (Shape Builder) both turned out to need engine-level
  plumbing not landable cleanly in one window (see Next-step notes), so I built Simplify —
  a genuine Illustrator gap (Object › Path › Simplify) fitting the proven single-action +
  one-field pattern. Verified in browser: 60-pt sine polyline → 24 smooth points, no cusps
  (added a handle-length clamp after a first pass showed cusping); context-bar Simplify
  control (tolerance field + button) renders natively, progressive-disclosed at 6+ points.
  tsc + biome + vitest (221) green. Note: browser tooling switched mid-session from the
  preview_* MCP to claude-in-chrome (navigate + javascript_tool + computer screenshot on a
  numeric tabId); same http://localhost:5312 target. Next: item 4 (variable-width) or another
  single-action path op / Pathfinder.
- 2026-07-11 02:06 (Sat) — Item 4 **Width profiles** done + committed (`15d3a77`). Delivered
  the completable version of variable-width stroke: a one-shot tapered OUTLINE (not live
  rendering, which needs an engine stroke-generation change). Samples the open path's
  centerline via ContourMeasure, offsets each side by half a profile-scaled width → closed
  ribbon; profiles Uniform/Taper/Taper-both/Bulge in a context-bar 'Width' dropdown (open
  paths only). Verified in browser: stroked wave → clean leaf-taper calligraphic ribbon,
  dropdown with per-profile shape icons. Also fixed a latent bug: the context-bar signature
  didn't hash single-path geometry, so in-place edits (Simplify/Offset/Width) left stale
  gated controls — now hashed (point count + open/closed). tsc + biome + vitest (221) green.
  Browser tooling: claude-in-chrome (tabId 1269983887). Next: Distribute spacing (equal gaps)
  or a face-graph-free Pathfinder (Crop/Minus-Back/Outline).
- 2026-07-11 06:06 (Sat) — Item 9 **Smart measurements** done + committed (`c9d7226`).
  Figma's hover-to-show distances: with one object selected, hovering another draws the
  clear-space gaps as pink lines + distance labels with end ticks. First pass had the H/V
  labels colliding in the diagonal case; fixed by anchoring each gap line to the SELECTED
  object's center axis (reads as "measure from selection", keeps labels apart) — verified
  clean in a screenshot. Reuses the artboard-label screen-constant text approach; renderer
  -only. Discovered en route: distribute-spacing (equal gaps) and path corner-radius are
  ALREADY implemented (corrected the plan). tsc + biome + vitest (221) green. Next:
  face-graph-free Pathfinder (Minus Back/Crop) or measurement-while-dragging.
