# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Editor

- **A Live Paint fill no longer jumps to the region beside it.** Fills are
  anchored to a point inside their region so they survive a rebuild, and that
  point was the polygon centroid — which for a concave region (an L, a wedge,
  most of any traced drawing) lies outside the region, usually inside the
  neighbour it wraps. Any edit that rebuilt the arrangement, including one that
  touched no geometry at all, handed the colour to that neighbour and left the
  real region bare.
- **One gesture is one undo step again.** Flipping, restacking, and the eye,
  lock and opacity controls each pushed one history state *per selected node*.
  The stack holds 50 and silently drops the oldest, so a single click on a large
  selection could push the user's real work off the bottom of it, leaving ⌘Z to
  walk back through the gesture's own intermediate states instead.

### Library (`@dadaki/editor`)

- **The package is publishable.** It was marked `private`, while the README
  documented it as the embeddable library — so nobody could actually install
  what the docs described. It now carries the metadata npm wants, and ships the
  compiled wasm engine alongside the source: `files` did not include
  `engine/pkg`, and even once it did, the `.gitignore` wasm-pack writes into
  that folder (containing `*`) kept npm from packing it. `prepack` removes it.
- **`canvaskit-wasm` is a peer dependency**, not a direct one. It is type-only
  in the shipped source and the host passes the instance in, so a consumer
  should end up with exactly one copy of Skia on the page. `@types/opentype.js`
  moved the other way, into `dependencies`: the package ships TypeScript, so a
  consumer typechecking it needs those types resolvable.
- **Tests no longer ship** in the tarball — 46 of its 109 files were `*.test.ts`.
- The README now states what the package expects of a bundler, including the
  `optimizeDeps.exclude` a Vite consumer needs. Without it `vite build` works
  and `vite dev` does not, which is the worst way to find out.

### Repository

- **CI now runs.** `pnpm install` failed on every run — corepack rejects a
  version *range* in `devEngines.packageManager`, so the engine tests,
  typecheck, unit tests, lint, build and conformance suite had never executed
  on a push. The pin is an exact version now.
- **A clone no longer downloads a browser it may never use.** Puppeteer's
  install script is off; the ~150 MB Chrome is fetched on demand, by the one
  suite that needs it.
- **A contributing guide, a security policy and issue templates**, and
  `./test-all.sh` now runs the same five checks CI does.

### MCP server

- **`@dadaki/mcp` is published to npm.** Connecting an agent is one line —
  `npx -y @dadaki/mcp --mode relay --url https://dadaki.com/` — with nothing to
  clone, install or build. The package is a single bundled file with no
  dependencies.
- **Removed the `headless` and `headful` modes.** They launched a browser of
  their own through puppeteer, which meant every install paid for a Chrome
  download, and they only ever worked from a repo checkout. Both flags (and
  `DADAKI_MCP_HEADFUL=1`) now fail with a message pointing at `relay` or
  `bridge`, the two modes that drive a tab you already have open.
- **`relay` is the default mode**, replacing `headless`.
- **A relay tool call no longer costs two HTTP round-trips** (`1.0.0-beta.2`).
  Every call asked the backend `/status` before making the call, doubling the
  requests against the deployment — and the round-trip is the whole cost of a
  drawing loop. The relay answers `409` the instant nothing is attached, so the
  call already carries that answer. A relay that is entirely down now says so
  in milliseconds instead of claiming "no editor is attached" four seconds
  later.
- **Bridge mode exits when its client closes stdin** (`1.0.0-beta.2`). It holds
  a listening socket, which kept the process alive on its own, so every MCP
  client restart left an orphan behind — each still holding the fixed port
  7331, so the connect URL that is supposed to be stable quietly changed.
- **A bridge call with nothing attached answers in 4s, not 120s**
  (`1.0.0-beta.2`). The client's own timeout fired first, so the agent was told
  "request timed out" instead of which URL to open. Relay already worked this
  way; bridge had been left behind.
- **The tarball carries the licence** it claims in its manifest.
- **Startup failures print as a message, not a crash** (`1.0.0-beta.2`). A
  config still naming a removed mode used to surface as an unhandled exception,
  burying the line that says what to change under a stack trace from inside the
  bundle. An MCP client shows the user stderr and nothing else, so that line is
  the whole diagnosis.

## [1.0.0-beta.1] — 2026-08-24

First public release. The editor is feature-complete and the `createEditor`
host contract is the shape 1.0 will ship with; the beta label is about field
exposure, not missing work.

### Editor

- **Drawing** — rectangle, ellipse, polygon, star, line, pencil and pen tools,
  with Figma-style tool locking and corner-radius handles.
- **Paths** — boolean union / subtract / intersect / crop, offset path,
  outlined strokes, simplify, anchor-point insertion, scissors, and width
  profiles.
- **Live Paint** — fill the regions a drawing encloses rather than its shapes,
  with per-group gap tolerance, un-painting, and gradients on a painted region.
- **Text** — live editable text with inline editing under the node's own
  transform, embedded fonts, and conversion to outlines.
- **Fills and strokes** — solid, linear/radial gradients with on-canvas
  handles, patterns, dashes, blend modes, and mesh gradients.
- **Structure** — groups, artboards, multi-file tabs, a layer tree, masks,
  align/distribute, equal spacing, snapping and guides.
- **Transforms** — move, scale, rotate, and independent skew axes so isometric
  faces tile exactly.
- **History** — undo/redo that returns you to the mode an edit was made in.
- **Files** — SVG import/export, PNG export, a versioned binary container with
  a reader-version floor, autosave, version history, and backups.

### Interop

- **SVG conformance** — 936/1679 resvg suite fixtures render within 0.98
  similarity of the reference (mean 0.911). The importer builds an *editable*
  scene rather than a spec-perfect render, so this is a tracked score, not a
  target of 100%. See [`tests/svg-suite/README.md`](tests/svg-suite/README.md).
- **Agent bridge / MCP** — `@dadaki/mcp` lets an agent author artwork through
  intent-level drawing verbs and render the result back to look at it. Pairing
  is by code rather than URL.
- **Collaboration** — live peer cursors and selection presence, transport-
  agnostic: the host owns the socket.

### Known limitations

- `filters`, `masking` and `paint-servers` are the weakest SVG categories;
  unsupported filters fall through to browser rasterization.
- Five conformance fixtures sit at a permanent ceiling caused by comparing
  Chrome's rasterizer to resvg's. They are pinned and documented, not silenced.
- Undo history is capped at 50 states; the oldest is dropped.

[1.0.0-beta.1]: https://github.com/rebasepro/dadaki/releases/tag/v1.0.0-beta.1
