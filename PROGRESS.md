# Progress log — autonomous Illustrator-features build

Read `FEATURES-PLAN.md` for the mission, constraints, and workflow. This file is
the live state: check off items, keep a dated log, always leave a clear "next step".

## Status board
- [x] Tier 1 baseline (eyedropper, swatches/global colors, rulers+guides+grid, transform reference point) — committed `8486fe2`
- [x] 1. Offset Path — committed `cceab38` (src/offset_path.ts; context-bar distance control, negative=inset)
- [ ] 2. Text on a path
- [ ] 3. Shape Builder tool
- [ ] 4. Variable-width stroke (width profile)
- [ ] 5. Clipping frame (clip_content)
- [ ] 6. Blend tool
- [ ] 7. Reusable components / symbols (stretch)

## Next step
Start **item 2 — Text on a path**. Look at `src/text_outlines.ts` (text→subpaths via
opentype.js/CanvasKit), the Text geometry in `types.ts`, how text renders in
`renderer.ts`, and SVG `<textPath>` export in `svg_export.ts`. Design: attach a Text
node to a selected Path so glyphs flow along the curve; store the path link on the text
node (engine field or a JS-side association — prefer engine so it persists, following the
guides/swatches proto pattern). Accept: attach via selecting text+path, detach, renders
on canvas, exports to `<textPath>`. Optional niceties (start offset, side) later.

## Log
- 2026-07-10 13:47 (Fri) — Baseline committed (`8486fe2`). Plan + timers set up.
  Mac caffeinated. Manual vite serving worktree at http://localhost:5312.
- 2026-07-10 13:57 (Fri) — Item 1 **Offset Path** done + committed (`cceab38`).
  Verified in browser: 100×100 square → outset +15 = new 130×130 path (non-destructive),
  inset −15 = 70×70. tsc + biome + vitest (221) all green. Next: item 2 (Text on a path).
  Note: Offset is Path-only (no auto-convert of rect/ellipse) to stay non-destructive;
  a future nicety is offsetting rects/ellipses by resolving them to subpaths first.
