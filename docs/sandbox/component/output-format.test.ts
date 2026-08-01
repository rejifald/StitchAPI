/**
 * output-format.test.ts — tsx smoke tests for the pure output-format helpers.
 *
 * Run with: npx -y tsx docs/sandbox/component/output-format.test.ts
 * Expected: prints "U1 OK" and exits 0.
 *
 * Uses node:assert (strict). No test framework required.
 */
import {
    applyEvent,
    buildRunView,
    emptyRunView,
    formatLog,
    formatValue,
    summarizeNotices,
    traceToMermaid,
} from './output-format';
import type {
    RunEvent,
    RunNotice,
    RunResult,
    StitchTraceEntry,
} from './runner';

import assert from 'node:assert/strict';

/* -------------------------------------------------------------------------- */
/*  traceToMermaid                                                             */
/* -------------------------------------------------------------------------- */

// Empty trace → safe placeholder, not an error.
{
    const result = traceToMermaid([]);
    assert.ok(
        result.startsWith('flowchart TD'),
        'empty trace: must start with flowchart TD',
    );
    assert.ok(
        result.includes('_empty'),
        'empty trace: must include placeholder node',
    );
}

// Single node with no edges. Label is method + path, NOT the name.
{
    const trace: StitchTraceEntry[] = [
        {
            id: 's1',
            label: 'getUser',
            request: { method: 'GET', url: 'https://example.com/users/1' },
            response: { status: 200, ok: true, durationMs: 80 },
        },
    ];
    const result = traceToMermaid(trace);
    assert.ok(result.includes('s1'), 'single node: id must appear');
    assert.ok(
        result.includes('GET /users/1'),
        'single node: label is method + path',
    );
    assert.ok(
        !result.includes('getUser'),
        'single node: name not used as label when a url is present',
    );
    // No edges when there are no dependsOn.
    assert.ok(!result.includes('-->'), 'single node: no edges expected');
}

// Full-URL request → label is METHOD + pathname (host stripped).
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'u2',
            label: 'demo-api',
            request: {
                method: 'GET',
                url: 'https://api.example.com/users/2',
            },
            response: { status: 200, ok: true, durationMs: 70 },
        },
    ];
    const result = traceToMermaid(trace);
    // Assert the EXTRACTED label, not a substring of the whole document. Exact equality
    // proves both facts at once — the label is `METHOD + pathname`, and no host survived
    // into it — where a `!includes(host)` pair proved the second only weakly. It also
    // avoids substring-matching a hostname, which CodeQL flags as incomplete URL
    // sanitization (`js/incomplete-url-substring-sanitization`): a fair complaint about
    // the shape, since a host can appear anywhere in a URL.
    const label = /u2\["([^"]*)"\]/.exec(result)?.[1];
    assert.equal(
        label,
        'GET /users/2',
        'full url: label is METHOD + pathname, host stripped',
    );
}

// Bare-path request url → used as-is (new URL() would throw, so we fall back).
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'u3',
            label: 'demo-api',
            request: { method: 'GET', url: '/users' },
            response: { status: 200, ok: true, durationMs: 30 },
        },
    ];
    const result = traceToMermaid(trace);
    assert.ok(
        result.includes('u3["GET /users"]'),
        'bare path: node labelled GET /users',
    );
}

// Sibling stitches sharing a name still get distinct labels via method + path.
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'getUserById',
            label: 'demo-api',
            request: {
                method: 'GET',
                url: 'https://api.example.com/users/1',
            },
        },
        {
            id: 'listUsers',
            label: 'demo-api',
            request: { method: 'GET', url: 'https://api.example.com/users' },
        },
        {
            id: 'authMe',
            label: 'demo-api',
            request: {
                method: 'GET',
                url: 'https://api.example.com/auth/me',
            },
        },
    ];
    const result = traceToMermaid(trace);
    assert.ok(
        result.includes('GET /users/1') &&
            result.includes('GET /users') &&
            result.includes('GET /auth/me'),
        'shared name: each node labelled by its own method + path',
    );
}

