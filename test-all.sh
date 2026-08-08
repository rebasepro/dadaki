#!/bin/sh
# Run the full test suite: Rust engine (incl. transform invariants) + JS.
# Standalone script because `npm run`/`pnpm` are blocked in this repo
# (devEngines pin) and the rustup toolchain is not on PATH.
set -e
cd "$(dirname "$0")"

export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"

echo "── engine tests (cargo) ──────────────────────────────"
cargo test --manifest-path packages/editor/engine/Cargo.toml

echo "── typecheck (tsc, per package) ──────────────────────"
# One tsconfig per workspace package; there is no root program to check.
for pkg in editor app mcp; do
    echo "  packages/$pkg"
    ./node_modules/.bin/tsc --noEmit -p "packages/$pkg"
done

echo "── JS tests (vitest) ─────────────────────────────────"
./node_modules/.bin/vitest run
