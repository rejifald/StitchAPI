// The two providers, as plain `Adapter`s over an injected {@link Clock} — no network, no timers of
// their own.
//
// The scenario's whole measurement is PER PROVIDER, so the fake is built around a single ledger per
// provider rather than one shared one: `primary.received` and `backup.received` are two independent
// integers, and every claim in this directory is a statement about the pair. That matters because
// "failover" and "hedging" produce IDENTICAL results and identical latencies on a happy path — the
// only thing that tells them apart is how many requests the backup received, which is exactly the
// number a bill is computed from.
//
// The two providers are deliberately NOT interchangeable at the wire level, because real ones never
// are: different origin, different path, different auth header, different success-body shape and
// different error vocabulary. C4 is the claim that turns on that difference.
import type {
    Adapter,
    AdapterRequest,
    Clock,
} from '../../../../packages/core/src/types';

/** One request that actually reached a provider — the unit every count in this directory is over. */
export interface ProviderCall {
    /** Virtual ms at which the request arrived. */
    at: number;
    method: string;
    /** Path the request was addressed to — the evidence for C4's "did it hit MY endpoint". */
    path: string;
    /** Query string as received, without the leading `?`. */
    query: string;
    /** Every header, lowercased — C4 reads the auth headers off this. */
    headers: Record<string, string>;
    body: unknown;
    /** Status this provider answered with (or would have, had it not been aborted). */
    status: number;
    /**
     * True when the caller's signal fired while this provider was still working. The distinction
     * that matters for C6: an aborted request STILL ARRIVED. An LLM bills the tokens it generated
     * before the abort, so a cancelled loser is cheaper than a completed one and is not free.
     */
    abortedMidFlight: boolean;
    /** Virtual ms of work this provider had done when it either answered or was aborted. */
    workedMs: number;
}

export interface FakeProviderOptions {
    /** Label used in the success body and in this file's own reporting. */
    name: string;
    clock: Clock;
    /** Origin this provider answers on — deliberately different per provider. */
    origin: string;
    /** The one path this provider serves. A request to any other path is a 404 (see `adapter`). */
    path: string;
    /** Status to answer with. Default 200. */
    status?: number;
    /** Virtual ms this provider takes to answer. Default 0 (answers synchronously). */
    latency?: number;
}

/**
 * One provider. `adapter()` is what a stitch is handed; `calls` is the ledger, and `received` /
 * `completed` / `aborted` are the three integers the claims assert on.
 */
export class FakeProvider {
    readonly name: string;
    readonly origin: string;
    readonly path: string;
    readonly calls: ProviderCall[] = [];
    private readonly clock: Clock;
    private status: number;
    private latency: number;

    constructor(opts: FakeProviderOptions) {
        this.name = opts.name;
        this.clock = opts.clock;
        this.origin = opts.origin;
        this.path = opts.path;
        this.status = opts.status ?? 200;
        this.latency = opts.latency ?? 0;
    }

    /** Requests that ARRIVED — billable in the general case, whatever happened afterwards. */
    get received(): number {
        return this.calls.length;
    }

    /** Requests this provider answered in full. */
    get completed(): number {
        return this.calls.filter((c) => !c.abortedMidFlight).length;
    }

    /** Requests that arrived and were then cancelled mid-flight — arrived, but never answered. */
    get aborted(): number {
        return this.calls.filter((c) => c.abortedMidFlight).length;
    }

    /** Virtual ms of work done across every request, aborted ones included — the "tokens billed" proxy. */
    get workedMs(): number {
        return this.calls.reduce((sum, c) => sum + c.workedMs, 0);
    }

    /** Make this provider answer with `status` from now on. `429`/`500` = availability, `400` = your payload. */
    respond(status: number): void {
        this.status = status;
    }

    /** Make this provider take `ms` of virtual time to answer — a slow leg, or a degraded backend. */
    takes(ms: number): void {
        this.latency = ms;
    }

    /** Forget every recorded request (so one script can measure several constructions cleanly). */
    reset(): void {
        this.calls.length = 0;
    }