// Path-with-query → search string is preserved in the label.
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'q1',
            request: {
                method: 'GET',
                url: 'https://example.com/search?q=cat',
            },
        },
    ];
    const result = traceToMermaid(trace);
    assert.ok(
        result.includes('GET /search?q=cat'),
        'query string: search preserved in path label',
    );
}

// No request → label falls back to entry.label, then entry.id.
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'no-req',
            label: 'composedStep',
        } as StitchTraceEntry,
    ];
    const result = traceToMermaid(trace);
    assert.ok(
        result.includes('composedStep'),
        'no request: falls back to entry.label',
    );
}

// Stream marker + dependsOn edge survive the method+path labeling.
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'fetch-token',
            label: 'auth',
            request: { method: 'POST', url: 'https://example.com/token' },
        },
        {
            id: 'chat',
            label: 'chatStream',
            request: { method: 'POST', url: 'https://example.com/chat' },
            stream: { chunks: 9 },
            dependsOn: ['fetch-token'],
        },
    ];
    const result = traceToMermaid(trace);
    assert.ok(
        result.includes('POST /token'),
        'stream+edge: parent labelled by method + path',
    );
    assert.ok(
        result.includes('POST /chat ⟳9'),
        'stream+edge: child labelled by method + path with stream marker',
    );
    assert.ok(
        result.includes('fetch_token --> chat'),
        'stream+edge: dependsOn edge still emitted',
    );
}

// Retry attempts (ADR 0007) → node annotated with ↻N (collector sets it only > 1).
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'flaky',
            label: 'demo-api',
            request: { method: 'GET', url: 'https://example.com/users' },
            response: { status: 200, ok: true, durationMs: 120 },
            attempts: 3,
        },
    ];
    const result = traceToMermaid(trace);
    assert.ok(
        result.includes('GET /users ↻3'),
        'attempts: node annotated with ↻3 retry marker',
    );
}

// Paginate pages (ADR 0007) → node annotated with ⊞N.
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'list',
            label: 'demo-api',
            request: { method: 'GET', url: 'https://example.com/users' },
            response: { status: 200, ok: true, durationMs: 200 },
            pages: 4,
        },
    ];
    const result = traceToMermaid(trace);
    assert.ok(
        result.includes('GET /users ⊞4'),
        'pages: node annotated with ⊞4 page marker',
    );
}

// Stream + attempts + pages coexist on one node, in a stable order (⟳ ↻ ⊞).
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'busy',
            label: 'demo-api',
            request: { method: 'GET', url: 'https://example.com/feed' },
            stream: { chunks: 9 },
            attempts: 2,
            pages: 3,
        },
    ];
    const result = traceToMermaid(trace);
    assert.ok(
        result.includes('GET /feed ⟳9 ↻2 ⊞3'),
        'annotations: stream + attempts + pages render together',
    );
}

// Shell surface (ADR 0008): a `shell:<command>` url labels as `$ <command>`,
// NOT a fake `GET command` HTTP path (`new URL('shell:git').pathname` is 'git').
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'git-status',
            label: 'git',
            request: { method: 'GET', url: 'shell:git' },
            response: { status: 200, ok: true, durationMs: 12 },
        },
    ];
    const result = traceToMermaid(trace);
    assert.ok(
        result.includes('git_status["$ git"]'),
        'shell: node labelled `$ git`',
    );
    assert.ok(
        !result.includes('GET git'),
        'shell: NOT mislabelled as an HTTP path',
    );
}

