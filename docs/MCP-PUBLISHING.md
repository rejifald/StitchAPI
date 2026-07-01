# Publishing the docs MCP to the registries

The hosted docs MCP (`https://stitchapi.dev/api/mcp`, tools `search_docs` +
`get_doc`) is listed in MCP registries from [`server.json`](../server.json) at the
repo root. [`.github/workflows/publish-mcp.yml`](../.github/workflows/publish-mcp.yml)
publishes it automatically.

## What the CI does

-   **Official MCP registry** (`dev.stitchapi/docs`) — published on every push to
    `main` that changes `server.json`'s `version`. This **cascades automatically**
    to **Glama** (minutes) and **PulseMCP** (~weekly) — no separate step for those.
-   **Smithery** — published in the same run (idempotent upsert), but only once you
    set `SMITHERY_API_KEY` (the step no-ops until then).
-   **PRs** that touch `server.json` run `mcp-publisher validate` only — a bad
    `server.json` is caught before merge, and nothing is published.

`mcp.so` and `cursor.directory` have no API — submit those once by hand (see the
tracking notes).

## One-time setup

### 1. Generate a signing key

macOS ships **LibreSSL**, which fails Ed25519 with `Algorithm Ed25519 not found`.
Use OpenSSL 3 (recommended), or the ECDSA fallback if you can't install it.

```bash
brew install openssl@3
OSSL="$(brew --prefix openssl@3)/bin/openssl" # arch-independent path

$OSSL genpkey -algorithm Ed25519 -out key.pem

# Private key as hex → the MCP_PRIVATE_KEY secret:
$OSSL pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n'; echo
```

<details>
<summary>No-install fallback: ECDSA P-384 (works with macOS system LibreSSL)</summary>

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:secp384r1 -out key.pem

# Private key as hex → the MCP_PRIVATE_KEY secret:
openssl ec -in key.pem -noout -text | grep -A4 "priv:" | tail -n +2 | tr -d ' :\n'; echo

# DNS TXT value (note k=ecdsap384) — use this in place of the step-2 command:
echo "v=MCPv1; k=ecdsap384; p=$(openssl ec -in key.pem -text -noout -conv_form compressed | grep -A4 "pub:" | tail -n +2 | tr -d ' :\n' | xxd -r -p | base64)"
```

</details>

### 2. Verify the domain (DNS TXT at the apex)

```bash
echo "v=MCPv1; k=ed25519; p=$($OSSL pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
```

Add that string as a **TXT record on the apex** `stitchapi.dev` — **not** under a
`_mcp`/selector subdomain (the registry only reads the apex; a selector record
fails auth). Keep the record in place permanently: CI re-verifies on every publish,
and if you rotate the key, replace the record and delete the old one (a stale apex
record is tried first and breaks auth).

> Alternative to DNS: host the same one line at
> `https://stitchapi.dev/.well-known/mcp-registry-auth` and switch the workflow's
> auth step to `login http --domain stitchapi.dev`. DNS also authorizes
> sub-namespaces; HTTP authorizes only the exact domain.

### 3. Add repo secrets

-   **`MCP_PRIVATE_KEY`** — the hex private key from step 1 (the only secret the
    registry publish needs).
-   **`SMITHERY_API_KEY`** _(optional)_ — mint with `npx -y @smithery/cli auth token`,
    then confirm the `-n <owner>/<name>` in the workflow matches your Smithery
    namespace.

## Publishing an update

The registry treats every `version` as immutable and unique, so:

1. Bump `version` in `server.json` (semver; ranges like `^1.2.3` are rejected).
   For metadata-only changes, use a prerelease bump, e.g. `1.0.0-1`.
2. Merge to `main` (or run the workflow via **Actions → Publish MCP server → Run
   workflow**).

Validate locally first with `mcp-publisher validate ./server.json`. Note
`description` is capped at **100 characters**. The registry is officially in
preview; a staging registry (`--registry https://staging.registry.modelcontextprotocol.io`)
is available for dry runs.
