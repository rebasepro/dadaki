# Progress log — autonomous Illustrator-features build

Read `FEATURES-PLAN.md` for the mission, constraints, and workflow. This file is
the live state: check off items, keep a dated log, always leave a clear "next step".

## Status board
- [x] Tier 1 baseline (eyedropper, swatches/global colors, rulers+guides+grid, transform reference point) — committed `8486fe2`
- [x] 1. Offset Path — committed `cceab38` (src/offset_path.ts; context-bar distance control, negative=inset)
- [ ] 2. Text on a path — DEFERRED (needs a dedicated session; see note below)
- [ ] 3. Shape Builder tool
- [ ] 4. Variable-width stroke (width profile)
- [ ] 5. Clipping frame (clip_content)
- [x] 6. Blend tool — committed `ae02e44` (src/blend.ts; ContourMeasure arc-length morph + color lerp, grouped; context-bar steps field)
- [ ] 7. Reusable components / symbols (stretch)

## Next step
Do **item 5 — Clipping frame (clip_content)** next: it's more self-contained than the
remaining big ones and high-value (Figma-core: frames clip their contents). The
`clip_content` flag already exists on the node (types.ts, reserved). Wire it in the
engine renderer so a group/frame with clip_content=true clips its descendants to its
bounds; add a Figma-style "Clip content" toggle (context bar or a small panel control)
for a selected group. Accept: toggle on a group → children clip to its bounds; round-trips
through save + SVG. Study the render stream in renderer.ts (how groups/masks push/pop
clips — mask_type=2 clipPath path is the closest existing machinery per memory
[[adaptive-tiles-clip-masks]]).

Then item 3 (Shape Builder), item 4 (variable-width stroke), item 2 (text-on-path — needs
its own session), item 7 (components, stretch).

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
