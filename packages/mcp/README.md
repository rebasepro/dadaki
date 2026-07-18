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

The editor is a browser application: CanvasKit, the WASM engine and the whole
tool layer assume a DOM and a GPU canvas. Rather than maintain a second,
inevitably-divergent Node implementation, the server drives the **real** editor.
Agent edits therefore go through the same engine, history and export paths as a
human's.

The agent API (`EditorHandle.agent`) is identical in every editor instance. What
differs between modes is only how a call gets into the page, which is isolated
behind one `EditorTransport` interface — so **every tool works in every mode**,
and nothing in the tool layer knows which is in use.

```
                          ┌── CDP ──▶ a browser this server launches
agent ──stdio──▶ MCP server
                          └── ws  ──▶ the editor tab YOU already have open
```

Rendering is not special-cased per mode. `render_png` is an ordinary call to
`agent.toPNG()`, which CanvasKit services inside the page through the editor's
own export path — so a render produces the same pixels in every mode, with no
editor chrome, at whatever scale is asked for.

## Modes

| Mode | What it does | Use it for |
| --- | --- | --- |
| `bridge` | Drives the editor tab **you** have open | Working alongside the agent — the default in `.mcp.json` |
| `headless` | Throwaway browser serving the local build | Scripts, CI, unattended work |
| `headful` | The same, with a visible window | Watching an agent work; debugging |
| `--url <addr>` | Any of the above, pointed elsewhere | Dev server, staging, the deployed app |

**`headless` is the code default; `bridge` is what the checked-in `.mcp.json`
selects.** That split is deliberate: headless is right for a script, and wrong
for a person. In headless mode the document lives in an invisible browser owned
by the server process — you can't see it, can't take it over, and it is **lost
when the server restarts**, which MCP clients do routinely. Reach for it when
something else is consuming the exported SVG, not when you want to keep the
artwork.

### Setup

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

Add `"--mode", "bridge"` to `args` (or `"env": {"DADAKI_MCP_MODE": "bridge"}`) to
switch modes. `DADAKI_MCP_HEADFUL=1` still works.

### Bridge mode

The server launches no browser. It listens on loopback and prints a URL:

```
[dadaki-mcp] bridge mode — listening on 127.0.0.1:54666
[dadaki-mcp] open your editor with this URL to attach it:

    http://localhost:5199/?agentBridge=54666&token=…
```

Open that once and the tab attaches. The credentials are stripped from the
address bar (so the token doesn't linger in history or get pasted into a shared
link) and remembered, so reloads stay attached — call
`clearBridgeCredentials()` to stop.

**The URL is stable, so "once" really means once.** The port is fixed (7331) and
the token is persisted to `~/.dadaki/agent-bridge.json` (mode 0600, outside any
repo so it is never committed). A token minted per run would reject the attached
tab on every server restart, which would mean re-pasting a URL constantly and
make the mode unusable. If port 7331 is taken the server falls back to a free
one and says so — that run's URL is the one to use.

You keep working in the same window while the agent does. Its edits are ordinary
edits: same undo history, same granularity, so you can undo its work, correct
it, or take over mid-drawing.

The channel is a remote control into your document, so it is deliberately
narrow: loopback only, one editor at a time (a second is refused, so a call is
never ambiguous about which document it hit), token-gated with a timing-safe
comparison, and able to invoke only functions that exist on the agent API — it
cannot evaluate arbitrary code in your page.

### The deployed app

Bridge mode works against the cloud app: `ws://127.0.0.1` is **not** blocked as
mixed content from an `https://` page, because loopback counts as a potentially
trustworthy origin. That is verified in `smoke_modes.ts` against a real HTTPS
origin rather than assumed. Open the deployed editor with the same
`?agentBridge=…&token=…` query and it attaches.

`--url https://your-app/` also works, but headless can't get past a login — use
`--mode headful --url …`, sign in the visible window, then let the agent work.

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
pnpm test                                     # agent API unit tests
pnpm --filter @dadaki/mcp smoke               # full MCP round-trip (headless)
pnpm --filter @dadaki/mcp smoke:bridge        # bridge mode, incl. its security rules
pnpm --filter @dadaki/mcp smoke:modes <dir>   # every mode; <dir> holds cert.pem/key.pem
```

The unit tests cover the agent API against the real WASM engine. The smoke tests
cover what only exists assembled: the MCP handshake, each transport, CanvasKit
booting, and rendering.

`smoke:bridge` is the one worth reading. Bridge mode's correctness claim is that
a call lands in *somebody else's* page, so the test opens an editor itself,
attaches it, drives it over MCP, and then reads that page back **directly** —
not through MCP — to prove the edit really landed there. It also checks the
security rules hold: a second editor is refused, and a bad token gets nothing.

`smoke:modes` needs a self-signed cert to test the HTTPS case; generate one with
`openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 2 -nodes
-subj /CN=localhost`. Without it that one check is skipped, not failed.
