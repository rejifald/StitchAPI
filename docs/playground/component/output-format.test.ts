/**
 * output-format.test.ts — tsx smoke tests for the pure output-format helpers.
 *
 * Run with: npx -y tsx docs/playground/component/output-format.test.ts
 * Expected: prints "U1 OK" and exits 0.
 *
 * Uses node:assert (strict). No test framework required.
 */
import assert from 'node:assert/strict';
import {
    buildRunView,
    formatLog,
    formatValue,
    summarizeNotices,
    traceToMermaid,
} from './output-format';
import type { RunNotice, RunResult, StitchTraceEntry } from './runner';

/* -------------------------------------------------------------------------- */
/*  traceToMermaid                                                             */
/* -------------------------------------------------------------------------- */

// Empty trace → safe placeholder, not an error.
{
    const result = traceToMermaid([]);
    assert.ok(result.startsWith('flowchart TD'), 'empty trace: must start with flowchart TD');
    assert.ok(result.includes('_empty'), 'empty trace: must include placeholder node');
}

// Single node with no edges.
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
    assert.ok(result.includes('getUser'), 'single node: label must appear');
    // No edges when there are no dependsOn.
    assert.ok(!result.includes('-->'), 'single node: no edges expected');
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
    assert.ok(result.includes('fetch_token --> get_data'), 'dag edge: edge present');
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
        { id: 'a', request: { method: 'GET', url: 'https://example.com/a' }, dependsOn: [] },
        { id: 'b', request: { method: 'GET', url: 'https://example.com/b' }, dependsOn: ['a'] },
    ];
    const r1 = traceToMermaid(trace);
    const r2 = traceToMermaid(trace);
    assert.equal(r1, r2, 'determinism: two calls must produce identical output');
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
    assert.ok(line.includes('undefined'), 'formatLog: undefined rendered as string');
}

/* -------------------------------------------------------------------------- */
/*  formatValue                                                                */
/* -------------------------------------------------------------------------- */

{
    assert.equal(formatValue(undefined), '(undefined)', 'formatValue: undefined');
    assert.equal(formatValue(null), 'null', 'formatValue: null');
    assert.equal(formatValue('hello'), 'hello', 'formatValue: string passthrough');
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
    assert.deepEqual(summarizeNotices(undefined), [], 'summarizeNotices: absent → []');
    assert.deepEqual(summarizeNotices([]), [], 'summarizeNotices: empty → []');
}

{
    const notices: RunNotice[] = [
        { kind: 'shim', surface: 'keychain', message: 'keychain is simulated in the browser sandbox' },
    ];
    const result = summarizeNotices(notices);
    assert.equal(result.length, 1, 'summarizeNotices: shim notice → one entry');
    assert.ok(result[0].includes('`keychain` shimmed'), 'summarizeNotices: shim surface named');
    assert.ok(result[0].includes('keychain is simulated'), 'summarizeNotices: shim message included');
}

{
    const notices: RunNotice[] = [
        { kind: 'info', message: 'Running in browser sandbox.' },
    ];
    const result = summarizeNotices(notices);
    assert.equal(result[0], 'Running in browser sandbox.', 'summarizeNotices: info notice → raw message');
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
    assert.equal(view.isStreaming, true, 'RunView: isStreaming true when trace has stream entry');
}

// isStreaming false when no stream entries.
{
    const result: RunResult = {
        durationMs: 50,
        logs: [{ level: 'log', args: ['ok'], at: 0 }],
        value: { data: 'foo' },
        trace: [
            { id: 's1', request: { method: 'GET', url: 'https://example.com' } },
        ],
    };
    const view = buildRunView(result);
    assert.equal(view.isStreaming, false, 'RunView: isStreaming false when no stream entries');
    assert.equal(view.logs.length, 1, 'RunView: logs populated');
    assert.ok(view.valueText !== null, 'RunView: valueText present');
    assert.equal(view.errorText, null, 'RunView: no error → errorText null');
    assert.ok(view.mermaid.startsWith('flowchart TD'), 'RunView: mermaid output valid');
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
    assert.ok(view.errorText!.includes('timeout'), 'RunView: error.reason in errorText');
    assert.ok(view.errorText!.includes('runtime'), 'RunView: error.phase in errorText');
}

// notices populated.
{
    const result: RunResult = {
        durationMs: 30,
        logs: [],
        notices: [{ kind: 'shim', surface: 'env', message: 'env is simulated' }],
    };
    const view = buildRunView(result);
    assert.equal(view.notices.length, 1, 'RunView: notices forwarded');
    assert.ok(view.notices[0].includes('`env` shimmed'), 'RunView: shim notice formatted');
}

/* -------------------------------------------------------------------------- */
/*  Done                                                                       */
/* -------------------------------------------------------------------------- */

console.log('U1 OK');
