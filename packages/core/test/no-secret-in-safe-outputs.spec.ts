// Class guard for #873: every output the docs call SAFE TO LOG / ECHO stays free of a literal
// secret, wherever the author or the upstream put it. `no-credential-leak.spec.ts` guards the
// endpoint-URL family; this suite guards the wider class — a secret that is not only in the URL but
// in a literal header, the request body or the response body — across the outputs that used to
// carry one verbatim:
//
//   - `JSON.stringify(err)`        — `StitchError` had no `toJSON`: `body` rode out unredacted;
//   - `.report()`                  — its `config` echoed literal endpoint/header secrets;
//   - the JSONL file sink          — truncated bodies but never scrubbed secret-named fields;
//   - `stitch run` stdout          — wrote the raw `start` event, echoing the request input;
//   - MCP `describe_stitch`        — its `endpoint`/`diagram` read the literal endpoint off `__config`;
//   - `toMermaid` / `toOpenApi`    — the other `__config` readers.
//
// Each output is one row of `OUTPUTS`; every row is scanned for EVERY sentinel, so a new output (or
// a new place a secret can sit) is one line here, not a new suite.
import { RateLimitError, StitchError, fileSink, stitch } from '../src';
import type { Adapter, AdapterRequest, Stitch } from '../src';
import { runStitch } from '../src/cli';
import { toMermaid } from '../src/diagram';
import { createMcpServer } from '../src/mcp';
import type { JsonRpcMessage } from '../src/mcp';
import { toOpenApi } from '../src/openapi';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// One distinct sentinel per place a secret can sit.
const SECRET = {
    query: 'qsecret873', // a secret query value — `?api_key=…` in the literal url
    userinfo: 'upass873', // URL userinfo — `https://svc:…@host`
    header: 'hsecret873', // a literal config header — `authorization: Bearer …`
    customHeader: 'xsecret873', // a secret-NAMED header off the five-name denylist — `x-auth-token`
    requestBody: 'bsecret873', // a request-body field — `password` / `client_secret`
    responseBody: 'rsecret873', // a response-body field — `access_token` / `refresh_token`
} as const;
const SENTINELS = Object.values(SECRET);

const HOST = 'api.example.test';
const URL_WITH_SECRETS = `https://svc:${SECRET.userinfo}@${HOST}/oauth/{tenant}/token?page=2&api_key=${SECRET.query}`;
const REQUEST_BODY = {
    username: 'svc',
    password: SECRET.requestBody,
    client_secret: SECRET.requestBody,
};
const RESPONSE_BODY = {
    token_type: 'bearer',
    access_token: SECRET.responseBody,
    nested: { refresh_token: SECRET.responseBody },
};

const dir = mkdtempSync(join(tmpdir(), 'stitch-873-'));
const traceFile = join(dir, 'trace.jsonl');
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

// A stub transport: records what was actually SENT (the redaction must be output-only) and answers
// with a secret-bearing body at the URL it was asked for (so `StitchError.url` carries the secrets).
const sent: AdapterRequest[] = [];
const respondWith =
    (status: number): Adapter =>
    async (req) => {
        sent.push(req);
        return {
            status,
            headers: { 'content-type': 'application/json' },
            body: RESPONSE_BODY,
            url: req.url,
        };
    };

const make = (name: string, status: number): Stitch =>
    stitch({
        name,
        method: 'POST',
        url: URL_WITH_SECRETS,
        headers: {
            accept: 'application/json',
            authorization: `Bearer ${SECRET.header}`,
            'x-auth-token': SECRET.customHeader,
        },
        adapter: respondWith(status),
        trace: fileSink(traceFile),
    });

const ok = make('login', 200);
const denied = make('loginDenied', 401);
const input = { params: { tenant: 'acme' }, body: REQUEST_BODY };

let failure: StitchError;
let deniedReport: unknown;
let okReportConfig: unknown;
let runLines: string[];

beforeAll(async () => {
    await ok(input);
    const safe = await denied.safe(input);
    if (safe.ok) throw new Error('expected the 401 stitch to fail');
    failure = safe.error;
    deniedReport = await denied.report(input);
    okReportConfig = (await ok.report(input)).config;
    // `stitch run` with the secrets passed on the command line, the way an operator would.
    runLines = [];
    await runStitch(
        { loginDenied: denied },
        'loginDenied',
        [
            '--tenant',
            'acme',
            '--body.password',
            SECRET.requestBody,
            '--headers.authorization',
            `Bearer ${SECRET.header}`,
        ],
        (line) => runLines.push(line),
    );
});

async function describeStitch(name: string): Promise<string> {
    const server = createMcpServer({ login: ok, loginDenied: denied });
    const res = (await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'describe_stitch', arguments: { name } },
    })) as JsonRpcMessage & {
        result: { content: { text: string }[]; isError?: boolean };
    };
    expect(res.result.isError).toBeFalsy();
    return res.result.content.map((c) => c.text).join('\n');
}

