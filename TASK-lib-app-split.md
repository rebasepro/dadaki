# Task: Split the vector editor into a clean `lib` (editor core) + `app` (deployable shell)

## 0. Read this first

You are refactoring an existing, working Vite + TypeScript + Rust/WASM vector
editor into a pnpm workspace with two packages:

- **`@dadaki/editor`** — the reusable editor library. Knows how to render and
  edit vector graphics on a canvas. Must NOT depend on Firebase, analytics
  backends, `.env`, Firebase Hosting, or a specific host HTML page.
- **`@dadaki/app`** — the deployable web app. Owns `index.html`, Firebase,
  the analytics sink, `.env`, Firebase Hosting config, and the bootstrap that
  mounts the editor into the page.

This is a **large, staged, mechanical-but-delicate** refactor (the editor is
~25k LOC; `ui.ts` alone is ~6100 lines, `input.ts` ~4900). Do it in the phases
below, **committing and running the full verification gate after each phase**.
Do not attempt it in one shot. If a phase's gate fails, fix it before moving on.

**Success is behavior-preserving:** the app must build, run, pass all unit
tests, and pass the SVG conformance suite with zero regressions at the end. This
is a *structural* refactor — no feature changes, no logic changes beyond moving
code and rewiring imports.

---

## 1. Hard constraints & environment gotchas (READ — these will bite you)

0. **This is a pnpm-workspaces project — use pnpm, not npm or yarn.** The repo
   already has `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and a `devEngines`
   pin to `pnpm ^11`. Do NOT introduce `npm`/`yarn` workspaces, lockfiles, or
   `package.json` `workspaces` fields. Cross-package deps use the pnpm
   `workspace:*` protocol (e.g. `"engine": "workspace:*"`,
   `"@dadaki/editor": "workspace:*"`). Workspace membership is declared in
   `pnpm-workspace.yaml` under a `packages:` list — **not** in `package.json`.
   Use `pnpm install` to link the workspace, and `pnpm --filter <pkg> add <dep>`
   to add a dependency to a specific package.

1. **Tooling quirk — `pnpm run <script>` and `npx` both fail in this
   environment.** This is specific to *script execution*: `pnpm install`,
   `pnpm --filter … add`, and workspace linking DO work — keep using pnpm for
   dependency/workspace management. But to *run tools* (tsc, biome, vitest,
   vite), **invoke binaries directly** from `./node_modules/.bin/`, e.g.
   `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/biome check`,
   `./node_modules/.bin/vitest run`, `./node_modules/.bin/vite build` — do not
   wrap them in `pnpm run`. With pnpm's nested store, a package's bin may not be
   at the repo-root `node_modules/.bin/`; check the package-local
   `packages/<pkg>/node_modules/.bin/` too, or locate it with
   `find . -path '*/node_modules/.pnpm' -prune -o -name biome -print`.

2. **The Rust/WASM engine.** `src/wasm_scene.ts` imports the compiled engine via
   a **relative path**: `import init, { Engine, History } from '../engine/pkg/engine';`.
   `engine/pkg/package.json` already declares `"name": "engine"`. When
   `wasm_scene.ts` moves into `packages/lib/src/`, that relative path breaks.
   **Preferred fix:** make `engine` a workspace package and import it as a bare
   specifier `engine` (add it to `pnpm-workspace.yaml` `packages:` and to the
   lib's `package.json` deps as `"engine": "workspace:*"`). Do **not** rebuild
   the WASM — you are not touching `engine/src/`. If you ever do, note the Rust
   toolchain (rustup) is not on PATH and `engine/pkg` must be rebuilt after any
   `engine/src` change; but this task should require **no** engine rebuild.

3. **CanvasKit is loaded from a `<script>` tag**, not imported. `index.html`
   has `<script src="/canvaskit.js"></script>` and `main.ts` calls the global
   `CanvasKitInit(...)` with an `@ts-expect-error`. `canvaskit.js` + the wasm
   live in `public/`. This is an **app** concern, but the lib depends on a
   `CanvasKit` instance being passed in. Keep the "host loads CanvasKit, passes
   it to the editor" contract — the lib already takes `ck` via constructors
   (`new WasmScene(ck)`, `new Renderer(ck, ...)`), so this is naturally clean.
   `canvaskit-wasm` is also excluded from Vite pre-bundling in `vite.config.ts`
   (`optimizeDeps.exclude`) — replicate that in the app's Vite config.

4. **SVG conformance suite is a required gate.** `tests/svg-suite/harness.mjs`
   is a Puppeteer pixel-diff tracker (~495 passing fixtures) gated against
   `tests/svg-suite/baseline.json`. It renders through the running app. It MUST
   still pass with zero regressions after the split. Figure out how it launches
   the app (it likely builds or serves the app) and update any paths it depends
   on. Treat any regression here as a blocker.

5. **Unit tests are colocated** in `src/*.test.ts` (13 files) and run under
   Vitest with `jsdom` (configured inside `vite.config.ts` `test.environment`).
   They move **with the code they test** into whichever package owns that code.
   Each package needs a Vitest config (or a shared root config) with
   `environment: 'jsdom'`.

6. **Biome** governs formatting/lint: 4-space indent, single quotes, trailing
   commas all, line width 100, `noExplicitAny` off, `noNonNullAssertion` off.
   Config is `biome.json` with `files.includes: ["src/**/*.ts", "scripts/**/*.ts", "*.ts"]`.
   Update `includes` for the new package layout. Run `./node_modules/.bin/biome check --write`
   on moved files; import ordering is enforced (it will reorder imports).

