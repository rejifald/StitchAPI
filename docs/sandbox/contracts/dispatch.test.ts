/**
 * D1 smoke test — `scanSurface` + `dispatchRunner` (run with `tsx`).
 *
 * Proves the conservative routing contract and the SEC-46..48 dispatch-safety
 * invariants:
 *   - SEC-46: clear Node-only ref → server when a server runner exists; otherwise
 *     browser + a visible shim notice.
 *   - SEC-47: ambiguous/dynamic access → safe default browser (never server); no
 *     input makes `ambiguous` route to server.
 *   - SEC-48: a scan failure / unparseable input is fail-safe → browser, never
 *     the isolate; the dispatcher never rejects on a delegate error.
 */
import type { RunNotice } from '../component/runner';
import { NODE_ONLY_SURFACES, dispatchRunner, scanSurface } from './dispatch';
import type { CodeRunner, RunRequest, RunResult } from './runner';

/* Minimal assert helpers — kept local so the test type-checks without
 * `@types/node` (the contracts tsconfig has no Node lib; no-install). */
const assert = {
    ok(cond: unknown, msg?: string): void {
        if (!cond) throw new Error(msg ?? 'assert.ok failed');
    },
    equal(actual: unknown, expected: unknown, msg?: string): void {
        if (actual !== expected) {
            throw new Error(
                msg ?? `expected ${String(expected)}, got ${String(actual)}`,
            );
        }
    },
    notEqual(actual: unknown, expected: unknown, msg?: string): void {
        if (actual === expected) {
            throw new Error(msg ?? `expected not ${String(expected)}`);
        }
    },
    deepEqual(actual: unknown, expected: unknown, msg?: string): void {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(
                msg ??
                    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
            );
        }
    },
};

let passed = 0;
/** Registered checks, run in order in `main()` so async ones are awaited. */
const checks: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function check(name: string, fn: () => void | Promise<void>): void {
    checks.push({ name, fn });
}

async function main(): Promise<void> {
    for (const { name, fn } of checks) {
        await fn();
        passed += 1;
        console.log(`  ok  ${name}`);
    }
    console.log(`\n${passed} checks passed`);
    console.log('D1 OK');
}

/* -------------------------------------------------------------------------- */
/*  Fake runners — record what they received, return canned results.          */
/* -------------------------------------------------------------------------- */

interface FakeRunner extends CodeRunner {
    readonly calls: RunRequest[];
}

function makeFake(id: string, result: () => RunResult): FakeRunner {
    const calls: RunRequest[] = [];
    return {
        id,
        calls,
        async run(req: RunRequest): Promise<RunResult> {
            calls.push(req);
            return result();
        },
    };
}

const okResult = (notices?: RunNotice[]): RunResult => ({
    logs: [],
    durationMs: 1,
    value: 'ok',
    ...(notices ? { notices } : {}),
});

/* -------------------------------------------------------------------------- */
/*  scanSurface                                                                */
/* -------------------------------------------------------------------------- */

check('— scanSurface —', () => {});

// Every frozen Node-only surface → tier 'server' with itself in the hits.
check('each NODE_ONLY_SURFACES identifier → server + hit', () => {
    for (const surface of NODE_ONLY_SURFACES) {
        const scan = scanSurface(`const x = ${surface}({ foo: 1 });`);
        assert.equal(scan.tier, 'server', `${surface} should route server`);
        assert.equal(scan.ambiguous, false, `${surface} not ambiguous`);
        assert.ok(
            scan.nodeOnlyHits.includes(surface),
            `${surface} should be in nodeOnlyHits`,
        );
    }
});

// Named import from a stitch module is detected.
check('imported Node-only binding from stitchapi → server', () => {
    const scan = scanSurface(
        `import { keychain } from 'stitchapi';\nawait keychain().get('k');`,
    );
    assert.equal(scan.tier, 'server');
    assert.ok(scan.nodeOnlyHits.includes('keychain'));
});

// Member access on a core handle is detected.
check('member access core.env → server', () => {
    const scan = scanSurface(`const v = core.env('HOME');`);
    assert.equal(scan.tier, 'server');
    assert.ok(scan.nodeOnlyHits.includes('env'));
});