// Every output documented as safe to log/echo, serialised the way a caller would log it.
const OUTPUTS: { name: string; serialize: () => string | Promise<string> }[] = [
    {
        name: 'JSON.stringify(StitchError)',
        serialize: () => JSON.stringify(failure),
    },
    {
        // A failed run, so `data` is null and the WHOLE report is in scope — `config`, `error`
        // (through `toJSON`), findings, timing. (`raw` is non-enumerable by design.)
        name: 'JSON.stringify(report()) on a failure',
        serialize: () => JSON.stringify(deniedReport),
    },
    {
        name: 'report().config',
        serialize: () => JSON.stringify(okReportConfig),
    },
    {
        name: 'JSONL file sink',
        serialize: () => readFileSync(traceFile, 'utf8'),
    },
    { name: '`stitch run` stdout', serialize: () => runLines.join('\n') },
    { name: 'MCP describe_stitch', serialize: () => describeStitch('login') },
    {
        name: 'toMermaid (stitch diagram)',
        serialize: () => toMermaid({ login: ok }).diagram,
    },
    {
        name: 'toOpenApi (stitch export --openapi)',
        serialize: () => JSON.stringify(toOpenApi({ login: ok }).document),
    },
];

describe('#873 — no literal secret reaches an output documented as safe to log', () => {
    test('the fixture really sent every secret (redaction is output-only)', () => {
        const req = sent[0]!;
        expect(req.url).toContain(`svc:${SECRET.userinfo}@`);
        expect(req.url).toContain(`api_key=${SECRET.query}`);
        expect(req.headers['authorization']).toBe(`Bearer ${SECRET.header}`);
        expect(req.headers['x-auth-token']).toBe(SECRET.customHeader);
        expect(JSON.stringify(req.body)).toContain(SECRET.requestBody);
        // …and the file sink did record the success run (so its scan below is not vacuous).
        expect(readFileSync(traceFile, 'utf8')).toContain('"type":"result"');
        expect(runLines.some((l) => l.includes('"type":"start"'))).toBe(true);
    });

    test.each(OUTPUTS)(
        '$name carries none of the sentinels',
        async ({ serialize }) => {
            const out = await serialize();
            expect(out.length).toBeGreaterThan(0);
            for (const sentinel of SENTINELS)
                expect(out).not.toContain(sentinel);
        },
    );

    test('the scrub keeps what is not secret (host, benign query, benign header, template)', () => {
        const cfg = ok.__config;
        expect(cfg.url).toBe(
            `https://${HOST}/oauth/{tenant}/token?page=2&api_key=REDACTED`,
        );
        expect(cfg.headers).toEqual({
            accept: 'application/json',
            authorization: '[REDACTED]',
            'x-auth-token': '[REDACTED]',
        });
    });
});

describe('StitchError.toJSON', () => {
    test('emits { name, message, status, attempts, url } — message included, body left out', () => {
        const json = JSON.parse(JSON.stringify(failure)) as Record<
            string,
            unknown
        >;
        expect(Object.keys(json).sort()).toEqual(
            ['attempts', 'message', 'name', 'status', 'url'].sort(),
        );
        expect(json['name']).toBe('StitchError');
        expect(json['message']).toBe(failure.message);
        expect(json['status']).toBe(401);
        expect(json['url']).toBe(
            `https://${HOST}/oauth/acme/token?page=2&api_key=REDACTED`,
        );
        // The live error still carries the unredacted body and URL for a deliberate read.
        expect(failure.body).toEqual(RESPONSE_BODY);
        expect(failure.url).toContain(SECRET.query);
    });

    test('a transport error without status/url serialises without them', () => {
        expect(
            JSON.parse(JSON.stringify(new StitchError('socket hang up'))),
        ).toEqual({
            name: 'StitchError',
            message: 'socket hang up',
            attempts: 0,
        });
    });

    test('RateLimitError adds retryAfter and keeps the raw response (set-cookie, body) out', () => {
        const err = new RateLimitError({
            status: 429,
            retryAfter: 1000,
            attempts: 1,
            response: {
                status: 429,
                headers: { 'set-cookie': `sid=${SECRET.header}` },
                body: RESPONSE_BODY,
                url: URL_WITH_SECRETS,
            },
        });
        const out = JSON.stringify(err);
        for (const sentinel of SENTINELS) expect(out).not.toContain(sentinel);
        expect(JSON.parse(out)).toMatchObject({
            name: 'RateLimitError',
            status: 429,
            attempts: 1,
            retryAfter: 1000,
        });
        expect(err.response.headers['set-cookie']).toContain(SECRET.header);
    });
});
