# BUILD PLAN — Split the vector editor into (1) open-source editor + (2) online app on Rebase

> **Authored:** 2026-07-13 ~02:06 CEST, by Claude, from an overnight instruction by Francesco.
> **Scheduled execution start:** ~06:06 CEST 2026-07-13 (4h later, once the token quota refilled).
> **This document is the single source of truth.** It is written to survive context loss.
> If you are the scheduled agent waking up: read this file top to bottom, then execute.

---

## 0. The instruction (verbatim intent)

Francesco went to bed and asked me to start this task in ~4 hours (when his token quota
refills). The goal:

- **Split this project into two parts.**
  1. **The editor as it is now** → this becomes **open source**.
  2. **The online app** → a hosted product that uses **Rebase** (our own BaaS, the sibling
     project at `/Users/francesco/rebase`) as its backend.
- **Use Rebase 0.9, linked locally** (NOT from npm — link the local checkout at
  `/Users/francesco/rebase`). See §4 on the version note.
- **Set up a NEW Rebase project locally** for the online app.
- **Basic features required:**
  - **Login — but the app is fully usable with no login** (anonymous/local-only mode).
  - **Logging in unlocks cloud sync**: your vector files sync to the **"dadaki cloud"**
    (built on Rebase storage + collections).
  - **Teams**, with a **default team auto-created per user**.
- **The whole thing must have EXCEPTIONAL UX.**
- **Be proactive — he will not be around to answer questions.** Make sensible decisions,
  document them here, keep going.
- **Do NOT deliver a half-baked solution.** He wants something *releasable* when he wakes up.

> He asked "is that clear?" — Yes. This plan is the answer.

---

## 1. Guardrails (READ FIRST — non-negotiable)

1. **Never deploy.** Do NOT run `rebase deploy`, `firebase deploy`, `gcloud`, or anything
   that pushes to live infra. Build and run locally only. Provide deploy commands in a
   README for Francesco to run himself.
2. **Never commit secrets.** `.env` files stay gitignored. Verify before every commit.
3. **Behavior-preserving on the editor side.** The editor split is a *structural* refactor —
   no feature/logic changes. The editor must still build, pass all unit tests, and pass the
   SVG conformance suite with **zero regressions**.
4. **Commit frequently, in small logical steps, with the verification gate green.** Never
   leave the tree broken between commits. Branch first (do not work directly on `main` for
   risky phases — but note the editor split plan below builds on `main`; create a branch
   `online-split` at the start and do all work there).
5. **pnpm only.** Both repos are pnpm workspaces. Never introduce npm/yarn workspaces.
6. **Tooling quirk (editor repo):** `pnpm run <script>` and `npx` FAIL in this environment.
   Run tool binaries directly from `node_modules/.bin/` (e.g. `./node_modules/.bin/tsc`,
   `./node_modules/.bin/vite build`, `./node_modules/.bin/vitest run`,
   `./node_modules/.bin/biome check`). `pnpm install` and `pnpm --filter … add` DO work.
7. **WASM engine:** do NOT rebuild it. `engine/pkg` is prebuilt. The rustup toolchain is
   not on PATH. This whole task should require **zero** engine rebuilds.
8. **Keep a running log** at the bottom of this file (§9) — append what you did, decisions,
   and current status after every phase, so any future wake-up can resume.
9. **If genuinely blocked on an irreversible or account-level decision** (e.g. creating a
   cloud account, real OAuth credentials, payment, DNS), STOP and leave a clear note in §9
   for Francesco rather than guessing. Everything else: decide and proceed.

---

## 2. Deliverables & target architecture (DECISIONS — already made, proceed)

Two products out of one repo:

### A. `@dadaki/editor` — the open-source editor (library) + a zero-backend demo shell
- The reusable editor **library**, produced by the split already fully specified in
  **`TASK-lib-app-split.md`** (in this same directory). That doc is the authoritative,
  phased plan for the *editor* half. **Execute it as written** (Phases 0–5, Option A:
  `createEditor(container, options)` owns its DOM). Its definition of done stands.
- Plus a **minimal open-source demo app** (`packages/app`) with **no backend**: works fully
  offline/local (documents persisted to IndexedDB/localStorage as today). This is what gets
  open-sourced. It must NOT depend on Rebase or Firebase secrets. Anonymous local-only use.

