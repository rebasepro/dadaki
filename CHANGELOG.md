# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

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
