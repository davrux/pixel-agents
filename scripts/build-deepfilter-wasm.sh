#!/usr/bin/env bash
# Build DeepFilterNet's WebAssembly runtime for the desktop Mumble client's
# noise filter, from upstream SOURCE at a pinned commit, inside a pinned Docker
# image — so the binary we ship is one we compiled, not one a CDN handed us.
#
# Usage: scripts/build-deepfilter-wasm.sh
#
# Writes (both committed — the build needs Docker and ~10 minutes, and the
# desktop CI runs on three OSes that have neither):
#   client/public/deepfilter/df_bg.wasm   the runtime (tract + DSP, no model)
#   client/public/deepfilter/df.js        wasm-bindgen's glue, prepended to the
#                                         filter's worklet (voice/deepFilter.ts)
# The MODEL is not built here: it is fetched at build time and checked against a
# pinned hash by scripts/vendor-deepfilter.mjs (`pnpm vendor:deepfilter`).
#
# One patch to upstream: the `wasm` feature pulls in `default-model`, which
# embeds the 8 MB model in the binary with include_bytes! — but df_create()
# takes the model as an argument and never reads the embedded copy. Dropping it
# from the feature list is what keeps the .wasm small.
#
# Re-run only to move to another upstream commit; bump DF_COMMIT and the
# wasm-bindgen version together (the CLI must equal the crate in Cargo.lock).
set -euo pipefail

DF_REPO=https://github.com/Rikorose/DeepFilterNet.git
DF_COMMIT=d375b2d8309e0935d165700c91da9de862a99c31
WASM_BINDGEN=0.2.92
IMAGE=rust:1.98-slim-trixie

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone -q "$DF_REPO" "$WORK/src"
git -C "$WORK/src" checkout -q "$DF_COMMIT"
sed -i '/^wasm = \[/,/^\]/{/"default-model",/d}' "$WORK/src/libDF/Cargo.toml"
grep -q '"dep:wasm-bindgen"' "$WORK/src/libDF/Cargo.toml" # the feature is still there
! sed -n '/^wasm = \[/,/^\]/p' "$WORK/src/libDF/Cargo.toml" | grep -q default-model

mkdir -p "$WORK/out"
# The source is mounted read-only and built from a copy inside the container,
# so nothing root-owned is left on the host; only /out is written, then chowned.
docker run --rm \
  -v "$WORK/src:/src:ro" -v "$WORK/out:/out" \
  "$IMAGE" bash -euc "
    cp -r /src /build && cd /build
    rustup target add wasm32-unknown-unknown
    cargo install --locked wasm-bindgen-cli --version $WASM_BINDGEN
    # Not --locked: upstream's Cargo.lock at this commit is stale against its own
    # manifests, so cargo has to touch it. It still starts from that lock and
    # moves only what it must.
    cargo build --release -p deep_filter \
      --target wasm32-unknown-unknown --no-default-features --features wasm
    wasm-bindgen --target no-modules --no-typescript \
      --remove-name-section --remove-producers-section \
      --out-dir /out --out-name df target/wasm32-unknown-unknown/release/df.wasm
    chown -R $(id -u):$(id -g) /out
  "

mkdir -p "$ROOT/client/public/deepfilter"
cp "$WORK/out/df_bg.wasm" "$ROOT/client/public/deepfilter/df_bg.wasm"
cp "$WORK/out/df.js" "$ROOT/client/public/deepfilter/df.js"
cp "$WORK/src/LICENSE-MIT" "$WORK/src/LICENSE-APACHE" "$ROOT/client/public/deepfilter/"
ls -l "$ROOT/client/public/deepfilter/df_bg.wasm" "$ROOT/client/public/deepfilter/df.js"
