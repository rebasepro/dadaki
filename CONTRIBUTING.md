# Contributing to Dadaki

Thanks for taking the time. This is the open-source editor: a pnpm workspace
holding the embeddable library (`packages/editor`), a local-only demo shell
(`packages/app`), and the MCP server that lets an agent draw (`packages/mcp`).
The hosted product lives in a separate repository and is not needed here.

## Setting up

```bash
pnpm install
pnpm dev          # → http://localhost:5199
```

The repo pins pnpm **11.9.0** through `devEngines` with `onFail: download`, so
corepack fetches that version for you. The pin is an exact version on purpose —
corepack rejects a range in that field and the install fails before anything
else runs.

You do **not** need the Rust toolchain to work on the editor UI: the wasm build
output in `packages/editor/engine/pkg/` is committed, so a fresh clone runs,
typechecks and tests as-is.

## Before you open a pull request

Run the same gate CI runs:

```bash
./test-all.sh
```

That is `cargo test`, `tsc` for each package, `vitest`, `biome check`, and a
production build. All five must be green. Two things that trip people up:

- **`tsc` has `noUnusedLocals` and covers all of `src/**`.** A scratch test file
  left in the tree fails the typecheck. Delete it, or make it a real test.
- **Biome is the formatter**, 4-space indent, single quotes, 100 columns.
  `./node_modules/.bin/biome check --write` fixes what it can.

## Changing the Rust engine

```bash
cd packages/editor/engine && wasm-pack build --target web --release
```

Then **commit the regenerated `pkg/` together with your `src/` change.** This is
the one rule worth repeating, because getting it wrong is silent in both
directions: a fresh clone would keep running the old engine, and the JS tests
import the built wasm, so without a rebuild they test the old engine and pass.
The browser caches it too — hard-reload the dev server after a rebuild.

## Tests

Unit tests live beside the code as `*.test.ts`. The useful pattern for anything
interactive is to drive the **real** `InputManager` against the **real** wasm
engine, rather than mocking either — see `packages/editor/src/history_discipline.test.ts`
or `gesture_fuzz.test.ts`. Engine-level behaviour belongs in `#[test]` functions
in the Rust crate, where it runs far faster.

Two invariants worth knowing, because they are easy to break by accident and
the symptom reaches the user as lost work:

- **One gesture is one undo step.** History holds 50 states and silently drops
  the oldest, so a loop calling a history-recording setter once per selected
  node can flush the user's real undo stack. Wrap the loop in
  `scene.transaction(...)`.
- **World units vs local units.** Anything that measures with `getNodeBounds`
  (world) and writes through `move_node` / `resize_node` / `set_node_position`
  (local) is wrong inside a scaled or rotated group.

## SVG conformance

`node tests/svg-suite/harness.mjs` scores the importer against the resvg suite.
It is a tracked score, not a target of 100% — the importer builds an *editable*
scene, not a spec-perfect render. CI fails only on a **regression** against
`tests/svg-suite/baseline.json`. See that directory's README before changing a
baseline. It needs a browser, which the install deliberately does not fetch:

```bash
./node_modules/.bin/puppeteer browsers install chrome
```

## Commits and pull requests

Commit subjects are conventional-commit style, and say what was **wrong** rather
than what was touched — `fix(live-paint): a concave region handed its colour to
its neighbour` rather than `update vector_network.rs`. Keep one concern per
commit.

For a bug fix, a test that fails before the change and passes after it is worth
more than a description of the fix.

## Reporting bugs

Open an issue with the version, the browser, and the steps. If the artwork
matters to the repro, an exported `.svg` or the editor's own file attached to
the issue saves a lot of guessing.

Security issues go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Licence

By contributing you agree that your contributions are licensed under the
[MIT licence](LICENSE) that covers the project.