7. **`.env` and Firebase config are already done** — do not undo. Current state:
   - `src/analytics.ts` is a **dependency-free dispatcher** (`logAppEvent` +
     `registerAnalyticsSink`). This belongs in the **lib**.
   - `src/firebase_analytics.ts` is the **only** file importing `firebase`;
     it reads `import.meta.env.VITE_FIREBASE_*` and builds the sink. This
     belongs in the **app**.
   - `main.ts` calls `registerAnalyticsSink(createFirebaseAnalyticsSink())` at
     the top of `bootstrap()`. That wiring belongs in the **app**.
   - `.env` (gitignored), `.env.example` (tracked), `.gitignore` env rules are
     in place. `.env` files belong at the **app** package root (Vite loads
     `.env` from the project root, so it must sit where the app's Vite runs).

---

## 2. Current-state facts (ground truth as of this task)

- Single Vite app. Entry: `index.html` → `<script type="module" src="/src/main.ts">`.
- `index.html` is ~31KB and **contains all the UI chrome markup** (toolbar,
  panels, dialog host elements, tab strip, canvas container) plus SEO meta,
  JSON-LD, a CDN `lucide` script, `canvaskit.js`, and two inline `<script>`
  blocks. The editor code reaches into this markup **by element id** via
  `document.getElementById(...)`.
- **19 of ~35 non-test source files touch the DOM directly** (`document.`/
  `window.`): `ui, input, renderer, context_bar, color_picker, toolbar,
  tab_strip, app_menu, about_dialog, backup_dialog, export_dialog, file_io,
  file_service, document_manager, fonts, persistence, dev_stress, wasm_scene,
  main`. **The editor is inherently DOM-coupled — this is NOT a "pure
  algorithmic core" split.** See §3.
- **DOM-free files** (safe pure-core candidates): `align, analytics,
  boolean_ops, context, document, gradient_edit, icons, outline_stroke,
  path_ops, snapping, svg_css, svg_export, svg_utils, text_outlines, types`.
- Only `main.ts` and `firebase_analytics.ts` use `import.meta.env`.
- Coupling hubs (imported by many): `ui` (7 importers), `renderer` (6),
  `input` (5).
- Build scripts (`package.json`): `dev: vite`, `build: tsc && vite build`,
  `preview: vite preview`, `check: tsc --noEmit`, `lint: biome check`,
  `format: biome format --write`, `test: vitest run`.
- Deploy: `firebase.json` serves `dist/` as Firebase Hosting with SPA rewrite
  to `/index.html`; `.firebaserc` project `dadaki-vector`.
- `pnpm-workspace.yaml` exists but only declares `allowBuilds` — **no
  `packages:` field yet**. You must add one.
- `scripts/` holds puppeteer/CK test helpers (`puppeteer_bounds.ts`,
  `puppeteer_test_flatten.ts`, `renderer_test.ts`, `test_ck.cjs`).

---

## 3. The DOM-ownership contract — DECIDED: the lib owns its DOM (Option A)

The editor currently talks to `index.html` by hard-coded element ids (e.g.
`getElementById('editor-canvas')`, `'toolbar'`, `'tab-strip'`, `'save-btn'`,
`'export-btn'`, `'zoom-in'`, `'app-menu-btn'`, `'canvas-container'`, …). A
reusable lib cannot assume the host page contains these ids. **The maintainer
has chosen the "bring-your-own-container" contract (Option A). Implement it —
do not fall back to a shared-id contract.**

**The target public API:**

```ts
// @dadaki/editor
export interface EditorOptions {
    canvasKit: CanvasKit;              // host loads canvaskit.js and passes the instance
    analyticsSink?: AnalyticsSink;     // optional; lib calls registerAnalyticsSink internally
    // future host hooks as needed, e.g. onDirtyChange, initialDocument, …
}
export interface EditorHandle {
    destroy(): void;                   // tear down DOM + listeners
    // expose whatever the app legitimately needs (e.g. documentManager) — but
    // keep the surface minimal and intentional, not "everything".
}
export function createEditor(container: HTMLElement, options: EditorOptions): EditorHandle;
```

`createEditor` builds **all** the editor's DOM inside `container` — it must not
read from or write to elements outside `container`, and must not depend on any
id existing in the host page. Concretely you must:

- **Relocate the editor's chrome markup out of `index.html`** and into the lib,
  so the lib creates it. Two acceptable techniques (pick one, be consistent):
  (a) a lib-owned HTML template string / `<template>` the lib clones into
  `container`, or (b) programmatic DOM construction. Keep the exact same element
  structure/classes the CSS + code already expect so styling and behavior are
  preserved. `style.css` moves into the lib and is imported by lib code (Vite
  will bundle it), so the app doesn't have to know the editor's internal markup.
- **Convert every `document.getElementById('x')` / global `document.querySelector`
  in lib code to a container-scoped lookup** (`container.querySelector(...)`, or
  hold references returned during construction). Audit all 19 DOM-touching lib
  files. The only DOM globals a lib file may still touch are legitimately
  document/window-level concerns (e.g. `window.addEventListener('keydown')`,
  `document.createElement`, clipboard, `requestAnimationFrame`) — NOT reaching
  into host page structure.
- **Keep app-only DOM out of the lib.** The header `save-btn`/`export-btn`/
  `app-menu-btn`/zoom buttons currently live in `index.html` and are wired in
  `main.ts`. Decide per-control whether it is *editor chrome* (moves into the lib
  container) or *app chrome* (stays in the app shell and drives the editor via
  the `EditorHandle` / callbacks). Prefer moving genuine editor UI into the lib;
  keep only app-branding/shell bits in the app.

After Option A, the app's `index.html` shrinks to: SEO/meta + CanvasKit &
lucide `<script>` tags + a single mount element (e.g. `<div id="app"></div>`) +
the module script. The app's `main.ts` loads CanvasKit, then calls
`createEditor(document.getElementById('app')!, { canvasKit, analyticsSink })`.

**Firebase/analytics-sink/`.env`/`beforeunload`/dev `window.__editor` handles
are APP concerns** — they live in the app's bootstrap and are injected into the
lib (via `EditorOptions`), never imported by lib code.

> Migration ordering: §5 still moves the code into packages first (Phases 1–4)
> keeping behavior working via a temporary compatibility shim, THEN completes the
> Option-A DOM migration in Phase 5. This staging keeps the gate green
> throughout instead of doing one giant untested move. Phase 5 is **required**,
> not optional — the task is not done until `createEditor(container)` is the
> real public API and no lib code reaches outside its container.

---

## 4. Target structure

```
/                          # workspace root
  pnpm-workspace.yaml       # add packages: [engine, packages/*]
  package.json              # root: dev-deps shared (biome, typescript), workspace scripts
  biome.json                # update files.includes for new layout
  engine/                   # unchanged Rust crate; engine/pkg is the built WASM pkg
  packages/
    editor/                 # @dadaki/editor  (the lib)
      package.json          #   deps: engine (workspace:*), canvaskit-wasm, opentype.js
      tsconfig.json
      vite.config.ts        #   library build (vite lib mode) + vitest jsdom
      src/                  #   moved core + editor UI + colocated *.test.ts
      index.ts              #   public API barrel (createEditor / classes)
    app/                    # @dadaki/app  (the deployable)
      package.json          #   deps: @dadaki/editor (workspace:*), firebase
      index.html            #   moved from root (app shell)
      public/               #   canvaskit.js + wasm, favicons, etc. (moved from root/public)
      src/
        main.ts             #   bootstrap: load CanvasKit, createEditor, wire Firebase sink
        firebase_analytics.ts
      .env / .env.example   #   moved here (Vite loads env from app root)
      vite.config.ts
      firebase.json         #   or keep at root pointing to packages/app/dist
      tsconfig.json
  tests/svg-suite/          # keep; update how it launches the app
  scripts/                  # keep; fix any moved paths
```

Package boundary rule of thumb:
- **lib**: `types, document, path_ops, svg_*, snapping, boolean_ops, align,
  outline_stroke, text_outlines, gradient_edit, icons, context, analytics
  (dispatcher only), fonts, wasm_scene, renderer, ui, input, context_bar,
  color_picker, toolbar, tab_strip, app_menu, about_dialog, backup_dialog,
  export_dialog, document_manager, file_service, file_io, persistence,
  dev_stress` + all their `*.test.ts`.
- **app**: `main.ts` (bootstrap only), `firebase_analytics.ts`, `index.html`,
  `public/`, `.env*`, Firebase Hosting config.

If any lib file still imports something app-only after the move, that's a
boundary leak — fix by dependency injection (pass it in), not by importing up.

---

## 5. Staged plan (commit + run the gate after EACH phase)

### Phase 0 — Baseline
- Run the full gate (see §6) on the current repo and **record the numbers**:
  tsc clean, biome clean, unit test count/pass, and the SVG suite pass count.
  These are your regression baseline. If anything is already failing, note it so
  you don't get blamed for pre-existing failures.

### Phase 1 — pnpm-workspace scaffolding (no code moved yet)
- **Declare the workspace.** Add a `packages:` list to the existing
  `pnpm-workspace.yaml` (keep its current `allowBuilds` block):
  ```yaml
  packages:
    - engine
    - packages/*
  allowBuilds:
    '@firebase/util': true
    protobufjs: true
    puppeteer: true
  ```
- Create `packages/editor/` and `packages/app/`, each with its own
  `package.json`, `tsconfig.json`, `vite.config.ts`.
  - `packages/editor/package.json`: `"name": "@dadaki/editor"`, `"private": true`
    (until/unless it's actually published), `"type": "module"`; runtime deps
    `canvaskit-wasm`, `opentype.js`, and `"engine": "workspace:*"`.
  - `packages/app/package.json`: `"name": "@dadaki/app"`, `"private": true`,
    `"type": "module"`; deps `"@dadaki/editor": "workspace:*"` and `firebase`.
- **Root `package.json`** stays the workspace root: keep shared dev-deps
  (`typescript`, `@biomejs/biome`, `vitest`, `vite`, `jsdom`, `@types/*`) here so
  they're hoisted; keep `devEngines.packageManager = pnpm`. Move the runtime deps
  (`firebase`, `canvaskit-wasm`, `opentype.js`, `puppeteer` if only used by
  scripts/suite) down into the package that actually imports them. You may keep
  thin root convenience scripts, but remember they're run via direct binaries,
  not `pnpm run` (see §1).
- **Link the workspace with `pnpm install`** (this works; only `pnpm run` is
  broken). Confirm resolution: `packages/editor/node_modules/engine` and
  `packages/app/node_modules/@dadaki/editor` should be symlinks into the
  workspace (`pnpm ls -r --depth -1` to sanity-check membership).
- Gate: `tsc`/`biome` on the (still-at-root) `src/` stay green; `pnpm install`
  succeeds and links the three workspace packages. Commit.

### Phase 2 — Move the lib code
- `git mv` the lib files (per §4) into `packages/editor/src/`, tests included.
- Fix the engine import in `wasm_scene.ts` to the bare `engine` specifier.
- Create `packages/editor/index.ts` public barrel. **This is a temporary
  compatibility shim** so Phases 3–4 keep working before the Option-A migration:
  export the classes `main.ts` currently constructs (`WasmScene, Renderer,
  UIEngine, InputManager, Toolbar, ContextBar, DocumentManager, FileService,
  TabStrip, ExportDialog, BackupDialog, AboutDialog, AppMenu, PersistenceManager,
  Document`) plus `logAppEvent, registerAnalyticsSink, type AnalyticsSink`.
  In Phase 5 this barrel is **replaced** by `createEditor` + `EditorHandle` +
  `EditorOptions` + `AnalyticsSink` (see §3); the raw classes stop being public.
- Update `biome.json` includes; run biome --write across moved files.
- Configure `packages/editor/vite.config.ts` for lib build + vitest jsdom.
- Gate: `tsc --noEmit`, `biome check`, and `vitest run` **inside the editor
  package** must be green; unit-test count must match Phase 0. Commit.

### Phase 3 — Build the app package
- `git mv` `index.html`, `public/`, `.env`, `.env.example`, `firebase_analytics.ts`
  into `packages/app/` (and `main.ts` into `packages/app/src/`).
- Rewrite `main.ts` to import from `@dadaki/editor` and to own ONLY app-shell
  concerns: load CanvasKit global, construct/mount the editor, call
  `registerAnalyticsSink(createFirebaseAnalyticsSink())` **before** anything can
  emit, wire `beforeunload`, and (dev only) attach `window.__editor`/`window.app`.
- Port `optimizeDeps.exclude: ['canvaskit-wasm']` into the app's Vite config.
- Update `index.html`'s module script path to the app's `main.ts`.
- Gate: `./node_modules/.bin/vite build` (app) produces a working `dist/`;
  `./node_modules/.bin/vite` dev server serves the editor and it renders +
  logs `[Analytics] Event: app_loaded` with no console errors. Commit.

### Phase 4 — Fix deploy + conformance + scripts
- Point Firebase Hosting at the app's build output (`packages/app/dist`), either
  by moving `firebase.json`/`.firebaserc` into `packages/app/` or updating the
  `public` path at root. Verify `firebase deploy --only hosting` **dry run** /
  local `firebase emulators` if available (do NOT actually deploy).
- Fix `tests/svg-suite/harness.mjs` to launch/serve the app from its new
  location. Run it; **pass count must equal the Phase 0 baseline** (zero
  regressions). This is a hard gate.
- Fix any `scripts/*` paths that referenced the old `src/` layout.
- Gate: full gate green including SVG suite. Commit.

### Phase 5 — DOM ownership migration (REQUIRED — Option A, see §3)
This is the phase that makes the lib genuinely reusable. Do it incrementally,
re-running the full gate frequently — never leave it half-done between commits.
- **Relocate the editor chrome markup** currently in `packages/app/index.html`
  into the lib (a lib-owned template string / `<template>` clone, or programmatic
  construction), preserving the exact element structure and classes the CSS and
  code expect. Move `style.css` into the lib and import it from lib code.
- **Introduce `createEditor(container, options)`** (signature per §3) that
  constructs that DOM inside `container`, then wires up the same objects `main.ts`
  used to build. It returns an `EditorHandle` (`destroy()` + a minimal,
  intentional surface). If `options.analyticsSink` is provided, call
  `registerAnalyticsSink` with it internally.
- **Eliminate host-page coupling:** convert every global
  `document.getElementById(...)`/`querySelector(...)` in the ~19 DOM-touching lib
  files to `container`-scoped lookups or references captured at construction.
  Legitimate document/window-level APIs (keydown listeners, `createElement`,
  clipboard, rAF) may remain; reaching into host page structure may not.
- **Decide per header control** (`save-btn`, `export-btn`, `app-menu-btn`, zoom
  buttons) whether it's editor chrome (moves into the lib container) or app
  chrome (stays in the app shell, driven via `EditorHandle`/callbacks).
- **Shrink `packages/app/index.html`** to meta + CanvasKit/lucide scripts + a
  single mount node; rewrite `main.ts` to `createEditor(mountEl, { canvasKit,
  analyticsSink: createFirebaseAnalyticsSink() })` plus app-only concerns
  (`beforeunload`, dev `window.__editor`).
- **Replace the Phase-2 compatibility barrel** with the `createEditor` public
  API; the raw editor classes are no longer exported.
- Gate: full gate green, PLUS `grep -rn "getElementById" packages/editor/src`
  returns nothing (all lookups are container-scoped), and the app renders
  identically to Phase 0 behavior. Commit.

---

## 6. Verification gate (run after every phase; all must pass)

From the relevant package dir, using direct binaries (not pnpm scripts):

1. `./node_modules/.bin/tsc --noEmit` → exit 0, no errors.
2. `./node_modules/.bin/biome check` → clean (run `--write` to fix format/import order).
3. `./node_modules/.bin/vitest run` → **same test count and all passing** as Phase 0.
4. `./node_modules/.bin/vite build` (app) → succeeds; `dist/` emitted.
5. Dev server: app loads, canvas renders, console shows
   `[Analytics] Event: app_loaded`, **no errors/warnings** in console.
6. `tests/svg-suite/harness.mjs` → pass count **== Phase 0 baseline** (no
   regressions against `baseline.json`).

Do not consider a phase done until its gate is green. Never edit
`tests/svg-suite/baseline.json` to make the suite pass — that hides regressions.

---

## 7. Definition of done

- Two packages (`@dadaki/editor`, `@dadaki/app`) in a **pnpm** workspace declared
  via `pnpm-workspace.yaml` `packages:`; cross-package deps use `workspace:*`;
  `engine` is a workspace package consumed via the bare specifier `engine`.
  No npm/yarn workspace config introduced.
- **Option A achieved:** the lib's public API is
  `createEditor(container, options)` returning an `EditorHandle`; the app mounts
  the editor into a single container. `grep -rn "getElementById" packages/editor/src`
  returns nothing — no lib code reaches outside its container into a host page.
- **No** lib file imports `firebase`, reads `import.meta.env.VITE_FIREBASE_*`,
  or references Firebase Hosting. `grep -rn "firebase" packages/editor/src`
  returns nothing.
- `main.ts` (app) is the single wiring point: loads CanvasKit, builds the
  Firebase analytics sink, calls `createEditor(mount, { canvasKit,
  analyticsSink })`, and owns dev handles + `beforeunload`.
- All unit tests pass (count unchanged); SVG conformance suite passes with zero
  regressions; app builds and deploys (dry-run verified).
- Firebase config still loads from `.env` (now at the app package root);
  `.env` remains gitignored, `.env.example` tracked.
- Behavior is unchanged for the end user.

## 8. Do NOT

- Do not change editor behavior/logic; this is a structural move.
- Do not rebuild or edit the Rust engine (`engine/src`); no WASM rebuild needed.
- Do not commit `.env`; keep it gitignored.
- Do not weaken the SVG baseline to pass the gate.
- Do not use `npx` or `pnpm run <script>` (they fail here) — call binaries in
  `node_modules/.bin/` directly. (`pnpm install` / `pnpm --filter … add` are fine.)
- Do not introduce npm or yarn workspaces / a `package.json` `workspaces` field —
  this is a **pnpm** workspace (`pnpm-workspace.yaml` + `workspace:*`).
- Do not skip or defer Phase 5 — Option A (`createEditor` owns its DOM) is the
  chosen end state, not optional.
- Do not attempt the whole split in one commit — follow the phased gates.
```
