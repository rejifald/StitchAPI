// Cross-surface invariant: a stitch endpoint URL carrying a credential — URL basic-auth userinfo
// (`https://user:pass@host`) and/or a secret query value (`?access_token=…`) — must NEVER survive
// into an artifact `@stitchapi/core` emits. Every URL-emitting sink already routes its URL through
// `scrubUrl` (or, for the event stream, `redactEventForTransport`); this test is the CLASS GUARD
// behind that per-sink discipline.
//
// It exists because the leak #415 fixed (`toOpenApi`'s `servers[].url`) was the one URL sink that
// forgot to scrub — a whack-a-mole bug that recurs the moment a NEW emit surface is added and the
// author forgets. So the rule here is: every core surface that serializes a stitch's endpoint URL
// into output MUST be registered as a case below. A future config-exporter — `stitch gen` /
// client publishing (ADR 0013/0014) — that forgets to scrub will fail THIS test instead of baking
// a password into a shared document. Add the surface here in the same PR that adds the surface.
import { otlp, stitch } from '../src';
import type { OtelSpan, SpanExporter, StitchEvent } from '../src';
import { toOpenApi } from '../src/openapi';
import type { StitchRegistry } from '../src/registry';
import { redactEventForTransport } from '../src/trace';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep this suite's own trace sink quiet/captured, like the other trace/otlp specs.
process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-no-leak-${process.pid}.jsonl`,
);

// The credential material. `USERNAME` alone is deliberately NOT scanned for — a bare `svc` token
// could legitimately appear as a substring elsewhere. We scan for the parts that unambiguously
// identify a leak: the password, the secret-query value, and the intact `user:pass` userinfo pair.
const USERNAME = 'svc';
const PASSWORD = 's3cr3t';
const SECRET_QUERY_VALUE = 'leaktok'; // rides `?access_token=…` (matches the `token` secret stem)
const HOST = 'api.internal'; // must be PRESERVED — scrubbing strips the credential, not the target

const LEAK_MARKERS = [
    PASSWORD, // the password
    SECRET_QUERY_VALUE, // the secret query value
    `${USERNAME}:${PASSWORD}`, // the intact userinfo pair
    `${USERNAME}:${PASSWORD}@`, // …with the userinfo delimiter
];

// A full endpoint URL with BOTH credential vectors, for the surfaces that emit the whole URL.
const POISONED_URL = `https://${USERNAME}:${PASSWORD}@${HOST}/v1/users/1?access_token=${SECRET_QUERY_VALUE}`;
// The origin+path form `toOpenApi` consumes (it emits only the origin into `servers[].url`).
const POISONED_BASE_URL = `https://${USERNAME}:${PASSWORD}@${HOST}/v1`;

const startEvent = (): StitchEvent => ({
    type: 'start',
    name: 'getUser',
    method: 'GET',
    url: POISONED_URL,
    input: { query: { access_token: SECRET_QUERY_VALUE } }, // also exercises the structured-query scrub
    at: 1,
});

// Drive the OTLP sink with the poisoned start event and return the exported spans (which carry
// `url.full` / `server.address`). A stub exporter captures in memory — no collector, no network.
function otlpSpans(): OtelSpan[] {
    const spans: OtelSpan[] = [];
    const exporter: SpanExporter = {
        export(batch) {
            spans.push(...batch);
        },
    };
    const sink = otlp.sink({ exporter });
    const name = 'getUser';
    sink.handle(startEvent(), { name });
    sink.handle(
        { type: 'result', data: {}, status: 200, attempts: 1, at: 2 },
        { name },
    );
    sink.handle(
        { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 2 },
        { name },
    );
    return spans;
}

// Each case serializes one URL-emitting surface fed the poisoned URL, and returns the artifact as a
// string to scan. `emitsHost` marks surfaces that keep the target host (a positive check that the
// scrub removed the credential, not the whole URL).
interface Surface {
    name: string;
    serialize: () => string;
    emitsHost: boolean;
}

const SURFACES: Surface[] = [
    {
        // Config export — the family the #415 leak lived in. `stitch export --openapi`.
        name: 'toOpenApi → servers[].url',
        serialize: () => {
            const registry: StitchRegistry = {
                getUser: stitch({
                    baseUrl: POISONED_BASE_URL,
                    path: '/users/{id}',
                }),
            };
            return JSON.stringify(toOpenApi(registry).document);
        },
        emitsHost: true,
    },
    {
        // The event-stream choke-point: `stitch serve`'s SSE `start` frame and every trace sink
        // (file/logger/console) run each event through this before it leaves the process.
        name: 'redactEventForTransport → start frame',
        serialize: () => JSON.stringify(redactEventForTransport(startEvent())),
        emitsHost: false, // scrubUrl keeps the host, but we assert the class markers, not the host
    },
    {
        // OTLP export — `url.full` / `server.address` on the exported CLIENT span.
        name: 'otlp.sink → span url.full',
        serialize: () => JSON.stringify(otlpSpans()),
        emitsHost: true,
    },
];

describe('no credential leaks in emitted artifacts (class guard behind per-sink scrubUrl)', () => {
    // A tripwire: if the surface list is ever emptied (a bad refactor), the guard would vacuously
    // pass. Pin that it covers the config-export surface the leak lived in.
    test('the surface registry is populated and covers config export', () => {
        expect(SURFACES.length).toBeGreaterThanOrEqual(3);
        expect(SURFACES.map((s) => s.name)).toContain(
            'toOpenApi → servers[].url',
        );
    });

    test.each(SURFACES)('$name emits no credential', ({ serialize }) => {
        const artifact = serialize();
        for (const marker of LEAK_MARKERS) {
            expect(artifact).not.toContain(marker);
        }
    });

    // The target host is preserved where the surface emits a whole URL — proof the scrub stripped
    // the credential rather than discarding the URL wholesale (kept a separate case so the
    // assertion isn't guarded by a per-surface conditional).
    test.each(SURFACES.filter((s) => s.emitsHost))(
        '$name preserves the target host',
        ({ serialize }) => {
            expect(serialize()).toContain(HOST);
        },
    );
});
