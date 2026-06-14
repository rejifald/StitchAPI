/**
 * S5 — dispatch core shared by both fetch-shim adapters.
 *
 * `dispatch(handlers, req)`:
 *   1. Parses reserved `__`-prefixed query knobs off `req.url` into `SimKnobs`
 *      and strips them so handlers see a clean URL.
 *   2. Finds the first matching handler; if none, returns the sandbox-404 body.
 *      Never attempts real network egress.
 *   3. Calls `handler.handle(req, knobs)`.
 *   4. Applies generic knobs to the result: status override, latencyMs delay,
 *      flaky (first-N-fail-503), stream wrapping (chunked / sse).
 *      `drift` is handler-intrinsic (passed through in knobs, not applied here).
 *
 * `resetFlaky()`: resets the per-path failure counters for test isolation.
 */
import type {
    SimHandler,
    SimKnobs,
    SimRequest,
    SimResponse,
} from '../../../docs/sandbox/contracts/sim';

// ---------------------------------------------------------------------------
// Sandbox-404 helper (SANDBOX.md §4.3)
// ---------------------------------------------------------------------------

const KNOWN_DEMO_HOSTS = ['demo.stitchapi.dev'];

function sandbox404(url: URL): SimResponse {
    return {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: {
            error: 'sandbox_not_found',
            message:
                `${url.host} is not reachable inside the StitchAPI sandbox; ` +
                `available demo hosts: ${KNOWN_DEMO_HOSTS.join(', ')}. ` +
                `No real network request was made.`,
            sandbox: true,
        },
    };
}

// ---------------------------------------------------------------------------
// Knob parsing
// ---------------------------------------------------------------------------

/**
 * Parses the reserved `__`-prefixed query params from a URL into `SimKnobs`,
 * returning both the knobs and a cleaned `URL` (those params stripped).
 */
function parseKnobs(url: URL): { knobs: SimKnobs; cleanUrl: URL } {
    const knobs: SimKnobs = {};
    const clean = new URL(url.toString());

    const status = clean.searchParams.get('__status');
    if (status !== null) {
        const n = parseInt(status, 10);
        if (!isNaN(n)) knobs.status = n;
        clean.searchParams.delete('__status');
    }

    const latencyMs = clean.searchParams.get('__latencyMs');
    if (latencyMs !== null) {
        const n = parseInt(latencyMs, 10);
        if (!isNaN(n)) knobs.latencyMs = n;
        clean.searchParams.delete('__latencyMs');
    }

    const stream = clean.searchParams.get('__stream');
    if (stream === 'chunked' || stream === 'sse') {
        knobs.stream = stream;
        clean.searchParams.delete('__stream');
    }

    const drift = clean.searchParams.get('__drift');
    if (drift !== null) {
        knobs.drift = drift === '1' || drift === 'true';
        clean.searchParams.delete('__drift');
    }

    const flaky = clean.searchParams.get('__flaky');
    if (flaky !== null) {
        const n = parseInt(flaky, 10);
        if (!isNaN(n)) knobs.flaky = n;
        clean.searchParams.delete('__flaky');
    }

    return { knobs, cleanUrl: clean };
}

// ---------------------------------------------------------------------------
// Flaky counter (per-path, module-level for test isolation via resetFlaky)
// ---------------------------------------------------------------------------

const flakyCounters = new Map<string, number>();

/** Reset all per-path flaky failure counters (call between tests). */
export function resetFlaky(): void {
    flakyCounters.clear();
}

// ---------------------------------------------------------------------------
// Stream wrapping: body → AsyncIterable<Uint8Array>
// ---------------------------------------------------------------------------

async function* wrapBodyAsChunked(body: unknown): AsyncIterable<Uint8Array> {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const enc = new TextEncoder();
    // Single chunk for simplicity; handler streaming (S3) returns its own stream.
    yield enc.encode(text);
}

async function* wrapBodyAsSse(body: unknown): AsyncIterable<Uint8Array> {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const enc = new TextEncoder();
    // Wrap as a single SSE data event.
    yield enc.encode(`data: ${text}\n\n`);
    yield enc.encode('data: [DONE]\n\n');
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a `SimRequest` through the handler list, apply knobs, return a
 * `SimResponse`. Never touches real network.
 *
 * `defaultKnobs` (optional) are baseline knobs applied to EVERY request — the
 * playground's "Response knobs" panel sets these so a configured knob shapes
 * the whole run without editing the snippet. URL knobs always win: an explicit
 * `?__flaky=2` in the code overrides the panel's default for that one call.
 */
export async function dispatch(
    handlers: SimHandler[],
    req: SimRequest,
    defaultKnobs?: SimKnobs,
): Promise<SimResponse> {
    // 1. Parse knobs off the URL and produce a clean request (no __ params),
    //    then layer them over the panel defaults — URL-explicit knobs win.
    const { knobs: urlKnobs, cleanUrl } = parseKnobs(req.url);
    const knobs: SimKnobs = { ...defaultKnobs, ...urlKnobs };
    const cleanReq: SimRequest = { ...req, url: cleanUrl };

    // 2. Find first matching handler.
    const handler = handlers.find((h) => h.match(cleanReq));
    if (!handler) {
        return sandbox404(req.url);
    }

    // 3. Apply flaky knob BEFORE calling the handler.
    const path = cleanUrl.pathname;
    if (knobs.flaky !== undefined && knobs.flaky > 0) {
        const seen = flakyCounters.get(path) ?? 0;
        if (seen < knobs.flaky) {
            flakyCounters.set(path, seen + 1);
            // Fail with 503 for the first `flaky` calls.
            return {
                status: 503,
                headers: { 'content-type': 'application/json' },
                body: {
                    error: 'flaky_failure',
                    message: `Simulated transient failure (attempt ${seen + 1} of ${knobs.flaky}).`,
                    sandbox: true,
                },
            };
        }
        // Past the flaky threshold — fall through to normal handler.
    }

    // 4. Call the handler.
    let response = await handler.handle(cleanReq, knobs);

    // 5. Apply generic knobs to the response.

    // 5a. Status override.
    if (knobs.status !== undefined) {
        response = { ...response, status: knobs.status };
    }

    // 5b. Latency — real await, timing is non-deterministic (SANDBOX §4.3).
    if (knobs.latencyMs !== undefined && knobs.latencyMs > 0) {
        await new Promise<void>((resolve) =>
            setTimeout(resolve, knobs.latencyMs),
        );
    }

    // 5c. Stream wrapping — only when the handler didn't already return a stream.
    if (knobs.stream !== undefined && response.stream === undefined) {
        const body = response.body;
        const stream =
            knobs.stream === 'sse'
                ? wrapBodyAsSse(body)
                : wrapBodyAsChunked(body);
        response = {
            ...response,
            stream,
            // body is consumed by the stream; clear it to avoid double-sending.
            body: undefined,
        };
    }

    // 5d. `drift` is handler-intrinsic — already passed through knobs to the handler;
    //     no generic application needed here.

    return response;
}
