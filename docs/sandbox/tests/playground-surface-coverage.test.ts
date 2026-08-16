/**
 * Playground surface COVERAGE guard.
 *
 * This is the sibling of playground-examples.test.ts, and the distinction is the
 * whole point:
 *
 *   - playground-examples.test.ts asserts every name in PLAYGROUND_SURFACE_NAMES
 *     is BOUND in the snippet scope — i.e. the declared surface actually resolves.
 *   - this file asserts the declared surface is COMPLETE — i.e. every runtime
 *     export of `stitchapi` is either bound in the playground or deliberately
 *     excluded here, with a reason.
 *
 * Nothing covered the second half, and it cost us. `stitch-browser.ts` hand-curates
 * its re-exports, so a core export that nobody remembered to add is simply absent
 * from the snippet scope — and because the scope is bound as function parameters,
 * a snippet naming it dies with `X is not defined` at runtime. That already
 * happened once: the four auth strategies were re-exported from the wrong entry,
 * resolved to nothing, and `bearer('…')` threw for anyone who copied the auth
 * guide (fixed in #545 / ADR 0021). The binding test could not catch it because
 * the name was in the list; it caught nothing because the LIST was the thing that
 * had drifted.
 *
 * An audit afterwards found ten more instances of the same class already shipped:
 * `StitchError` appeared in nine doc/blog snippets, `xhrAdapter` in five,
 * `axiosAdapter` and `fileSink` in four each — every one of them unbound. Doc
 * snippets are not executable in place, so the failure path is a reader copying a
 * snippet into /playground and hitting a ReferenceError on our own documented API.
 *
 * So: fail here when core grows an export the playground has not considered. The
 * fix is a one-line re-export in stitch-browser.ts plus a name in
 * PLAYGROUND_SURFACE_NAMES — or an entry below saying why not.
 *
 * Run with:  node --import tsx docs/sandbox/tests/playground-surface-coverage.test.ts
 */
import { PLAYGROUND_SURFACE_NAMES } from '../runtime/playground-surface';

import * as core from 'stitchapi';

/* -------------------------------------------------------------------------- */
/* Deliberate exclusions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Core exports that are intentionally NOT in the playground scope. Every entry
 * needs a reason — this map is the record of a decision, not a suppression list.
 * Adding a name here is a considered call; leaving a name out of BOTH this map
 * and PLAYGROUND_SURFACE_NAMES is the bug this file exists to catch.
 */
const INTENTIONALLY_ABSENT: Record<string, string> = {
    // Node/server-tier entry points. `cli`/`serve`/`mcp` ARE bound, but as
    // throwing stubs from shims/server-tier-stubs — they are in the names list,
    // so they do not appear here. Nothing else in core is server-tier today.
    //
    // Keep this map sorted and reasoned. Example of the shape a future entry takes:
    //   someNodeOnlyThing: 'spawns a child process — no meaningful browser shim',
};

/* -------------------------------------------------------------------------- */

const bound = new Set<string>(PLAYGROUND_SURFACE_NAMES);

// The runtime surface of the main barrel. Types vanish at runtime, so this is
// exactly the set of names a snippet could reference and expect to resolve.
// `default` is not a named binding a snippet can use.
const coreRuntimeExports = Object.keys(core)
    .filter((name) => name !== 'default')
    .sort();

const uncovered = coreRuntimeExports.filter(
    (name) => !bound.has(name) && !(name in INTENTIONALLY_ABSENT),
);

// A stale exclusion is its own small rot: it implies a decision about a name that
// no longer exists, and it would mask that name if it ever came back.
const staleExclusions = Object.keys(INTENTIONALLY_ABSENT).filter(
    (name) => !coreRuntimeExports.includes(name),
);

// A name cannot be both bound and deliberately absent — that is a contradiction
// that would quietly outlive whichever half is wrong.
const contradictory = Object.keys(INTENTIONALLY_ABSENT).filter((name) =>
    bound.has(name),
);

let failed = false;

if (uncovered.length > 0) {
    failed = true;
    console.error(
        `\n✗ ${uncovered.length} core export(s) are neither bound in the playground nor listed as deliberately absent:\n` +
            uncovered.map((n) => `    ${n}`).join('\n') +
            '\n\n  A snippet naming one of these dies with "X is not defined".\n' +
            '  Fix: re-export it from docs/sandbox/runtime/stitch-browser.ts and add it to\n' +
            '  PLAYGROUND_SURFACE_NAMES — or add it to INTENTIONALLY_ABSENT with a reason.\n',
    );
}

if (staleExclusions.length > 0) {
    failed = true;
    console.error(
        `\n✗ ${staleExclusions.length} INTENTIONALLY_ABSENT entr(ies) name exports core no longer has:\n` +
            staleExclusions.map((n) => `    ${n}`).join('\n') +
            '\n  Remove them — a stale exclusion would mask the name if it ever returns.\n',
    );
}

if (contradictory.length > 0) {
    failed = true;
    console.error(
        `\n✗ ${contradictory.length} name(s) are in BOTH PLAYGROUND_SURFACE_NAMES and INTENTIONALLY_ABSENT:\n` +
            contradictory.map((n) => `    ${n}`).join('\n') +
            '\n  Pick one — the surface is either offered or it is not.\n',
    );
}

if (failed) process.exit(1);

console.log(
    `playground surface coverage: ${coreRuntimeExports.length} core exports, ` +
        `${coreRuntimeExports.filter((n) => bound.has(n)).length} bound, ` +
        `${Object.keys(INTENTIONALLY_ABSENT).length} deliberately absent ✓`,
);