// pipe() chain (ADR 0007 + 0008): each step is a child run of the previous, so
// the trace carries dependsOn = [prev] and the DAG draws stepA --> stepB --> stepC.
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'step-a',
            label: 'fetchUser',
            request: { method: 'GET', url: 'https://example.com/users/1' },
        },
        {
            id: 'step-b',
            label: 'enrich',
            request: { method: 'POST', url: 'https://example.com/enrich' },
            dependsOn: ['step-a'],
        },
        {
            id: 'step-c',
            label: 'summarise',
            request: {
                method: 'POST',
                url: 'https://api.anthropic.com/v1/messages',
            },
            dependsOn: ['step-b'],
        },
    ];
    const result = traceToMermaid(trace);
    assert.ok(
        result.includes('step_a --> step_b'),
        'pipe: first chain edge drawn',
    );
    assert.ok(
        result.includes('step_b --> step_c'),
        'pipe: second chain edge drawn',
    );
    // The llm step is HTTP, so it keeps the METHOD /path label.
    assert.ok(
        result.includes('POST /v1/messages'),
        'pipe: llm step labelled by its provider endpoint path',
    );
}

// Two nodes with a dependsOn edge.
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'fetch-token',
            label: 'fetchToken',
            request: { method: 'POST', url: 'https://example.com/token' },
            response: { status: 200, ok: true, durationMs: 40 },
        },
        {
            id: 'get-data',
            label: 'getData',
            request: { method: 'GET', url: 'https://example.com/data' },
            response: { status: 200, ok: true, durationMs: 60 },
            dependsOn: ['fetch-token'],
        },
    ];
    const result = traceToMermaid(trace);
    assert.ok(result.includes('fetch_token'), 'dag edge: parent id sanitised');
    assert.ok(result.includes('get_data'), 'dag edge: child id sanitised');
    assert.ok(
        result.includes('fetch_token --> get_data'),
        'dag edge: edge present',
    );
}

// Streaming entry — annotated with chunk count.
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'llm',
            label: 'chatStream',
            request: { method: 'POST', url: 'https://example.com/chat' },
            stream: { chunks: 42 },
        },
    ];
    const result = traceToMermaid(trace);
    assert.ok(result.includes('⟳42'), 'streaming entry: chunk count annotated');
}

// Determinism — two calls produce identical output.
{
    const trace: StitchTraceEntry[] = [
        {
            id: 'a',
            request: { method: 'GET', url: 'https://example.com/a' },
            dependsOn: [],
        },
        {
            id: 'b',
            request: { method: 'GET', url: 'https://example.com/b' },
            dependsOn: ['a'],
        },
    ];
    const r1 = traceToMermaid(trace);
    const r2 = traceToMermaid(trace);
    assert.equal(
        r1,
        r2,
        'determinism: two calls must produce identical output',
    );
}

/* -------------------------------------------------------------------------- */
/*  formatLog                                                                  */
/* -------------------------------------------------------------------------- */

{
    const line = formatLog({ level: 'log', args: ['hello', 'world'], at: 0 });
    assert.equal(line, 'hello world', 'formatLog: basic string args joined');
}

{
    const line = formatLog({ level: 'warn', args: [{ code: 42 }], at: 10 });
    assert.ok(line.startsWith('[warn]'), 'formatLog: non-log level prefixed');
    assert.ok(line.includes('"code": 42'), 'formatLog: object pretty-printed');
}

{
    const line = formatLog({ level: 'info', args: [undefined], at: 5 });
    assert.ok(
        line.includes('undefined'),
        'formatLog: undefined rendered as string',
    );
}

/* -------------------------------------------------------------------------- */
/*  formatValue                                                                */
/* -------------------------------------------------------------------------- */

{
    assert.equal(
        formatValue(undefined),
        '(undefined)',
        'formatValue: undefined',
    );
    assert.equal(formatValue(null), 'null', 'formatValue: null');
    assert.equal(
        formatValue('hello'),
        'hello',
        'formatValue: string passthrough',
    );
    assert.equal(formatValue(42), '42', 'formatValue: number stringified');
}

{
    const obj = { data: { id: 2 } };
    const result = formatValue(obj);
    assert.ok(result.includes('"id": 2'), 'formatValue: object pretty-printed');
}

