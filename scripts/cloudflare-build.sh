#!/usr/bin/env bash
# Cloudflare Pages build bootstrap.
#
# Pages runs its dashboard "build command" as a single `sh -c` line, so multi-line
# command blocks are flattened and break (`export: word unexpected`). Keep the
# dashboard command as `bash scripts/cloudflare-build.sh` and change this file.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    sh -s -- -y --profile minimal --default-toolchain stable --target wasm32-unknown-unknown
fi

if command -v rustup >/dev/null 2>&1; then
  rustup target add wasm32-unknown-unknown
fi

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  cargo install wasm-bindgen-cli --version 0.2.130 --locked
fi

pnpm install --frozen-lockfile
pnpm build
