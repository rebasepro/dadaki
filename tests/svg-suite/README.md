# SVG conformance suite

Pixel-level SVG-compliance tracking for the editor, built on the
[resvg test suite](https://github.com/RazrFalcon/resvg-test-suite) (MIT — see
[`LICENSE-resvg`](./LICENSE-resvg)).

Each test is an `.svg` file paired with a reference `.png` that resvg rendered
from it. The harness drives the **real editor** in a headless browser: it
imports the SVG through the app's own importer, rasterises the document to PNG,
and compares the result against the reference pixel-for-pixel.

## What it measures

The editor's SVG importer is lossy by design (it builds an *editable* scene, not
a spec-perfect render), so most of the 1679 tests will never match
pixel-for-pixel. This is therefore a **conformance tracker**, not a green/red
gate:

- Every test gets a **similarity score** in `[0, 1]` (fraction of pixels
  matching within tolerance, both images flattened onto white).
- A test "passes" at `similarity ≥ 0.98` (tunable via `PASS_THRESHOLD`).
- [`baseline.json`](./baseline.json) records the committed score of every test.
- CI **fails only on regressions**: a test that was passing in the baseline and
  has since dropped below the threshold. Movement within the large body of
  already-failing tests (many of which render through async/AA paths that jitter
  run-to-run) is intentionally *not* gated — progress there shows up in the pass
  count and per-category means.

Current standing (see the per-category summary printed by a run): ~495/1679
passing, strongest in `shapes`, `painting`, and `text`; weakest in `filters`,
`masking`, and `paint-servers`, which are largely unimplemented.

## Running

Requires the app's `engine/pkg` to be built and `node_modules` installed. The
harness starts (and tears down) its own Vite dev server unless you pass `--url`.

```sh
# Run everything, compare against the committed baseline (exit 1 on regressions)
node tests/svg-suite/harness.mjs

# Only a subset (substring match on the test path)
node tests/svg-suite/harness.mjs --filter shapes/circle

# Write magenta/grey diff PNGs for failing tests into report/ (combine with --filter)
node tests/svg-suite/harness.mjs --filter painting --diff

# Reuse an already-running dev server instead of spawning one
node tests/svg-suite/harness.mjs --url http://localhost:5173

# Re-record the baseline after an intentional importer/renderer change
node tests/svg-suite/harness.mjs --update
```

Knobs: `PASS_THRESHOLD` (default `0.98`), `REGRESSION_EPS` (noise margin below
the threshold before a drop counts as a regression, default `0.02`).

## How a test is rendered

For a test with `viewBox="0 0 W H"` whose reference PNG is `Wr × Hr`:

1. `app.scene.newDocument(W, H)` — blank document sized to the viewBox.
2. `width`/`height` attributes are stripped (when a viewBox is present) so the
   importer keeps geometry in viewBox units, matching how resvg renders the
   suite.
3. `app.ui.parseSVG(svg)` — import through the app's importer.
4. `app.renderer.exportPNG(Wr / W)` — rasterise at the same scale the reference
   was rendered at, producing a `Wr × Hr` image.
5. Both images are decoded with CanvasKit *inside the page*, flattened onto
   white, and compared. No native image dependencies are needed.

Output (git-ignored) lands in `report/`: `results.json` (full per-test scores)
and, with `--diff`, `report/diffs/**.diff.png`.

## Updating the vendored suite

`fixtures/` holds a snapshot of the resvg suite's `tests/` and `resources/`
trees. To refresh, re-download the upstream repo, copy those two directories
over `fixtures/`, and re-run with `--update` to regenerate the baseline (review
the diff — an upstream change can legitimately move scores).

## Known: the committed baseline is stale (26 pre-existing regressions)

As of 2026-07-19 a clean run reports **26 regressions against `baseline.json`**
that are *not* caused by any pending change. Verified by building the engine
from an unmodified tree and re-running: the scores come out byte-identical to a
run with local changes applied, so they predate them.

They cluster by feature, which is what you'd expect from a rendering/filter
change that was never re-baselined:

| Area | Tests | Scores |
|---|---|---|
| `filters/feTile` | 3 | 1.000 → 0.878–0.904 |
| `filters/feComposite` | 3 | 1.000 → 0.956 |
| `filters/feConvolveMatrix` | 4 | 1.000 → 0.934–0.959 |
| `structure/image/preserveAspectRatio` | 6 | ~0.99 → ~0.95 |
| `painting/image-rendering/optimizeSpeed` | 1 | 1.000 → 0.824 |
| text / markers / misc filters | 9 | ~0.98 → ~0.96 |

Note the suite also now reports **522 passing vs the ~495 the baseline
encodes** — more tests pass than when it was written, further evidence the
baseline simply hasn't been refreshed.

**Deliberately not `--update`d here.** Refreshing the baseline would bury these
26 alongside the genuine improvements, and `optimizeSpeed` at 0.824 and `feTile`
at 0.878 look like real fidelity losses worth diagnosing rather than accepting.
Decide per-area: fix the regression, or re-baseline once it's understood.

Until then, the gate is noisy — when checking whether *your* change regressed
anything, compare against a control run of the same subset
(`node harness.mjs --filter <area>`) with your change reverted, rather than
trusting the pass/fail exit code.