### B. `@dadaki/cloud` (working name) — the online app, backed by Rebase
A **new Rebase project, scaffolded locally** (`rebase init`), with the local Rebase packages
linked in (see §4). It consumes `@dadaki/editor` and adds the product layer:

- **Optional auth.** App loads straight into the editor with NO login required (anonymous,
  local-only, identical to the OSS demo). A clear, non-nagging "Sign in to sync" affordance.
- **Cloud sync ("dadaki cloud").** On login, the user's vector documents sync to Rebase:
  - Document metadata in a Rebase **collection** (`documents`: id, name, ownerId, teamId,
    thumbnail, updatedAt, size, a version/updatedAt for conflict handling).
  - Document payload (the serialized editor scene — protobuf snapshot / SVG) in Rebase
    **storage**, referenced from the `documents` row. (Decide: inline vs storage blob based
    on size; large scenes → storage.)
  - Sync engine: local-first. Edits save locally immediately; a debounced sync pushes to
    cloud when authenticated and online. Handle offline→online reconciliation. Last-write-
    wins by `updatedAt` for v1, but keep the door open for smarter merge (document it).
- **Teams.** A `teams` collection + `team_members` (userId, teamId, role). **On user
  creation, auto-create a default personal team** ("<name>'s Team") and add the user as
  owner — via a Rebase auth/user `afterSave`/registration hook or `defaultUsersCollection`
  callback (see `rebase-auth` + `rebase-collections` skills). Documents belong to a team
  (default: the personal team). A team switcher in the UI. RLS/roles so members only see
  their teams' documents (see `rebase-security` / `rebase-auth` skills for RLS policies).
