# @dadaki/mcp

An MCP server that lets an agent author real vector artwork in Dadaki — as
vector geometry, not a generated raster image.

## Why it works this way

The obvious reading of "let an agent use a vector editor like a human" is to
give it a mouse: screenshot, click the rectangle tool, drag. That is the wrong
implementation. It's slow, it breaks on every UI change, and agents are poor at
pixel-precise dragging.

What actually carries over from a human at a drawing tool is the **feedback
loop** — place something, look at it, correct it. So the tools here are verbs at
the level of *intent* (`create_rect`, `align`, `boolean`), and they're paired
with `describe_scene` and `render_png_image` so the agent can see what it made.
Every mutating tool also returns the affected node, so placement can be checked
without a round-trip.

## Architecture

```
agent ──stdio──▶ MCP server (node) ──CDP──▶ headless Chrome
                                              └─ the real editor build
                                                 (CanvasKit + Rust/WASM engine)
```

The editor is a browser application: CanvasKit, the WASM engine and the whole
tool layer assume a DOM and a GPU canvas. Rather than maintain a second,
inevitably-divergent Node implementation, the server runs the **real** editor
build in headless Chrome and calls into it. Agent edits therefore go through the
same engine, history and export paths as a human's.

The page is served from `packages/app/dist` by a static server on an ephemeral
loopback port. No dev server, no network access.

## Setup

```bash
pnpm install
pnpm build          # produces packages/app/dist, which the server serves
```

Register it with an MCP client:

```json
{
  "mcpServers": {
    "dadaki": {
      "command": "node",
      "args": ["--experimental-strip-types", "/path/to/vector-editor/packages/mcp/src/index.ts"]
    }
  }
}
```

Set `DADAKI_MCP_HEADFUL=1` to watch the browser work — useful when debugging
what an agent is actually doing.

## Tools

| Group | Tools |
| --- | --- |
| Seeing | `describe_scene`, `render_png`, `render_png_image`, `export_svg` |
| Creating | `create_rect`, `create_ellipse`, `create_polygon`, `create_star`, `create_path`, `create_path_data`, `create_text`, `import_svg` |
| Styling | `set_fill`, `set_gradient`, `set_stroke`, `set_opacity`, `set_corner_radius`, `set_text` |
| Arranging | `move`, `set_position`, `resize`, `rotate`, `align`, `distribute`, `bring_to_front`, `send_to_back` |
| Canvas | `set_canvas`, `fit_canvas_to_artwork` |
| Structuring | `group`, `ungroup`, `duplicate`, `delete`, `clear`, `rename`, `boolean` |
| Session | `undo`, `redo` |

Coordinates are world units with y growing downward. Colours are CSS hex.

Three are worth calling out:

- **`import_svg`** is usually the fastest route to complex artwork — compose the
  drawing as SVG markup, import it, then refine with the other verbs. Gradients,
  groups and transforms survive.
- **`create_path_data`** takes an SVG `d` attribute. Agents are far more fluent
  in path data than in point arrays, and arcs can't be expressed any other way.
- **`align` / `distribute`** are exact. Computing even spacing by hand is
  precisely what agents get subtly wrong.

## Design notes

Several behaviours differ from the editor's internal defaults. The rule behind
all of them: **an agent cannot notice what a human would.** A human sees a stray
outline and deletes it; an agent ships it.

- **Strokes are opt-in at creation.** The engine's default node style carries a
  black 2px stroke, so "a yellow circle" would arrive with an unintended black
  outline.
- **Text defaults to black, not white.** The engine defaults text to a white
  fill, which is invisible on the default white artboard — the node describes
  perfectly and draws nothing, which is undiagnosable from the agent's side.
- **Renders frame the artboard, not the editor.** Rulers, grid and the artboard
  label cost resolution and are indistinguishable from artwork in a screenshot.
  The view is fitted first so the drawing fills the image.
- **Renders clear the selection first.** Selection handles read as a stray
  outlined rectangle.
- **Gradients are given as an angle**, resolved against each node's own local
  box. That box is not uniform — a Rect spans `0..w` from a top-left origin, an
  Ellipse spans `-r..r` about its centre — and getting it wrong yields a shape
  that reports as a gradient fill but renders as flat colour.

One agent call is exactly one undo step (everything routes through
`WasmScene.transaction()`), so a human can step back through an agent's work at
the same granularity as their own. That invariant is pinned in
`packages/editor/src/agent.test.ts`.

## A note on testing this

Every one of the defaults above exists because of a bug found by **rendering the
output and looking at it**, not by a failing assertion. The gradient bug is the
sharpest example: the test asserted `fillType === 'gradient'` and passed, while
the shape rendered as flat blue.

If you extend this, assert on the thing that makes the artwork correct —
gradient endpoints, path bounds, resolved colours — not on metadata that would
survive the feature being broken.

## Testing

```bash
pnpm test                                              # agent API unit tests
node --experimental-strip-types packages/mcp/smoke.ts  # full MCP round-trip
```

The unit tests cover the agent API against the real WASM engine. The smoke test
covers what only exists assembled: the MCP handshake, the CDP bridge, CanvasKit
booting headless, and rendering.
