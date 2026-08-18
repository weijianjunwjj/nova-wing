#!/usr/bin/env bash
set -euo pipefail

VERSION="0.2.11"
ASSET="ask-bridge-x86_64-pc-windows-msvc.zip"
URL="https://github.com/doggy8088/ask-bridge/releases/download/v${VERSION}/${ASSET}"
INSTALL_DIR="${HOME}/.local/bin"
TMP_DIR="$(mktemp -d)"
ZIP_PATH="${TMP_DIR}/${ASSET}"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

if [[ "$(uname -s)" != MINGW* && "$(uname -s)" != MSYS* && "$(uname -s)" != CYGWIN* ]]; then
  echo "This MVP installer is only for Windows Git Bash." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi

if ! command -v unzip >/dev/null 2>&1; then
  echo "unzip is required by this Git Bash installer." >&2
  exit 1
fi

echo "Downloading ask-bridge v${VERSION}..."
# GitHub release assets may transiently reset TLS connections on Windows/Git Bash.
# Retry all transport errors and force HTTP/1.1 to avoid failing the whole Guardian setup on one reset.
curl \
  -fL \
  --http1.1 \
  --retry 8 \
  --retry-all-errors \
  --retry-delay 3 \
  --connect-timeout 20 \
  --max-time 300 \
  "${URL}" \
  -o "${ZIP_PATH}"

mkdir -p "${INSTALL_DIR}"
unzip -q "${ZIP_PATH}" -d "${TMP_DIR}/extract"

EXE_PATH="$(find "${TMP_DIR}/extract" -type f -name 'ask-bridge.exe' -print -quit)"
if [[ -z "${EXE_PATH}" ]]; then
  echo "ask-bridge.exe was not found in the release archive." >&2
  exit 1
fi

cp "${EXE_PATH}" "${INSTALL_DIR}/ask-bridge.exe"
cp "${EXE_PATH}" "${INSTALL_DIR}/ask.exe"
chmod +x "${INSTALL_DIR}/ask-bridge.exe" "${INSTALL_DIR}/ask.exe"

UPDATE_PATH="$(find "${TMP_DIR}/extract" -type f -name 'ask-bridge-update.exe' -print -quit)"
if [[ -n "${UPDATE_PATH}" ]]; then
  cp "${UPDATE_PATH}" "${INSTALL_DIR}/ask-bridge-update.exe"
  chmod +x "${INSTALL_DIR}/ask-bridge-update.exe"
fi

"${INSTALL_DIR}/ask-bridge.exe" --version

echo "Installed to ${INSTALL_DIR}/ask-bridge.exe"