/* -------------------------------------------------------------------------- */
/*  summarizeNotices                                                           */
/* -------------------------------------------------------------------------- */

{
    assert.deepEqual(
        summarizeNotices(undefined),
        [],
        'summarizeNotices: absent → []',
    );
    assert.deepEqual(summarizeNotices([]), [], 'summarizeNotices: empty → []');
}

{
    const notices: RunNotice[] = [
        {
            kind: 'shim',
            surface: 'keychain',
            message: 'keychain is simulated in the browser sandbox',
        },
    ];
    const result = summarizeNotices(notices);
    assert.equal(result.length, 1, 'summarizeNotices: shim notice → one entry');
    assert.ok(
        result[0].includes('`keychain` shimmed'),
        'summarizeNotices: shim surface named',
    );
    assert.ok(
        result[0].includes('keychain is simulated'),
        'summarizeNotices: shim message included',
    );
}

{
    const notices: RunNotice[] = [
        { kind: 'info', message: 'Running in browser sandbox.' },
    ];
    const result = summarizeNotices(notices);
    assert.equal(
        result[0],
        'Running in browser sandbox.',
        'summarizeNotices: info notice → raw message',
    );
}

/* -------------------------------------------------------------------------- */
/*  buildRunView (RunView shape helper)                                        */
/* -------------------------------------------------------------------------- */

// isStreaming flag — true when any trace entry has .stream.
{
    const result: RunResult = {
        durationMs: 100,
        logs: [],
        trace: [
            {
                id: 'llm',
                request: { method: 'POST', url: 'https://example.com/chat' },
                stream: { chunks: 7 },
            },
        ],
    };
    const view = buildRunView(result);
    assert.equal(
        view.isStreaming,
        true,
        'RunView: isStreaming true when trace has stream entry',
    );
}

// isStreaming false when no stream entries.
{
    const result: RunResult = {
        durationMs: 50,
        logs: [{ level: 'log', args: ['ok'], at: 0 }],
        value: { data: 'foo' },
        trace: [
            {
                id: 's1',
                request: { method: 'GET', url: 'https://example.com' },
            },
        ],
    };
    const view = buildRunView(result);
    assert.equal(
        view.isStreaming,
        false,
        'RunView: isStreaming false when no stream entries',
    );
    assert.equal(view.logs.length, 1, 'RunView: logs populated');
    assert.ok(view.valueText !== null, 'RunView: valueText present');
    assert.equal(view.errorText, null, 'RunView: no error → errorText null');
    assert.ok(
        view.mermaid.startsWith('flowchart TD'),
        'RunView: mermaid output valid',
    );
}

// error.reason surfaced in errorText.
{
    const result: RunResult = {
        durationMs: 10,
        logs: [],
        error: {
            name: 'TimeoutError',
            message: 'snippet exceeded timeout',
            phase: 'runtime',
            reason: 'timeout',
        },
    };
    const view = buildRunView(result);
    assert.ok(view.errorText !== null, 'RunView: error → errorText present');
    assert.ok(
        view.errorText!.includes('timeout'),
        'RunView: error.reason in errorText',
    );
    assert.ok(
        view.errorText!.includes('runtime'),
        'RunView: error.phase in errorText',
    );
}

// notices populated.
{
    const result: RunResult = {
        durationMs: 30,
        logs: [],
        notices: [
            { kind: 'shim', surface: 'env', message: 'env is simulated' },
        ],
    };
    const view = buildRunView(result);
    assert.equal(view.notices.length, 1, 'RunView: notices forwarded');
    assert.ok(
        view.notices[0].includes('`env` shimmed'),
        'RunView: shim notice formatted',
    );
}

/* -------------------------------------------------------------------------- */
/*  A2 — incremental accumulator: emptyRunView + applyEvent                  */
/* -------------------------------------------------------------------------- */

// Feed a synthetic ordered sequence: log → chunk → chunk → trace → notice
// and assert the view accumulates correctly at each step.

