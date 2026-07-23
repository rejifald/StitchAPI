// Bundle-size budget gate for the `stitchapi` core entry.
//
// "Pay only for what you import" is a stated principle; this makes it an enforced
// gate. We measure the TREE-SHAKEN cost of importing from `stitchapi` — what a
// downstream bundler actually emits — minified + gzipped, and fail if any scenario
// exceeds its budget.
//
// Why re-bundle instead of `ls lib/index.mjs`? tsup code-splits shared engine code
// into chunks that several subpath entries import, so the raw entry file is only
// part of the cost and those chunks carry bytes other entries use. Re-bundling each
// scenario with esbuild + tree-shaking reproduces what a consumer's bundler ships —
// the same method bundlephobia uses. The numbers quoted in the READMEs and docs come
// from here; keep them in sync (see memory: core-zero-deps-bundle-size).
//
// Budgets are a deliberate ceiling. Raising one is a conscious act: edit the number
// below and justify it in the PR. Prefer trimming the entry, or moving a new
// capability behind its own subpath import, over bumping the budget.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

// esbuild ships as CommonJS; load it through createRequire so this stays robust
// regardless of ESM/CJS interop.
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const libDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

const KB = 1024;

// Each scenario is a real import a consumer writes. `budget` is the min+gzip ceiling.
//
// Budgets raised for 1.0.0-rc.1 (21.5→22.0 / 17.5→17.75 KB): the engine gained
// resource-safety code that lives on the core path and cannot move to a subpath —
// the caller's AbortSignal now interrupts retry/reconnect backoff and throttle waits
// (instead of sleeping out the full delay), the in-memory store opportunistically
// sweeps expired keys, and the throttle reclaims idle per-key/host state. The growth
// (~0.3 KB gzip) buys leak-freedom under long uptime and prompt cancellation; the
// headroom (~0.4 / ~0.3 KB) is deliberately kept tight so the gate stays meaningful.
//
// Budgets raised for 1.0.0-rc.2 (22.0→22.25 / 17.75→18.0 KB): the shape-only,
// BigInt-safe drift snapshot baselines and the secret-query-key registry (now exported
// for custom trace sinks) both sit on the core path; they push the entry to ~22.04 /
// ~17.78 KB gzip. The +0.25 KB step restores the same tight headroom (~0.2 KB) the
// gate is meant to keep.
//
// Budgets raised for `.inspect()` — ADR 0016 (22.25→22.65 / 18.0→18.30 KB): the
// never-throwing raw-body + drift-findings probe is baked into the core path by design
// (ADR 0016 Decision 6 — it reuses 0015's diff/findings, so it ships always, opt-in by
// call, and cannot move to a subpath). The retainRaw/bypassCache run flags, the
// `Inspection` wrapper consumer, and the contract-violation raw-pinning add ~0.19 / ~0.12
// KB gzip (entry ~22.44 / stitch ~18.12). The step restores the same tight ~0.2 KB
// headroom the gate is meant to hold.
//
// Budgets raised for adapter capabilities + the upload-progress teaching note — ADR 0005
// Decision 9 addendum (22.65→22.95 / 18.30→18.55 KB): the built-in adapters now declare a
// `capabilities` descriptor (a positive `supports` list) and the engine emits one `info`
// event when a call asks for upload progress a transport whose `supports` omits it can't
// give (turning a silent dead bar into a teaching note). Both sit on the core path — the
// check is in `execute` and the default `fetch` adapter carries the descriptor — so neither
// can move to a subpath. They add ~0.10 / ~0.04 KB gzip (entry ~22.74 / stitch ~18.34). The
// step restores the same tight ~0.2 KB headroom the gate is meant to hold.
//
// Budgets raised for core composition primitives + the API meta-contract sweep
// (22.95→23.35 / 18.55→18.80 KB): two waves of intentional, already-merged work
// landed on the core path since #362. (1) Composition gained parallel all/any/race
// with auto-cancellation (#368), linked() replacing pipe() as a run scope
// (#369/#370), and variadic argument lists (#371) — core-entry surface, so it lifts
// the whole entry more than `import { stitch }`, which tree-shakes it away. (2) The
// meta-contract sweep (#352, P3–P20) renamed/de-suffixed public fields and co-emits
// the old names as @deprecated runtime aliases (throttle.scope→pool, key→keyOf;
// value→data on result envelopes; *Ms duration de-suffixing) — shared code on
// stitch's own path. Together they reach ~23.13 / ~18.61 KB gzip (+~0.39 / +~0.27
// since #362). Neither wave can move to a subpath — composition and the renamed
// result/throttle/circuit surfaces are the core API. The step restores the same
// tight ~0.2 KB headroom the gate is meant to hold.
//
// Budgets raised for the idempotency-misuse nudges + the OTLP-name alignment (23.35→23.55 /
// 18.80→19.0 KB; measured 23.32 / 18.80). Stacking on the wave above, two more things land on the core
// path and can't move to a subpath: (1) two construction-time `idempotency` nudges in
// `makeStitch` — on a read (the key is write-only, so it's silently dropped — almost always a
// missing `method: 'POST'`) and on a random key with no `retry` (it only dedupes the call's own
// retries), both silenced by `idempotency.warn = false`; and (2) the run-identity rename to the
// OTel span names (`runId`→`spanId`, `parentId`→`parentSpanId`, CONTRACT.md P22), whose longer
// public property names are emitted verbatim on every `start` event / trace ctx and can't be
// minified. The step restores the same tight ~0.2 KB headroom the gate is meant to hold.
//
// Budgets raised for the `.inspect()` redaction option + the enhanced result object (23.55→23.95 /
// 19.0→19.45 KB; measured 23.77 / 19.25). Two more ADR-0016 deferrals land on the core path and
// can't move to a subpath — both attach to the core Stitch surface: (1) ADR 0018 adds an opt-in
// `redact` to `.inspect()` (a `redactSecretsDeep` deep-clone scrubber reusing the shared secret-key
// denylist, wired at the `.inspect()` assembly site); and (2) ADR 0019 adds `.report()` returning
// `RunReport<T>` — the `source` discriminator on `Inspection`, plus `attempts`/`timing`/`config`/
// `cache` diagnostics drained off the existing event spine (no new engine events). `.report()` is a
// method on every stitch, so it lifts `import { stitch }` as much as the whole entry — it can't
// tree-shake away. The step restores the same tight ~0.2 KB headroom the gate is meant to hold.
//
// Budgets raised for array drift summarization — ADR 0017 (23.95→24.20 / 19.45→19.70 KB; measured
// 23.99 / 19.48). `classifyDiff` swaps its first-wins `change|path` dedup for group-then-summarize:
// array groups are kept and branched on `detail` homogeneity (homogeneous → one `all N elements: …`
// summary with a concrete-index `sample`; heterogeneous → one finding per distinct detail variant).
// This fixes a real correctness gap — first-wins silently dropped a second, genuinely-different drift
// at the same collapsed `[]` path — so it isn't optional and sits in the shared drift/classify layer
// that feeds both the `drift` event and `Inspection.findings`; it can't move to a subpath. It adds
// ~0.04 / ~0.03 KB gzip. The step restores the same tight ~0.2 KB headroom the gate is meant to hold.
//
// Budgets raised for the cross-origin-redirect credential-leak fix (24.20→24.80 / 19.70→20.00 KB;
// measured 24.60 / 19.80). SECURITY (HIGH): auth strategies put credentials in CUSTOM request
// headers (`apiKey` → `x-api-key`; `awsSigV4` → `authorization` + `x-amz-*`). undici (and axios's
// follow-redirects) strip `authorization`/`cookie` on a cross-origin redirect but NOT custom
// headers, so those keys leaked to a redirect target on another origin (open-redirect / compromised
// endpoint) — a "capability, not a credential" break. The fix makes `fetchAdapter` follow redirects
// itself (`redirect: 'manual'` + a bounded manual-follow loop) and, on a cross-origin hop, drop
// every non-CORS-safelisted request header (auth/cookie/custom); `axiosAdapter` does the same via a
// `beforeRedirect` hook. Both share one tiny origin-check + header-strip helper. This sits on the
// hot request path (fetchAdapter is the default transport, so it lifts `import { stitch }` as much
// as the whole entry) and is browser-safe (no node:*), so it cannot move to a subpath. It adds ~0.43
// / ~0.28 KB gzip. The step restores the same tight ~0.2 KB headroom the gate is meant to hold. The
// cost buys closing a HIGH credential-exfiltration hole — a deliberate trade the maintainer signs off
// on by merging (see PR body for the exact before/after/Δ).
// Budgets raised for declarative auth descriptors — ADR 0020 (24.80→25.30 / 20.00→20.25; measured
// 25.07 / 20.04). `auth` now accepts an `AuthDescriptor` (`{ strategy: 'oauth2', … }`) beside the
// factory result. The RESOLUTION machinery — the five strategy factories `fromDescriptor` dispatches
// to — is deliberately kept OFF core: `auth.ts` installs the resolver into a core seam
// (`auth-registry.ts`) only when a secret resolver (`env`/`secretsFile`/`secretFrom`) runs, which a
// real descriptor's credential always does. So `import { stitch }` with no auth still tree-shakes the
// factories away entirely (that path did NOT gain the ~2.4 KB the factories weigh). What DOES lift
// both scenarios is the small, unavoidable bits on the core config-intake path, which can't move to a
// subpath: (1) `normalizeAuth` — the descriptor-vs-strategy detection + resolver routing + two
// actionable construction errors — runs in `compose` for every stitch (~0.24 KB on `import
// { stitch }`); and (2) `fromDescriptor` + the new `apiKey` `in: 'cookie'` branch, which sit on the
// whole entry. The step restores the same tight ~0.2 KB headroom the gate is meant to hold; the PR
// body carries the exact before/after/Δ.
const SCENARIOS = [
    {
        name: 'stitchapi — whole entry',
        code: `export * from './index.mjs';`,
        budget: 25.3 * KB,
    },
    {
        name: 'import { stitch }',
        code: `export { stitch } from './index.mjs';`,
        budget: 20.25 * KB,
    },
];

