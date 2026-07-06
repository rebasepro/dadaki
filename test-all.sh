#!/bin/sh
# Run the full test suite: Rust engine (incl. transform invariants) + JS.
# Standalone script because `npm run`/`pnpm` are blocked in this repo
# (devEngines pin) and the rustup toolchain is not on PATH.
set -e
cd "$(dirname "$0")"

export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"

echo "── engine tests (cargo) ──────────────────────────────"
cargo test --manifest-path engine/Cargo.toml

echo "── typecheck + JS tests (vitest) ─────────────────────"
./node_modules/.bin/vitest run