{
    // Initial empty view.
    const v0 = emptyRunView();
    assert.deepEqual(v0.logs, [], 'A2 emptyRunView: logs empty');
    assert.equal(v0.valueText, null, 'A2 emptyRunView: valueText null');
    assert.equal(v0.errorText, null, 'A2 emptyRunView: errorText null');
    assert.deepEqual(v0.notices, [], 'A2 emptyRunView: notices empty');
    assert.equal(v0.isStreaming, false, 'A2 emptyRunView: isStreaming false');
    assert.ok(
        v0.mermaid.startsWith('flowchart TD'),
        'A2 emptyRunView: mermaid valid',
    );

    // Step 1: log event.
    const logEvent: RunEvent = {
        type: 'log',
        entry: { level: 'info', args: ['hello from runner'], at: 10 },
    };
    const v1 = applyEvent(v0, logEvent);
    assert.equal(v1.logs.length, 1, 'A2 after log: one log line');
    assert.ok(
        v1.logs[0].includes('hello from runner'),
        'A2 after log: log text present',
    );
    assert.equal(
        v1.isStreaming,
        false,
        'A2 after log: isStreaming still false',
    );

    // Step 2: first chunk event (traceId='t1').
    const chunk1: RunEvent = { type: 'chunk', traceId: 't1', text: 'Hello, ' };
    const v2 = applyEvent(v1, chunk1);
    assert.equal(
        v2.isStreaming,
        true,
        'A2 first chunk: isStreaming flips true',
    );
    assert.equal(
        v2.valueText,
        'Hello, ',
        'A2 first chunk: valueText = first chunk text',
    );
    assert.equal(v2.logs.length, 1, 'A2 first chunk: log count unchanged');

    // Step 3: second chunk event (same traceId='t1') — text must concatenate in order.
    const chunk2: RunEvent = { type: 'chunk', traceId: 't1', text: 'World!' };
    const v3 = applyEvent(v2, chunk2);
    assert.equal(
        v3.isStreaming,
        true,
        'A2 second chunk: isStreaming remains true',
    );
    assert.equal(
        v3.valueText,
        'Hello, World!',
        'A2 second chunk: text concatenated in order',
    );

    // Step 4: trace event — DAG should grow.
    const traceEvent: RunEvent = {
        type: 'trace',
        entry: {
            id: 'step1',
            label: 'fetchUser',
            request: {
                method: 'GET',
                url: 'https://api.example.com/users/1',
            },
            response: { status: 200, ok: true, durationMs: 55 },
        },
    };
    const v4 = applyEvent(v3, traceEvent);
    assert.ok(
        v4.mermaid.includes('step1'),
        'A2 trace: mermaid includes new node id',
    );
    assert.ok(
        v4.mermaid.includes('GET /users/1'),
        'A2 trace: mermaid includes method + path node label',
    );
    // isStreaming should remain true (chunks already set it).
    assert.equal(
        v4.isStreaming,
        true,
        'A2 trace: isStreaming still true after trace',
    );

    // Step 5: notice event.
    const noticeEvent: RunEvent = {
        type: 'notice',
        notice: {
            kind: 'shim',
            surface: 'keychain',
            message: 'keychain is simulated in the browser sandbox',
        },
    };
    const v5 = applyEvent(v4, noticeEvent);
    assert.equal(v5.notices.length, 1, 'A2 notice: one notice accumulated');
    assert.ok(
        v5.notices[0].includes('`keychain` shimmed'),
        'A2 notice: shim surface formatted',
    );

    // Verify immutability: original views are unaffected.
    assert.equal(v0.logs.length, 0, 'A2 immutability: v0 logs unchanged');
    assert.equal(v1.logs.length, 1, 'A2 immutability: v1 logs unchanged at 1');
    assert.equal(
        v1.isStreaming,
        false,
        'A2 immutability: v1 isStreaming unchanged',
    );
    assert.equal(
        v2.valueText,
        'Hello, ',
        'A2 immutability: v2 valueText unchanged',
    );
}