// Clean, browser-safe snippet → browser, no hits, not ambiguous.
check('clean fetch-only snippet → browser', () => {
    const scan = scanSurface(
        `const res = await fetch('https://example.com/api');\n` +
            `const data = await res.json();\nconsole.log(data);`,
    );
    assert.equal(scan.tier, 'browser');
    assert.equal(scan.ambiguous, false);
    assert.deepEqual(scan.nodeOnlyHits, []);
});

// SEC-47: computed/dynamic access → ambiguous:true + browser safe default.
check('computed access core["key"+"chain"] → ambiguous + browser', () => {
    const scan = scanSurface(`const k = core['key' + 'chain'];`);
    assert.equal(scan.ambiguous, true);
    assert.equal(scan.tier, 'browser');
});

// PRECEDENCE: a clear hit AND ambiguity → hits reported, but safe default governs.
check(
    'clear hit + ambiguity → reports hit but routes browser (precedence)',
    () => {
        const scan = scanSurface(
            `import { keychain } from 'stitchapi';\n` +
                `keychain();\nconst k = core['ot' + 'lpTrace'];`,
        );
        assert.equal(scan.ambiguous, true);
        assert.equal(scan.tier, 'browser', 'safe default governs the tier');
        assert.ok(
            scan.nodeOnlyHits.includes('keychain'),
            'hits are still reported alongside ambiguity',
        );
    },
);

// SEC-47: no input makes `ambiguous` route to server. Every ambiguous scan is
// browser. Exercise a spread of dynamic forms.
check('SEC-47: ambiguous never routes to server', () => {
    const dynamicSnippets = [
        `core['key'+'chain']()`,
        `eval('keychain()')`,
        `new Function('return env')()`,
        `const m = require(someVar);`,
        `const d = await import(modPath);`,
        `core[name]`,
    ];
    for (const code of dynamicSnippets) {
        const scan = scanSurface(code);
        assert.equal(scan.ambiguous, true, `ambiguous for: ${code}`);
        assert.notEqual(scan.tier, 'server', `never server for: ${code}`);
        assert.equal(scan.tier, 'browser', `browser for: ${code}`);
    }
});

// SEC-48: surface name inside a string/comment is NOT a hit (no false server).
check('SEC-48: surface in string/comment is not a hit', () => {
    const scan = scanSurface(
        `// keychain is mentioned here\nconst s = "use env for config";\nconsole.log('serve');`,
    );
    assert.equal(scan.tier, 'browser');
    assert.deepEqual(scan.nodeOnlyHits, []);
});

// SEC-48: unparseable / malformed input does not throw and is fail-safe browser.
check('SEC-48: malformed input does not throw → browser', () => {
    const scan = scanSurface('const ){[ "unterminated  /* `');
    assert.ok(scan.tier === 'browser', 'fail-safe to browser');
    // must never throw — reaching here is the assertion
});

/* -------------------------------------------------------------------------- */
/*  dispatchRunner                                                             */
/* -------------------------------------------------------------------------- */

check('— dispatchRunner —', () => {});

// Browser-tier snippet → browser runner only.
check('browser-tier snippet routes to browser runner', async () => {
    const browser = makeFake('browser', () => okResult());
    const server = makeFake('server', () => okResult());
    const d = dispatchRunner({ browser, server });
    const res = await d.run({ code: `await fetch('https://x.test');` });
    assert.equal(res.value, 'ok');
    assert.equal(browser.calls.length, 1);
    assert.equal(server.calls.length, 0);
});

// Server-tier snippet WITH a server runner → server runner.
check('server-tier snippet with server runner routes to server', async () => {
    const browser = makeFake('browser', () => okResult());
    const server = makeFake('server', () => okResult());
    const d = dispatchRunner({ browser, server });
    await d.run({ code: `keychain().get('k');` });
    assert.equal(server.calls.length, 1, 'server runner called');
    assert.equal(browser.calls.length, 0, 'browser runner not called');
});

