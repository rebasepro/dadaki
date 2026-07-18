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
| Creating | `create_rect`, `create_ellipse`, `create_polygon`, `create_star`, `create_path`, `create_text` |
| Styling | `set_fill`, `set_stroke`, `set_opacity`, `set_corner_radius` |
| Arranging | `move`, `set_position`, `resize`, `rotate`, `align`, `distribute` |
| Structuring | `group`, `ungroup`, `duplicate`, `delete`, `rename`, `boolean` |
| Session | `undo`, `redo` |

Coordinates are world units with y growing downward. Colours are CSS hex.

`align` and `distribute` are exposed deliberately: computing even spacing by
hand is exactly what agents get subtly wrong, and these are exact.

## Design notes

Two behaviours differ from the editor's internal defaults, both because an agent
can't notice what a human would:

- **Strokes are opt-in at creation.** The engine's default node style carries a
  black 2px stroke. A human sees it and removes it; an agent asking for "a
  yellow circle" would ship one with an unintended black outline it never
  registered in a render.
- **Renders clear the selection first.** Selection handles are editor chrome,
  and in a screenshot an agent can't distinguish them from a rectangle it drew.

One agent call is exactly one undo step (everything routes through
`WasmScene.transaction()`), so a human can step back through an agent's work at
the same granularity as their own. That invariant is pinned in
`packages/editor/src/agent.test.ts`.

## Testing

```bash
pnpm test                                              # agent API unit tests
node --experimental-strip-types packages/mcp/smoke.ts  # full MCP round-trip
```

The unit tests cover the agent API against the real WASM engine. The smoke test
covers what only exists assembled: the MCP handshake, the CDP bridge, CanvasKit
booting headless, and rendering.