    /**
     * The error body this provider returns. Deliberately different per provider and per status —
     * the "different error vocabularies" hazard, and what C3 measures the caller's ability to see.
     */
    private errorBody(status: number): unknown {
        return {
            provider: this.name,
            error: {
                code: status === 400 ? 'invalid_request' : 'unavailable',
                message: `${this.name} says ${status}`,
            },
        };
    }

    adapter(): Adapter {
        return async (req: AdapterRequest) => {
            const url = new URL(req.url);
            // Recorded on ARRIVAL, before any hold — `received` is "the request left the process and
            // reached this provider", which is the quantity a bill is computed from.
            const call: ProviderCall = {
                at: this.clock.now(),
                method: req.method,
                path: url.pathname,
                query: url.search.replace(/^\?/, ''),
                headers: Object.fromEntries(
                    Object.entries(req.headers).map(([k, v]) => [
                        k.toLowerCase(),
                        v,
                    ]),
                ),
                body: req.body,
                status: this.status,
                abortedMidFlight: false,
                workedMs: 0,
            };
            this.calls.push(call);

            // A provider that is not addressed at its own endpoint 404s, exactly as a real one
            // would. This is the whole of C4's measurement: a combinator that hands every member
            // the same input addresses one of them wrongly.
            if (url.pathname !== this.path) {
                call.status = 404;
                return {
                    status: 404,
                    headers: {},
                    body: {
                        provider: this.name,
                        error: {
                            code: 'no_such_endpoint',
                            message: `${this.name} has no ${url.pathname}`,
                        },
                    },
                };
            }

            if (this.latency > 0) {
                const start = this.clock.now();
                try {
                    await this.clock.sleep(this.latency, req.signal);
                    call.workedMs = this.clock.now() - start;
                } catch {
                    // The caller cancelled. The request had already arrived and this provider had
                    // already burned `workedMs` of work on it — that work is billed.
                    call.abortedMidFlight = true;
                    call.workedMs = this.clock.now() - start;
                    throw new Error(`${this.name}: aborted`);
                }
            }

            if (this.status >= 400)
                return {
                    status: this.status,
                    headers: {},
                    body: this.errorBody(this.status),
                };
            return {
                status: 200,
                headers: {},
                // Deliberately different success shapes: the primary nests its text, the backup
                // flattens it. Normalising them is user code either way (see `pick` in the claims).
                body:
                    this.name === 'backup'
                        ? {
                              served_by: this.name,
                              output: `answer from ${this.name}`,
                          }
                        : {
                              served_by: this.name,
                              choices: [{ text: `answer from ${this.name}` }],
                          },
            };
        };
    }
}

/** Both providers over one clock, wired the way a real pair is: different origin, path and auth. */
export interface ProviderPair {
    primary: FakeProvider;
    backup: FakeProvider;
}

export function providerPair(clock: Clock): ProviderPair {
    return {
        primary: new FakeProvider({
            name: 'primary',
            clock,
            origin: 'https://primary.llm.test',
            path: '/v1/complete',
        }),
        backup: new FakeProvider({
            name: 'backup',
            clock,
            origin: 'https://backup.llm.test',
            path: '/generate',
        }),
    };
}

/** `[primary.received, backup.received]` — the two-integer spine every claim here prints. */
export const hits = (p: ProviderPair): [number, number] => [
    p.primary.received,
    p.backup.received,
];

/**
 * Run one call and reduce it to a short outcome token — `'ok'`, or `'<status>'` / `'<name>'` for a
 * failure.
 *
 * `PromiseLike`, not `Promise`: a stitch call returns a lazy `StitchResult` thenable that starts on
 * `.then` (stitch.ts:729,781), and a combinator returns a real `Promise` — both are `PromiseLike`.
 */
export async function outcomeOf(
    call: () => PromiseLike<unknown>,
): Promise<string> {
    try {
        await call();
        return 'ok';
    } catch (e) {
        const err = e as Error & { status?: number };
        return String(err.status ?? err.name);
    }
}