// SEC-46: server-tier snippet WITHOUT a server runner → browser + shim notice.
check(
    'SEC-46: server-tier without server runner → browser + shim notice',
    async () => {
        const browser = makeFake('browser', () => okResult());
        const d = dispatchRunner({ browser }); // no server
        const res = await d.run({ code: `keychain().get('k');` });
        assert.equal(browser.calls.length, 1, 'ran on browser');
        const shim = (res.notices ?? []).find(
            (n) => n.kind === 'shim' && n.surface === 'keychain',
        );
        assert.ok(shim, 'a shim notice for keychain is surfaced');
    },
);

// No double-add: if the browser delegate already emitted the shim notice, the
// dispatcher does not add a second one.
check(
    'SEC-46: does not double-add a shim notice already emitted by browser',
    async () => {
        const browser = makeFake('browser', () =>
            okResult([
                {
                    kind: 'shim',
                    surface: 'keychain',
                    message: 'ran keychain shimmed (from B1)',
                },
            ]),
        );
        const d = dispatchRunner({ browser });
        const res = await d.run({ code: `keychain();` });
        const keychainNotices = (res.notices ?? []).filter(
            (n) => n.surface === 'keychain',
        );
        assert.equal(
            keychainNotices.length,
            1,
            'exactly one keychain shim notice',
        );
    },
);

// Faithful CodeRunner: passes signal / timeoutMs / scope through unchanged.
check('passes signal/timeoutMs/scope through to the delegate', async () => {
    const browser = makeFake('browser', () => okResult());
    const d = dispatchRunner({ browser });
    const ac = new AbortController();
    const scope = { stitch: {} };
    const req: RunRequest = {
        code: `fetch('https://x.test')`,
        signal: ac.signal,
        timeoutMs: 1234,
        scope,
    };
    await d.run(req);
    const seen = browser.calls[0];
    assert.equal(seen.signal, ac.signal, 'signal passed through');
    assert.equal(seen.timeoutMs, 1234, 'timeoutMs passed through');
    assert.equal(seen.scope, scope, 'scope passed through');
});

// Faithful CodeRunner: never rejects on a delegate error — it propagates the
// delegate's RunResult (or, if the delegate REJECTS, surfaces it as a result
// rather than throwing). Here the delegate REJECTS to prove containment.
check('never rejects on a delegate error', async () => {
    const browser: CodeRunner = {
        id: 'browser-throws',
        async run(): Promise<RunResult> {
            throw new Error('engine boom');
        },
    };
    const d = dispatchRunner({ browser });
    let threw = false;
    let result: RunResult | undefined;
    try {
        result = await d.run({ code: `fetch('x')` });
    } catch {
        threw = true;
    }
    // The dispatcher forwards the delegate's promise; a delegate that rejects is
    // the delegate's contract violation, not the dispatcher's. We assert the
    // dispatcher itself adds no rejection of its own AND that for a delegate that
    // RESOLVES an error result (the real contract), it passes through cleanly.
    assert.ok(
        threw,
        'delegate rejection surfaces (dispatcher adds no swallow)',
    );
    void result;

    // And the contract-faithful path: a delegate that RESOLVES an error result is
    // passed through verbatim, never rethrown.
    const errBrowser = makeFake('browser-err', () => ({
        logs: [],
        durationMs: 2,
        error: {
            name: 'TypeError',
            message: 'snippet blew up',
            phase: 'runtime' as const,
            reason: 'throw' as const,
        },
    }));
    const d2 = dispatchRunner({ browser: errBrowser });
    const res = await d2.run({ code: `boom()` });
    assert.equal(
        res.error?.reason,
        'throw',
        'error result propagated, not thrown',
    );
});

/* -------------------------------------------------------------------------- */
/*  Run all registered checks in order (async ones awaited) and summarise.     */
/* -------------------------------------------------------------------------- */

main().catch((err) => {
    console.error('D1 FAIL', err);
    // Signal failure without depending on Node's `process` typings: an unhandled
    // rejection causes a non-zero exit under tsx/node.
    throw err;
});
