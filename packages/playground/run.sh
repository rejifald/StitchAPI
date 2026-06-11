#!/usr/bin/env bash
# Run the live playground against core source (no build step) via tsx.
# Equivalent to: pnpm --filter @stitchapi/playground dev
set -euo pipefail
cd "$(dirname "$0")"
exec pnpm exec tsx server.ts
