#!/usr/bin/env bash
# Compatibility entry point. Native target and install path belong to the Node adapter.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
npm run guardian:chatgpt:install