// Multiple traceIds — streams must not interleave.
{
    let v = emptyRunView();
    v = applyEvent(v, { type: 'chunk', traceId: 'a', text: 'A1' });
    v = applyEvent(v, { type: 'chunk', traceId: 'b', text: 'B1' });
    v = applyEvent(v, { type: 'chunk', traceId: 'a', text: 'A2' });
    v = applyEvent(v, { type: 'chunk', traceId: 'b', text: 'B2' });
    // valueText is all streams joined in insertion order (a before b).
    assert.equal(
        v.valueText,
        'A1A2B1B2',
        'A2 multi-traceId: streams concatenated per traceId in order',
    );
}

// Mermaid grows as traces arrive — two successive trace events.
{
    let v = emptyRunView();
    v = applyEvent(v, {
        type: 'trace',
        entry: {
            id: 'n1',
            label: 'first',
            request: { method: 'GET', url: 'https://example.com/1' },
        },
    });
    const mermaid1 = v.mermaid;
    assert.ok(
        mermaid1.includes('n1'),
        'A2 mermaid grows: n1 present after first trace',
    );
    assert.ok(!mermaid1.includes('n2'), 'A2 mermaid grows: n2 not yet present');

    v = applyEvent(v, {
        type: 'trace',
        entry: {
            id: 'n2',
            label: 'second',
            request: { method: 'GET', url: 'https://example.com/2' },
            dependsOn: ['n1'],
        },
    });
    const mermaid2 = v.mermaid;
    assert.ok(
        mermaid2.includes('n1'),
        'A2 mermaid grows: n1 still present after second trace',
    );
    assert.ok(
        mermaid2.includes('n2'),
        'A2 mermaid grows: n2 present after second trace',
    );
    assert.ok(
        mermaid2.includes('n1 --> n2'),
        'A2 mermaid grows: edge n1→n2 present',
    );
}

// Reconciliation: applying all events then calling buildRunView(final) for logs/notices
// matches what buildRunView alone would produce for those fields.
{
    const finalResult: RunResult = {
        durationMs: 200,
        logs: [
            { level: 'info', args: ['[mock] executing snippet…'], at: 0 },
            {
                level: 'log',
                args: ['GET https://reqres.in/api/users/2 → 200'],
                at: 96,
            },
        ],
        value: { data: { id: 2, first_name: 'Janet' } },
        notices: [{ kind: 'info', message: 'Running in browser sandbox.' }],
        trace: [
            {
                id: 'req1',
                label: 'getUser',
                request: {
                    method: 'GET',
                    url: 'https://reqres.in/api/users/2',
                },
                response: { status: 200, ok: true, durationMs: 96 },
            },
        ],
    };

    // Simulate events arriving before the final result.
    let v = emptyRunView();
    for (const entry of finalResult.logs) {
        v = applyEvent(v, { type: 'log', entry });
    }
    for (const notice of finalResult.notices ?? []) {
        v = applyEvent(v, { type: 'notice', notice });
    }
    for (const entry of finalResult.trace ?? []) {
        v = applyEvent(v, { type: 'trace', entry });
    }

    // Final reconcile: buildRunView wins for value/error/durationMs.
    const finalView = buildRunView(finalResult);

    // Logs and notices should match between the event-accumulated view and the final view.
    assert.deepEqual(
        v.logs,
        finalView.logs,
        'A2 reconcile: event-accumulated logs match buildRunView logs',
    );
    assert.deepEqual(
        v.notices,
        finalView.notices,
        'A2 reconcile: event-accumulated notices match buildRunView notices',
    );
    // Mermaid should match (same trace entries).
    assert.equal(
        v.mermaid,
        finalView.mermaid,
        'A2 reconcile: mermaid matches buildRunView',
    );
}

/* -------------------------------------------------------------------------- */
/*  Done                                                                       */
/* -------------------------------------------------------------------------- */

console.log('U1 OK');
console.log('A2 OK');