- **Exceptional UX** (this is the bar Francesco is judging on):
  - A polished **dashboard / file browser** (grid of document thumbnails, recent, search,
    rename, duplicate, delete, "New document"), team switcher, account menu, sync status
    indicator ("Saved to cloud" / "Saving…" / "Offline — local only").
  - Seamless transition: an anonymous user with local docs who signs in should be offered to
    **import their local documents into the cloud** (don't silently lose them).
  - Editor opens in-place; back-to-dashboard; shareable URL per doc (route by doc id).
  - Design language consistent with the editor's existing look (reuse `style.css` tokens) —
    consult `rebase-design-language` / `rebase-ui-components` skills; you MAY use
    `@rebasepro/ui` for the shell chrome, but the canvas/editor stays as-is.
  - Empty states, loading skeletons, optimistic updates, keyboard-friendly, responsive,
    dark-mode aware. No dead ends, no unlabeled buttons, visible feedback for every action
    (this matches the repo's own "action-vs-property UX" rule — see the memory index).

**Repo/dir layout decision:**
- The editor split (A) happens **in this repo** (`/Users/francesco/vector-editor`), per
  `TASK-lib-app-split.md`, on branch `online-split`. Result: `packages/editor` (OSS lib),
  `packages/app` (OSS zero-backend demo), `engine` (workspace pkg).
- The online app (B) — the new Rebase project — scaffold it at
  **`/Users/francesco/dadaki-cloud`** (a NEW sibling directory, its own git repo). It depends
  on `@dadaki/editor`. For local dev, link `@dadaki/editor` via a pnpm `file:`/`link:`
  dependency to `/Users/francesco/vector-editor/packages/editor` (or publish it to a local
  verdaccio if cleaner — file link is simplest). Document the link clearly.
  - Rationale: keeps the OSS editor repo free of any Rebase/product code, and keeps the
    commercial online app in its own repo — exactly the "two parts" split requested.

> If, once you see the code, a monorepo-with-both approach is clearly better, you may choose
> it — but the hard requirement is a **clean boundary**: the OSS editor must have zero
> dependency on Rebase, Firebase secrets, or the product app.

---

## 3. Key locations & ground-truth facts

- **Editor repo:** `/Users/francesco/vector-editor` (this repo). Single Vite + TS + Rust/WASM
  app, ~25k LOC. `src/ui.ts` ~6100 lines, `src/input.ts` ~4900. Prebuilt WASM in
  `engine/pkg`. pnpm workspace prepped (`pnpm-workspace.yaml` has no `packages:` list yet;
  no `packages/` dir exists yet — the split has NOT started).
  - Authoritative editor-split plan: **`TASK-lib-app-split.md`** (read it fully).
  - Progress/feature docs: `PROGRESS.md`, `FEATURES-PLAN.md`.
  - Editor already depends on `firebase` (only `src/firebase_analytics.ts` uses it) — that is
    an *app* concern and moves to the app per the split plan; the OSS lib must not import it.
- **Rebase repo (the BaaS):** `/Users/francesco/rebase`. pnpm monorepo. Packages under
  `packages/*` as `@rebasepro/*` (core, types, ui, admin, studio, auth, cli, client,
  client-postgresql, server-core, server-postgresql, common, formex, utils, mcp-server, …).
  - **Rebase agent skills live at `/Users/francesco/rebase/rebase-agent-skills/skills/`** —
    one dir per skill, each with a `SKILL.md`. These are NOT installed as Skill-tool skills
    in this environment, so **read them as files**. Master doc:
    `/Users/francesco/rebase/rebase-agent-skills/REBASE.md`. Most relevant skills:
    `rebase-basics`, `rebase-local-env-setup`, `rebase-collections`, `rebase-auth`,
    `rebase-security`, `rebase-storage`, `rebase-sdk`, `rebase-studio`,
    `rebase-custom-functions`, `rebase-realtime`, `rebase-ui-components`,
    `rebase-design-language`, `rebase-deployment`.
  - **Reference app** demonstrating a full Rebase product: `/Users/francesco/rebase/saas`
    and `/Users/francesco/rebase/app` (scaffold example). **Study these for auth + teams +
    collections + UI patterns before writing product code.** Also `examples/`.
  - Rebase CLI: `packages/cli` (`@rebasepro/cli`) → the `rebase` binary. Key commands:
    `rebase init [name]`, `rebase dev [--generate]`, `rebase schema generate`,
    `rebase db push`, `rebase generate-sdk`, `rebase auth reset-password`, `rebase doctor`.
    Login for cloud/MCP: `rebase login` (Google OAuth; tokens at `~/.rebase/tokens.json`).
- **Existing Rebase scaffolds to crib from:** `/Users/francesco/my-rebase-app`,
  `/Users/francesco/edith-crm`, `/Users/francesco/sustentalent` (all have `.rebase` or
  `rebase_packages`). `~/.rebase/` exists (CLI state).
- **Local Postgres:** Rebase needs Postgres (or Docker). Verify per `rebase-local-env-setup`.
  `rebase init` can scaffold a `docker-compose.yml` Postgres. Prefer that if no local PG.
- **"dadaki" branding:** existing `/Users/francesco/dadaki` project and
  `~/Desktop/dadaki design` assets exist. The editor's package name is
  `dadaki-vector-editor`; `.firebaserc` project `dadaki-vector`. Keep the dadaki brand for
  the cloud app.

---

## 4. The "Rebase 0.9" version note (RESOLVED by Francesco)

**Francesco confirmed (2026-07-13, before sleeping): "just link to whatever version of
rebase is there locally."** So this is settled — do NOT treat the version as an open
question. Link the online app against **whatever `@rebasepro/*` version currently exists in
the local `/Users/francesco/rebase` checkout** (it happens to be `0.8.0` WIP = his "0.9").
Never `pnpm add @rebasepro/*` from npm.

**Action:** Link the online app against the **local `/Users/francesco/rebase` packages**
(via pnpm `workspace:`/`link:`/`file:` or the CLI's local-link mechanism — check
`rebase-local-env-setup` and `rebase-basics` for whether `rebase init` supports linking to a
local framework checkout; `packages/cli` may have a `--local`/link flag, and other local
scaffolds like `my-rebase-app` show the linking pattern — replicate it). Do NOT `pnpm add
@rebasepro/*` from npm. Verify the app resolves `@rebasepro/*` to the local checkout
(symlinks into `/Users/francesco/rebase/packages/*`). If the local packages need a build
first, run their build (`rebase build` or the repo's build) — but do not modify the Rebase
framework code itself unless strictly necessary (and if you do, note it in §9).

---

## 5. Phased execution plan

Work on branch **`online-split`** in the editor repo; the online app is its own new repo.
Run the verification gate (editor: §6 of `TASK-lib-app-split.md`) after each editor phase.

### Phase 0 — Setup & baseline (do first)
- `cd /Users/francesco/vector-editor`; `git checkout -b online-split`.
- Read fully: `TASK-lib-app-split.md`, `PROGRESS.md`, `FEATURES-PLAN.md`, and the memory
  index at `/Users/francesco/.claude/projects/-Users-francesco-vector-editor/memory/`.
- Read the Rebase skills listed in §3 (at minimum: basics, local-env-setup, collections,
  auth, security, storage, sdk, ui-components, design-language). Read `saas/` + `app/`.
- Record the editor baseline numbers (tsc/biome/vitest counts, SVG suite pass count).
- Verify environment: Node 20+, pnpm, Postgres/Docker (`rebase-local-env-setup`).
- Append a plan-of-record to §9.

### Phase 1 — Execute the editor lib/app split (OSS half)
- Follow `TASK-lib-app-split.md` Phases 1–5 exactly (pnpm workspace; move lib into
  `packages/editor`; build zero-backend `packages/app`; fix deploy/conformance/scripts;
  Option-A `createEditor(container, options)` DOM migration). Gate green after each phase.
- End state: `@dadaki/editor` is a clean, reusable, Rebase/Firebase-free library; the OSS
  demo app runs with local-only persistence. Commit per phase.
- Prepare it for open-sourcing: add `LICENSE` (ask? — default MIT is a safe assumption for a
  library like this; note the choice in §9), a real `README.md` (what it is, quick start,
  `createEditor` API, build), and ensure no secrets/tracked `.env`. Do NOT publish to npm or
  push to a public remote — just make the repo release-ready locally.

### Phase 2 — Scaffold the online Rebase app
- Scaffold at `/Users/francesco/dadaki-cloud` via the local Rebase CLI (`rebase init
  dadaki-cloud` or equivalent), linking the **local** Rebase packages (§4). Own git repo.
- Get `rebase dev` running (backend + frontend), Postgres up (docker-compose from init if
  needed), schema generated, DB pushed. Confirm the default Rebase studio/admin loads.
- Wire in `@dadaki/editor` via a local link to
  `/Users/francesco/vector-editor/packages/editor`. Render the editor inside the app shell
  via `createEditor(...)`. Confirm it renders and edits identically to the OSS demo.
- Commit.

### Phase 3 — Auth (optional) + Teams (default per user)
- Configure Rebase auth: email/password + Google OAuth optional (leave OAuth creds as env
  placeholders — do NOT invent real client secrets; document what Francesco must fill in).
  `ALLOW_REGISTRATION=true` in dev.
- App must be **fully usable anonymously** (no auth wall). Sign-in is optional and unlocks
  sync. Implement a clean auth UI (use `@rebasepro/auth` / `@rebasepro/ui` where it helps).
- Collections: `teams`, `team_members` (role: owner/member), and `documents` (see §2B).
  Define as schema-as-code in `config/collections/*.ts`. `rebase schema generate && rebase
  db push`.
- **Auto-create a default personal team on user creation** (auth/user `afterSave` callback or
  custom function). Add the creator as owner. New anonymous→signed-in users get their team.
- RLS/roles: users see only documents in teams they belong to (`rebase-security`).
- Commit.

### Phase 4 — Cloud sync ("dadaki cloud")
- Implement local-first sync between the editor's document store and Rebase:
  - Save scene payload to Rebase storage (or inline for small docs); metadata to `documents`.
  - Debounced push on edit when authenticated + online; pull/list on dashboard load.
  - Sync-status UI states; offline→online reconciliation; last-write-wins by `updatedAt` v1.
  - **On first sign-in, offer to import existing local (anonymous) documents to the cloud.**
- Use the Rebase **SDK** (`@rebasepro/client` / generated SDK), NOT hand-rolled fetch/URLs
  (`rebase-sdk` skill). `client.functions.invoke(...)` for any custom backend functions.
- Commit.

### Phase 5 — Dashboard & product UX polish (the "exceptional UX" bar)
- Build the dashboard/file browser, team switcher, account menu, share-by-URL, sync
  indicator, empty/loading states, responsive + dark mode, per §2B. Reuse editor design
  tokens. Every action gives visible feedback; no unlabeled controls; no dead ends.
- Thumbnails for documents (render a preview on save).
- Full run-through with the browser preview tools: create → edit → sync → reload → sign out →
  anonymous → sign in → import. Screenshot key states. Fix everything rough.
- Commit.

### Phase 6 — Docs, verification, release-readiness
- READMEs for both repos: OSS editor (what/why/quickstart/API) and dadaki-cloud (setup,
  local Rebase linking, env vars to fill, how to run, how to deploy — commands only).
- Final gates: editor unit tests + SVG suite zero-regression; online app builds + runs;
  end-to-end sync + teams verified via the preview tools with screenshots.
- Update §9 with a crisp "what's done / what's left / how to run / decisions & assumptions /
  anything needing Francesco" summary he can read in 2 minutes.

---

## 6. Definition of done (the bar for "releasable")

- **OSS editor:** `@dadaki/editor` builds as a library, is Rebase/Firebase-free
  (`grep -rn "firebase\|rebasepro" packages/editor/src` → nothing), `createEditor(container,
  options)` is the public API (`grep -rn getElementById packages/editor/src` → nothing), all
  unit tests pass (count unchanged from baseline), SVG conformance suite passes with **zero
  regressions**, OSS demo app runs local-only. Repo is release-ready (LICENSE, README, no
  secrets) — but NOT pushed/published.
- **Online app:** scaffolded Rebase project at `/Users/francesco/dadaki-cloud` linked to the
  **local** Rebase 0.9 checkout; runs via `rebase dev`; editor embedded via `@dadaki/editor`;
  anonymous use works with zero friction; sign-in optional and unlocks cloud sync; a default
  personal team is auto-created per user; teams switch + isolate documents; documents sync to
  the dadaki cloud with visible sync status and local→cloud import on first sign-in; a
  polished dashboard with genuinely exceptional, feedback-rich UX. Builds cleanly.
- **Verified, not assumed:** the end-to-end flow demonstrated with the browser preview tools
  and screenshots captured. No deploys performed. No secrets committed. §9 summary written.

If time runs short, prioritize a **coherent, working, polished vertical slice** (anonymous →
sign in → default team → create/edit → sync → reload → see it) over breadth. Do NOT leave the
tree broken or half-wired. "Releasable" > "feature-complete but flaky."

---

## 7. Open decisions I made autonomously (Francesco can override on waking)
- New online app repo at `/Users/francesco/dadaki-cloud`, separate from the OSS editor repo.
- `@dadaki/editor` linked into the online app via local file/link dep.
- "Rebase 0.9" = the local `/Users/francesco/rebase` checkout, whatever version it currently
  is (Francesco confirmed "just link to whatever's there locally") — §4.
- OSS license default MIT (change if he prefers). No pushing to public remotes / no npm
  publish / no cloud deploy — all left for him.
- Sync conflict strategy v1 = last-write-wins by `updatedAt`.
- Google OAuth left as env placeholders (no real secrets invented).

## 8. Things that would STOP me and need Francesco (leave a note, don't guess)
- Creating any real cloud account, real OAuth client secrets, DNS, billing, or deploying.
- Publishing to npm or pushing either repo to a public GitHub remote.
- Anything requiring a password/credential entry (prohibited — he must do it).

---

## 9. RUNNING LOG (append-only — update after every phase)

- 2026-07-13 02:06 CEST — Plan authored. Explored both repos, read `TASK-lib-app-split.md`
  and the Rebase master skill + basics/local-env-setup. Scheduled execution to begin ~06:06
  CEST via a timed wake-up. No code changed yet. Editor split not started (no `packages/`).
  Rebase packages at 0.8.0 locally (= "0.9" WIP). Awaiting scheduled start.

- 2026-07-13 06:07 CEST — **Phase 0 done.** Woke on schedule, `caffeinate` still holding the
  Mac awake. Created branch `online-split`. Env verified: Node v22.22.3, pnpm 11.9.0, psql
  18.4 running (`/tmp:5432 accepting connections`; existing `rebase`/`rebase_saas` DBs + a
  `rebase` role present). Docker not running (not needed — native PG available).
  **Editor baseline on `online-split`:** tsc `--noEmit` clean; vitest **452 tests / 26 files
  all pass**; biome check = **5 pre-existing errors** (import ordering in `align.ts`,
  `document_manager.ts`, `export_dialog.ts`, `file_service.ts` — present on `main`, not
  introduced by this work; the split's `biome --write` will clear them). SVG suite:
  `tests/svg-suite/baseline.json` holds 1679 per-fixture similarity scores and IS the
  regression reference; harness will be run at the Phase-1 gate (running it on unchanged code
  is a no-op). Starting Phase 1 (editor lib/app split).
