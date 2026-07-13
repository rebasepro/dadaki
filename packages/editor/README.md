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

## Limitations (v1)

The injected chrome uses stable element ids, so **one editor instance per
document** is supported. Full container-scoped, multi-instance isolation is a
planned hardening step.

## License

MIT © Dadaki
