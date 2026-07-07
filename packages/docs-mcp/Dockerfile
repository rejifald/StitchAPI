# @stitchapi/docs-mcp — StitchAPI documentation search over MCP stdio, fully
# local. This Dockerfile builds from the monorepo (not from an npm install), so
# a CI checker (e.g. Glama's Dockerfile+introspection catalog check) exercises
# the same content pipeline the hosted stitchapi.dev/api/mcp server uses.
#
# The build stage is heavier than a typical single-package Docker build: this
# package's data/ is copied in from apps/docs's own build:mcp-bundle output
# (see scripts/copy-bundle.mjs), and that pipeline needs several sibling
# @stitchapi/* packages built first (fumadocs' MDX rendering depends on them —
# see apps/docs/package.json build:typed-deps). That's inherent to reusing the
# real pipeline rather than re-deriving the docs chunking/embedding here a
# second time — see README.md "Keeping docs fresh".
#
# Build (from repo root):  docker build -f packages/docs-mcp/Dockerfile -t stitchapi-docs-mcp .
# Run:                     docker run -i stitchapi-docs-mcp

FROM node:24-slim AS builder
WORKDIR /repo

RUN corepack enable

# Workspace manifests first for layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/docs ./apps/docs
COPY docs/sandbox ./docs/sandbox

# pnpm-workspace.yaml declares packages/*, apps/*, and docs/sandbox — all three
# must be present for `--frozen-lockfile` to resolve against the committed
# lockfile, even though docs/sandbox itself isn't part of this build.
RUN pnpm install --frozen-lockfile

RUN pnpm --filter @stitchapi/docs-mcp build

# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app

COPY --from=builder /repo/packages/docs-mcp/package.json ./
COPY --from=builder /repo/packages/docs-mcp/lib ./lib
COPY --from=builder /repo/packages/docs-mcp/bin ./bin
COPY --from=builder /repo/packages/docs-mcp/data ./data

# Plain `npm install` (not pnpm) works here because none of this package's
# dependencies use the `workspace:` protocol — it's installable standalone,
# same as any npm package.
RUN npm install --omit=dev

ENTRYPOINT ["node", "bin/docs-mcp"]
