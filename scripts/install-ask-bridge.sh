#!/usr/bin/env bash
set -euo pipefail

VERSION="0.2.13"
SOURCE_URL="https://github.com/doggy8088/ask-bridge.git"
INSTALL_DIR="${HOME}/.local/bin"
TMP_DIR="$(mktemp -d)"
SOURCE_DIR="${TMP_DIR}/ask-bridge"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PATCH_PATH="${SCRIPT_DIR}/../patches/ask-bridge-v0.2.13-composer-state.patch"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

if [[ "$(uname -s)" != MINGW* && "$(uname -s)" != MSYS* && "$(uname -s)" != CYGWIN* ]]; then
  echo "This MVP installer is only for Windows Git Bash." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to build the pinned AskBridge patch." >&2
  exit 1
fi

if [[ ! -f "${PATCH_PATH}" ]]; then
  echo "Pinned AskBridge patch is missing: ${PATCH_PATH}" >&2
  exit 1
fi

echo "Building patched ask-bridge v${VERSION}..."
git clone --quiet --depth 1 --branch "v${VERSION}" "${SOURCE_URL}" "${SOURCE_DIR}"
git -C "${SOURCE_DIR}" apply --check "${PATCH_PATH}"
git -C "${SOURCE_DIR}" apply "${PATCH_PATH}"
cargo test --locked --manifest-path "${SOURCE_DIR}/Cargo.toml"
cargo build --locked --release --manifest-path "${SOURCE_DIR}/Cargo.toml" --bin ask-bridge

EXE_PATH="${SOURCE_DIR}/target/release/ask-bridge.exe"
if [[ ! -f "${EXE_PATH}" ]]; then
  echo "Patched ask-bridge.exe was not produced." >&2
  exit 1
fi

mkdir -p "${INSTALL_DIR}"
cp "${EXE_PATH}" "${INSTALL_DIR}/ask-bridge.exe"
cp "${EXE_PATH}" "${INSTALL_DIR}/ask.exe"
chmod +x "${INSTALL_DIR}/ask-bridge.exe" "${INSTALL_DIR}/ask.exe"

"${INSTALL_DIR}/ask-bridge.exe" --version
"${INSTALL_DIR}/ask-bridge.exe" --help | grep -q -- '--operation-id'

echo "Installed to ${INSTALL_DIR}/ask-bridge.exe"
