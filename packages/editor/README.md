# @dadaki/editor

A high-performance, embeddable **in-browser vector graphics editor**. The
rendering + geometry core is compiled from Rust to WebAssembly and drawn with
[CanvasKit](https://skia.org/docs/user/modules/quickstart/) (Skia); the editor
UI (tools, layers, properties, rulers, multi-document tabs) is TypeScript.

It ships as a single embeddable component: give it a DOM container and a
CanvasKit instance, and it builds the whole editor inside that container.

## Install (workspace / local link)

This package is currently distributed via the workspace (not npm). Consume it
with a `workspace:*` (pnpm) or a local `link:`/`file:` dependency:

```jsonc
// package.json
{
  "dependencies": {
    "@dadaki/editor": "workspace:*" // or "link:../vector-editor/packages/editor"
  }
}
```

## Usage

```ts
import { createEditor } from '@dadaki/editor';
import '@dadaki/editor/style.css';

// The host loads CanvasKit (via the canvaskit.js <script> or the npm package)
// and passes the instance in. Optionally load the `lucide` global for icons.
const canvasKit = await CanvasKitInit({ locateFile: (f) => `/${f}` });

const editor = await createEditor(document.getElementById('app')!, {
  canvasKit,
  // optional: receive analytics events
  analyticsSink: (name, props) => console.log('event', name, props),
});

// The handle exposes the pieces a host legitimately needs:
editor.documentManager; // open/create/rename/close documents
editor.activeDocument(); // currently active document
editor.destroy();        // tear down + clear the container
```

### `createEditor(container, options)`

| Option          | Type            | Description                                             |
| --------------- | --------------- | ------------------------------------------------------- |
| `canvasKit`     | `CanvasKit`     | Required. A loaded CanvasKit instance.                  |
| `analyticsSink` | `AnalyticsSink` | Optional. Receives `(eventName, props)` for every event.|

Returns an `EditorHandle` with `scene`, `ui`, `input`, `renderer`,
`documentManager`, `fileService`, `activeDocument()`, `stress()`, and
`destroy()`.

## Host contract

- **The host loads CanvasKit** and passes the instance to `createEditor` — the
  library never fetches it. (`canvaskit.js` + `canvaskit.wasm` are served by the
  host; see the `@dadaki/app` demo shell.)
- **The host may load the `lucide` icon global** (`<script src=".../lucide">`).
  Icons are optional chrome; the editor works without it.
- **The library owns everything inside `container`.** It never imports Firebase,
  reads environment variables, or reaches into host-page structure.
- Documents persist locally (IndexedDB) by default — there is no backend
  dependency. Cloud sync is layered on top by a host app (see `@dadaki/cloud`).
- **A host that puts more than one session in the same document must assign
  each a distinct `siteId`** (see below). Single-user hosts can ignore it.

## Object identity (`siteId`)

Node ids are partitioned by *site*:

```
id = (siteId << 22) | counter        siteId 0…1023, counter 0…4_194_303
```

A "site" is one editing **session**, not one user and not one account — two
tabs are two sites. Give concurrent sessions different site ids and they can
create objects at the same time without ever producing the same id, which is
the prerequisite for merging their edits at all.

```ts
const editor = await createEditor(el, { canvasKit, siteId: 3 });
editor.setSiteId(7);   // if the host learns its site later (e.g. a presence handshake)
```

Three properties worth knowing, each covered by tests in
`engine/src/lib.rs` (`mod identity_tests`):

- **`siteId: 0` is the legacy numbering.** `make_id(0, n) === n`, so documents
  written before sites existed are bit-identical and keep allocating where they
  left off. This is why the default is 0 and why single-user hosts see no change.
- **Site ids are reusable.** On load, an engine resumes its own site's counter
  past the highest id that site already has in the document, so a later session
  reusing site 3 cannot reissue ids the earlier one created. Uniqueness is only
  required among sessions that overlap *in time* — which is what keeps 10 bits
  enough.
- **Undo never recycles an id.** Undo rewinds the serialized counter (so a
  snapshot round-trip is byte-identical) but allocation is floored by a session
  watermark. An id retired by undo is not handed to a different object — a peer
  may already know that id, and reissuing it would give two distinct objects one
  identity.

Changing `siteId` mid-session is safe: existing objects keep their ids, and the
counter for the new site resumes from what the document already contains.

## Limitations (v1)

The injected chrome uses stable element ids, so **one editor instance per
document** is supported. Full container-scoped, multi-instance isolation is a
planned hardening step.

## License

MIT © Dadaki
