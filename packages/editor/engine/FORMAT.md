# The `.dadaki` file format

Version 8. This document is the normative description of the on-disk format —
enough to write an independent reader or writer without reading the editor's
source.

## 1. Container

A `.dadaki` file is a fixed 26-byte header followed by a payload. All integers
are **little-endian**.

| Offset | Size | Field                | Notes                                        |
| -----: | ---: | -------------------- | -------------------------------------------- |
|      0 |    6 | `magic`              | ASCII `DADAKI`                               |
|      6 |    2 | `container_version`  | u16. Currently `1`. Refuse if higher.        |
|      8 |    2 | `flags`              | u16 bitfield. Bit 0: payload is raw-deflate. |
|     10 |    4 | `min_reader_version` | u32. See §2.                                 |
|     14 |    4 | `payload_len`        | u32. Bytes of payload **as stored**.         |
|     18 |    4 | `uncompressed_len`   | u32. Payload size after inflate.             |
|     22 |    4 | `crc32`              | u32 over the **stored** payload bytes.       |
|     26 |    … | `payload`            | A `Document` protobuf message (§3).          |

Compression uses raw DEFLATE (RFC 1951, no zlib or gzip wrapper). A writer
should skip compression when the payload is under ~512 bytes or when the
deflated form is not smaller — already-compressed content such as embedded PNGs
can expand.

### Reading

Perform the checks in this order. The order matters: a future container layout
may move every field after offset 8, so parsing further would be reading noise,
and a length or CRC "mismatch" derived from noise sends the user chasing
corruption that isn't there.

1. `magic` absent → treat the whole file as a bare `Document` message (§5).
2. `container_version > 1` → refuse: written by a newer generation.
3. `min_reader_version > your FORMAT_VERSION` → refuse (§2).
4. Fewer than `payload_len` bytes after the header → refuse: truncated.
5. `crc32` mismatch → refuse: corrupt.
6. Inflate if bit 0 is set; refuse if the result is not `uncompressed_len` bytes.

An **empty file must be an error**, never an empty document. The empty byte
string is a valid protobuf message, so treating it as one turns an interrupted
save into a blank canvas that then overwrites the original.

Trailing bytes beyond `payload_len` are ignored.

## 2. `min_reader_version` — the compatibility contract

This is the single most important field, and it is **not** the writer's version.
It is *the oldest reader that can open this particular document without losing
anything*, computed from the features the document actually uses.

A reader whose own format version is lower **must refuse to open the file.**

The reason is that protobuf readers drop unknown fields. An old reader
physically cannot preserve what it does not understand, so if it opens a newer
document it will silently discard part of it and write the truncated version
back on the next save. Under last-writer-wins sync, that destroys the document
for every collaborator, not just locally. Refusing is the only way to protect
the data.

The floor is content-dependent so that the format stays permissive by default:

| Floor | Raised by                                                            |
| ----: | -------------------------------------------------------------------- |
|     2 | baseline — paths, rectangles, ellipses, text, solid fills, gradients  |
|     3 | a path carrying a vector network                                      |
|     4 | Live Paint face fills                                                 |
|     5 | a node with more than one stroke                                      |
|     6 | face-fill signatures, gap bridging, or painted edges                  |
|     7 | a mesh gradient paint                                                 |
|     8 | embedded fonts                                                        |
|   `n` | any `geometry` or `paint` whose `oneof` is unset (an unknown variant)  |

A document of plain paths and solid fills therefore stays openable by any build
indefinitely. Only documents genuinely using newer features lock themselves to
newer readers.

**When adding a feature**, raise the floor only if losing that feature would
visibly damage the artwork. Losing a mesh gradient changes a shape's colour, so
it counts. Losing the document title does not, and treating it as though it did
would lock every document to the newest build for no benefit.

## 3. Payload schema

The payload is a protobuf message. The full field-by-field schema is the prost
definition in [`src/proto.rs`](src/proto.rs); this section covers what a third
party needs to know beyond reading it.

Top-level `Document` fields of note:

- `format_version` (1) — informational. **Do not** use it for compatibility
  decisions; `min_reader_version` in the container is the contract.
- `nodes` (2) — flat list. Hierarchy is expressed by `children`, not nesting.
- `root_ids` (3) — top-level nodes, in paint order (first = bottom).
- `images` (9) — encoded raster bytes, referenced by `image_id`.
- `meta` (20) — uuid, created/modified timestamps (Unix epoch ms), authoring app
  version, title.
- `fonts` (21) — embedded faces, keyed by family + weight + italic.
- `swatches` (22), `text_paths` (23), `markers` (24), `guide_locks` (25) — typed
  replacements for the deprecated JSON-string fields at tags 16–19.

`geometry` and `paint` are real protobuf `oneof`s. An **unset** oneof means the
variant was written by a newer build; it is not a valid document in its own
right, and `min_reader_version` will already have caused such a file to be
refused.

### Deprecated fields

Tags 16–19 (`swatches_json`, `text_paths_json`, `markers_json`,
`guide_locks_json`) hold the same data as tags 22–25 as opaque JSON strings.
v8 writers emit **both**, so that v7 readers lose nothing. Readers must prefer
the typed fields and fall back to the JSON only when the typed field is empty.
The JSON fields will be dropped once v7 is retired; new readers should not rely
on them.

## 4. Structural validity

A file can be well-formed protobuf and still describe an incoherent scene. A
reader must not assume any of the following and must not crash on their absence:

- `root_ids` and `children` may reference ids that are not present.
- The node graph may contain **cycles**, including self-references. A naive
  recursive walk over `children` will not terminate.
- A node's `parent` may disagree with the group listing it in `children`.
  `children` is authoritative.
- Nodes may be reachable from no root.
- Coordinates may be NaN or infinite.
- `image_id` may reference bytes absent from `images`.

This implementation repairs all of these on load rather than rejecting the file
(see `src/validate.rs`), reports what it changed, and never deletes a node —
unreachable ones are re-homed to the top level. Repair is idempotent.

Coordinates are `f32` and clamped to ±1e6 (`MAX_COORD`). Beyond that, the gap
between representable values exceeds 1/16 unit and editing operations start to
silently no-op. Group nesting is bounded at 1024 deep.

## 5. Legacy files

Files without the `DADAKI` magic are bare `Document` protobuf, as written before
v8. They are still readable. A bare document's effective `min_reader_version` is
unknown, so it is read without a version check — acceptable because no build
that wrote one is newer than this reader.

A legacy file is upgraded to the enveloped form on the next save.

## 6. Undo snapshots are not this format

`serialize_snapshot` produces a `Snapshot` message (a `Document` plus the
selection) with **no envelope and no compression**. These are in-memory only.
They are produced on every mutation and compared byte-for-byte to coalesce undo
history, so compressing them would cost time on every edit and put a checksum in
the comparison path.

This is why nothing in serialization may invent a value. A timestamp or uuid
generated during `from_scene` would make two snapshots of an unchanged scene
differ and silently break undo coalescing. Document identity is assigned by the
editor and stored on the scene; the same requirement applies to any future field.

## 7. Changing the format

1. **Never renumber or reuse a tag.** Add new tags; mark old ones deprecated.
2. Decide whether the feature raises `min_reader_version` (§2) and add it to
   `required_reader_version` if so.
3. Add a round-trip test, and a case to the version-floor test.
4. Bump `FORMAT_VERSION`. Bump `CONTAINER_VERSION` only if the *header* changes.
5. Confirm `serialize→deserialize→serialize` is still byte-exact — the undo
   fixed point in `format_tests.rs` will catch it if not.
