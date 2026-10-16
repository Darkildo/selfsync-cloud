#!/usr/bin/env bash
# Ядро плагина — из тега открытого selfsync: исходники плагина (plugin/src),
# заглушка Obsidian для тестов и WASM (plugin/pkg). Всё лежит в core/, чтобы
# `npm ci && npm run build` работал без Rust и без подмодулей.
#
#   scripts/core.sh update 0.4.4   — собрать ядро из тега и заменить core/
#   scripts/core.sh check          — собрать заново из тега, записанного в
#                                    core/SOURCE, и сравнить с core/ побайтно
#
# Сборка воспроизводима: тулчейн Rust — из rust-toolchain.toml selfsync,
# wasm-bindgen — версия из его Cargo.lock, wasm-opt — версия ниже, а пути машины
# (реестр cargo, тулчейн, каталог сборки) в WASM заменяются постоянными.
set -euo pipefail

REPO=https://github.com/Darkildo/selfsync.git
# Крейт wasm-opt 0.116.1 собирает binaryen 116.
WASM_OPT_CRATE=0.116.1
WASM_OPT=116
ROOT=$(cd "$(dirname "$0")/.." && pwd)

need() {
  local have
  have=$("$1" --version 2>/dev/null | grep -o '[0-9][0-9.]*' | head -1) || true
  if [ "$have" != "$2" ]; then
    echo "нужен $1 $2 (сейчас: ${have:-нет}): cargo install $3 --version $4 --locked" >&2
    exit 1
  fi
}

# build ТЕГ КАТАЛОГ — ядро тега в каталог: plugin/src, plugin/pkg, стили, заглушка Obsidian,
# manifest.json (версия ядра), LICENSE и SOURCE (тег и коммит).
build() {
  local tag=$1 out=$2 tmp src
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$tag" "$REPO" "$tmp/selfsync"
  src=$tmp/selfsync
  local bindgen
  bindgen=$(grep -A1 '^name = "wasm-bindgen"$' "$src/Cargo.lock" | sed -n 's/^version = "\(.*\)"/\1/p')
  need wasm-bindgen "$bindgen" wasm-bindgen-cli "$bindgen"
  need wasm-opt "$WASM_OPT" wasm-opt "$WASM_OPT_CRATE"
  (
    cd "$src"
    rustup toolchain install >/dev/null 2>&1
    local sysroot cargo_home commit
    sysroot=$(rustc --print sysroot)
    commit=$(rustc -vV | sed -n 's/^commit-hash: //p')
    cargo_home=${CARGO_HOME:-$HOME/.cargo}
    # С компонентом rust-src пути std указывают на его исходники, без него — на
    # виртуальный /rustc/<коммит>: приводим к виртуальному (последнее правило главнее).
    RUSTFLAGS="--remap-path-prefix=$cargo_home/registry/src=/cargo --remap-path-prefix=$sysroot=/rust \
--remap-path-prefix=$sysroot/lib/rustlib/src/rust=/rustc/$commit --remap-path-prefix=$src=/selfsync" \
      cargo build -q --locked -p selfsync-wasm --target wasm32-unknown-unknown --profile wasm
    wasm-bindgen --target web --out-dir plugin/pkg target/wasm32-unknown-unknown/wasm/selfsync_wasm.wasm
    # Как в build-wasm.sh selfsync: общий «eslint-disable» из .d.ts wasm-bindgen не
    # пропускает ревью каталога Obsidian (core/ оно проверяет вместе с остальным).
    for f in plugin/pkg/*.d.ts; do
      grep -v -x -e '/\* tslint:disable \*/' -e '/\* eslint-disable \*/' "$f" > "$f.tmp"
      mv "$f.tmp" "$f"
    done
    # Флаги — как в scripts/build-wasm.sh selfsync.
    wasm-opt -Oz \
      --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
      --enable-mutable-globals --enable-reference-types --enable-multivalue \
      plugin/pkg/selfsync_wasm_bg.wasm -o plugin/pkg/selfsync_wasm_bg.wasm
  )
  if grep -aq -e "$HOME" -e "$tmp" "$src/plugin/pkg/selfsync_wasm_bg.wasm"; then
    echo "в WASM остались пути этой машины" >&2
    exit 1
  fi
  mkdir -p "$out/plugin/test"
  cp -r "$src/plugin/src" "$src/plugin/pkg" "$src/plugin/styles.css" "$out/plugin/"
  cp "$src/plugin/test/obsidian-stub.ts" "$out/plugin/test/"
  cp "$src/LICENSE" "$src/manifest.json" "$out/"
  printf 'selfsync %s %s\n' "$tag" "$(git -C "$src" rev-parse HEAD)" > "$out/SOURCE"
}

case ${1:-} in
update)
  tag=${2:?нужен тег selfsync, например 0.4.4}
  new=$(mktemp -d)
  build "$tag" "$new"
  rm -rf "$ROOT/core"
  mv "$new" "$ROOT/core"
  echo "core/ ← selfsync $tag"
  ;;
check)
  read -r _ tag commit < "$ROOT/core/SOURCE"
  fresh=$(mktemp -d)
  build "$tag" "$fresh"
  read -r _ _ got < "$fresh/SOURCE"
  if [ "$got" != "$commit" ]; then
    echo "тег $tag теперь указывает на $got, а core/ собран из $commit" >&2
    exit 1
  fi
  if ! diff -r "$fresh" "$ROOT/core"; then
    rm -rf "$ROOT/core-fresh"
    mv "$fresh" "$ROOT/core-fresh"
    echo "core/ не совпадает со сборкой selfsync $tag; свежая сборка — в core-fresh/" >&2
    exit 1
  fi
  rm -rf "$fresh"
  echo "core/ совпадает со сборкой selfsync $tag ($commit)"
  ;;
*)
  echo "использование: $0 update ТЕГ | check" >&2
  exit 2
  ;;
esac
