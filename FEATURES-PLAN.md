# Illustrator-parity features — autonomous build plan

**Branch:** `worktree-tier1-features` · **Worktree:** `/Users/francesco/vector-editor/.claude/worktrees/tier1-features`

This file is the durable brief for the weekend autonomous sessions. A timer fires
every 4 hours; each firing does ~1 hour of work, then stops. Read `PROGRESS.md`
for the live state and pick up the next unchecked item.

## Mission
Ship the missing Illustrator features that genuinely make sense, wrapped in an
**amazing, minimal, Figma-grade UI**. The power is Illustrator; the feel is Figma.
Quality over quantity. Each feature lands fully working, verified, and committed —
no half-features.

## UI/UX principles — Figma-grade minimalism (NON-NEGOTIABLE)
Every feature's surface must feel like it shipped with the product, not bolted on.
1. **Direct manipulation first.** Prefer on-canvas gestures/handles over panels, and
   panels over modal dialogs. Never use `window.prompt`/`alert`/`confirm`.
2. **Reuse the design system — never ad-hoc widgets.** Use the existing components and
   classes: context-bar buttons (`.cb-btn`, `createButton`), numeric fields (`.cb-num`),
   selects (`.cb-select`), the shared color picker (`openColorPicker`/`createColorSwatch`),
   panel sections, lucide icons at the sizes already in use. Style ONLY via the CSS
   tokens in `:root` (`--bg-input`, `--accent`, `--border`, `--text-main`, …). Do NOT
   hand-set hex colors or sprinkle inline styles for anything the system already covers.
3. **Progressive disclosure.** Sensible defaults; show a control only when it applies to
   the current selection/tool. No always-visible clutter. One primary action per feature.
4. **Consistency.** Match existing spacing, 22–24px control heights, 11px labels, icon
   weight, hover/active states, and interaction patterns (e.g. one-shot tools revert to
   Selection; ⌘-drag bypasses snapping). New tools follow the toolbar/flyout conventions.
5. **Keyboard + discoverability.** Give obvious actions a shortcut and a tooltip; keep
   labels short. Prefer a single number field or drag over multi-field forms.
6. **Quiet by default.** Minimal chrome, calm colors, accent used sparingly for the active
   state. If in doubt, remove UI — the feature should feel effortless, not configurable.

When a feature seems to need a lot of UI, that's a smell: find the Figma-style reduction
(a handle, a single field, a right-click, a mode) before adding a panel.

## Explicitly OUT of scope (the "noise" the user does not want)
Brushes (art/scatter/pattern/calligraphic), gradient mesh, envelope/warp/perspective
distort, image trace, a full Appearance/Graphic-Styles tree. Do NOT build these.

## Working agreement (every session)
1. `cd /Users/francesco/vector-editor/.claude/worktrees/tier1-features`
2. Read `PROGRESS.md`. Continue an in-progress item, else start the next unchecked one.
3. Implement fully: engine (Rust) + JS + UI + a context-bar/menu entry as needed.
   The UI must honor the **UI/UX principles** above — Figma-grade, reuse the design
   system, no ad-hoc widgets. Treat the UX as half the feature, not an afterthought.
4. **Verify before committing:**
   - `./node_modules/.bin/tsc --noEmit -p tsconfig.json` (clean)
   - `./node_modules/.bin/biome check --write <changed files>` then re-check (clean)
   - If engine changed: `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"; export CARGO_TARGET_DIR=/Users/francesco/vector-editor/engine/target; (cd engine && cargo test --lib)` then rebuild pkg: `/Users/francesco/vector-editor/engine/wasm-pack-v0.12.1-x86_64-apple-darwin/wasm-pack build --target web --out-dir pkg`
   - `./node_modules/.bin/vitest run` (all pass)
   - Browser-verify: a manual vite already serves this worktree at http://localhost:5312 (restart if down: `nohup ./node_modules/.bin/vite "$PWD" --port 5312 --strictPort >/tmp/vite-tier1.log 2>&1 &`). Point the preview pane at it via `preview_eval` → `window.location.href='http://localhost:5312/'`, then drive `window.app` = `{scene, ui, input, renderer, ck}`.
5. **Commit each completed feature** with a clear message + the Claude co-author trailer. Keep the tree compiling at every commit. If you must stop mid-feature, commit a WIP that still compiles and note the state in PROGRESS.md.
6. Update `PROGRESS.md`: check off done items, append a dated log line, note next step.
7. Do NOT push, do NOT open PRs, do NOT touch `main`. Local commits on this branch only.

## Environment notes
- node_modules and engine/pkg are symlinks into the main repo (already set up).
- Engine data model: guides = proto tags 14/15, swatches = tag 16. When adding
  persisted scene state, follow that pattern (Scene struct + ProtoDocument + all
  struct literals incl. proto tests + wasm getters/setters + JS wrappers).
- `scene.getNodeStyle(id)` returns an OBJECT. Runtime-`private` TS methods are
  still callable from `preview_eval`.

## Backlog (priority order — refine as you learn the code)
1. **Offset Path** — parametric inset/outset of a selected path (Object action).
   Accept: positive/negative offset via a small numeric popover or drag; joins
   handled; works on closed + open paths; one undo step.
2. **Text on a path** — put a text node's baseline on a selected path; text flows
   along the curve; editing text or reshaping the path reflows. Accept: attach via
   selecting a text + a path; detach; renders in canvas + exports to SVG `<textPath>`.
3. **Shape Builder tool** — drag across overlapping filled regions to merge; ⌥-drag
   to subtract. Accept: live highlight of the region under the cursor; commits to
   real editable path geometry; minimal (no settings panel). Extends existing
   boolean/vector-network machinery — see `boolean_ops.ts`, engine bool_cache.
4. **Variable-width stroke (width profile)** — drag handles along a stroke to taper
   width at points; store as a per-vertex width multiplier. Accept: on-canvas width
   handles in a "width" mode; outputs a real variable-width outline on export.
5. **Clipping frame (clip_content)** — wire the reserved `clip_content` flag so a
   frame/rect clips its children (Figma-style), distinct from the existing alpha
   masks. Accept: toggle "Clip content" on a group/frame; children clip to bounds;
   round-trips through save + SVG.
6. **Blend tool** — interpolate N steps between two selected shapes (shape + color).
   Accept: pick two objects, choose step count, generates in-between shapes as a
   group; re-editable step count. Keep UX to a single number field.
7. **Reusable components / symbols** (stretch, may span sessions) — one master, many
   instances, edit-once-update-all, per-instance override of position/size. Accept:
   "Create Component", drag instances, edit master reflects everywhere, detach.
   This is the biggest; only start if 1–6 are done or clearly time-boxed.

Prefer finishing items in order, but if one proves too deep for the remaining time,
commit a clean WIP and move to the next; circle back later.
