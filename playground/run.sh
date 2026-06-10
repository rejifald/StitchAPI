#!/usr/bin/env bash
# Run the live playground. Uses ts-node (transpile-only, commonjs) so the TS library
# loads without a build step.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node_modules/.bin/ts-node --transpile-only \
  -O '{"module":"commonjs","moduleResolution":"node"}' \
  playground/server.ts