function measure(code) {
    const result = esbuild.buildSync({
        stdin: {
            contents: code,
            resolveDir: libDir,
            sourcefile: 'entry.mjs',
            loader: 'js',
        },
        bundle: true,
        minify: true,
        format: 'esm',
        treeShaking: true,
        platform: 'neutral',
        external: ['node:*'], // zero deps; the root entry is browser-safe
        write: false,
        logLevel: 'silent',
    });
    const out = result.outputFiles[0].contents;
    return {
        min: out.length,
        gzip: gzipSync(out, { level: 9 }).length,
        brotli: brotliCompressSync(out).length,
    };
}

const kb = (bytes) => `${(bytes / KB).toFixed(2)} KB`;

if (!existsSync(resolve(libDir, 'index.mjs'))) {
    console.error(
        '✗ lib/index.mjs not found — run `pnpm build` first (or use `pnpm size`).',
    );
    process.exit(1);
}

const rows = SCENARIOS.map((s) => {
    const m = measure(s.code);
    return { ...s, ...m, over: m.gzip > s.budget };
});

const failed = rows.some((r) => r.over);

if (process.argv.includes('--json')) {
    console.log(
        JSON.stringify(
            // `kb` is the *advertised* figure: the rounded gzip kB the READMEs/docs
            // quote (`~NN kB`). Emitting it here lets the yakir `bundle-advertised-size`
            // tether read the measured set straight from this output (it greps `"kb"`),
            // instead of re-deriving the rounding. See yakir.json.
            rows.map(({ name, min, gzip, brotli, budget, over }) => ({
                name,
                min,
                gzip,
                brotli,
                kb: Math.round(gzip / KB),
                budget,
                over,
            })),
            null,
            2,
        ),
    );
} else {
    const col = (s, w) => String(s).padStart(w);
    console.log('\n  Core bundle budget — tree-shaken, min+gzip\n');
    console.log(
        '  ' +
            'scenario'.padEnd(26) +
            col('minified', 11) +
            col('gzip', 11) +
            col('brotli', 11) +
            col('budget', 11) +
            '   status',
    );
    console.log('  ' + '─'.repeat(83));
    for (const r of rows) {
        const headroom = r.over
            ? `OVER by ${kb(r.gzip - r.budget)}`
            : `${kb(r.budget - r.gzip)} left`;
        console.log(
            '  ' +
                r.name.padEnd(26) +
                col(kb(r.min), 11) +
                col(kb(r.gzip), 11) +
                col(kb(r.brotli), 11) +
                col(kb(r.budget), 11) +
                `   ${r.over ? '✗' : '✓'} ${headroom}`,
        );
    }
    console.log('');
}

if (failed) {
    console.error(
        '✗ Bundle budget exceeded.\n' +
            '  Trim the entry, or move the new capability behind its own subpath import\n' +
            '  (like cache / graphql / sse). If the growth is genuinely necessary, raise\n' +
            '  the budget in packages/core/scripts/bundle-size.mjs and say why in the PR —\n' +
            '  the budget is the gate, so bumping it must be deliberate.\n',
    );
    process.exit(1);
}

// Keep --json output pure (it is consumed by yakir's `bundle-advertised-size`
// tether); the human-readable confirmation is only for the table view.
if (!process.argv.includes('--json')) {
    console.log('✓ Core entry within budget.\n');
}
