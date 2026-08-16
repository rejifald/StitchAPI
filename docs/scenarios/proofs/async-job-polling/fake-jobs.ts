// A fake, in-memory ASYNC JOB API — the three endpoints of the async request–reply triangle,
// shaped the way Salesforce Bulk API 2.0 / Shopify bulk operations / a report renderer shape them:
//
//   1. `POST /jobs`          → **202** + `Location: /jobs/{id}` (+ optionally `Retry-After`)
//   2. `GET  /jobs/{id}`     → **200** `{ state }`, cycling `InProgress` N times then a TERMINAL
//                              `JobComplete` (with `resultUrl`) or `Failed` (with `errorMessage`).
//                              Every one of those is an HTTP 200 — the status line never says
//                              "done" and never says "failed".
//   3. `GET  <resultUrl>`    → the payload, **SINGLE-USE**: the first fetch works, a second 404s.
//
// Everything is driven by an INJECTED {@link Clock} and nothing touches the network, so an
// hour-long poll is virtual time. The provider records EVERY hit with the virtual timestamp, which
// makes three things measurements rather than arguments:
//
//   - `polls(id).length` — how many times the client polled.
//   - `gaps(id)`         — the ms between successive polls on the injected clock.
//   - `submits`          — how many times the client SUBMITTED. `> 1` is a duplicate job: hours of
//                          server work done twice, the failure mode that makes restart dangerous.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    Clock,
} from '../../../../packages/core/src/types';

/** One recorded hit, as the provider saw it. */
export interface RecordedHit {
    method: string;
    /** Path only (the fake has one host), e.g. `/jobs/job-1`. */
    path: string;
    status: number;
    /** Virtual time (ms) the request arrived, read off the injected clock. */
    at: number;
}

/** What a job status body looks like on the wire. All three variants are HTTP 200. */
export interface JobStatus {
    id: string;
    /** Salesforce's vocabulary: `InProgress` is non-terminal; `JobComplete`/`Failed` are terminal. */
    state: 'InProgress' | 'JobComplete' | 'Failed';
    /** Present only on `JobComplete`. */
    resultUrl?: string;
    /** Present only on `Failed`. */
    errorMessage?: string;
}

export interface JobsOptions {
    clock: Clock;
    /**
     * How many `InProgress` polls a submitted job answers before it reaches its terminal state.
     * Default 3.
     */
    inProgressPolls?: number;
    /** Terminal state the job lands on. Default `'JobComplete'`. */
    terminal?: 'JobComplete' | 'Failed';
    /**
     * `Retry-After` the provider sends on the `202` **and** on every `InProgress` poll — the
     * server's own pacing. A number is delta-seconds (`30` → `'30'`); a string is the RAW header
     * value, so an HTTP-date (`'Thu, 01 Jan 1970 00:01:00 GMT'`) — the other form RFC 9110 allows
     * — can be exercised too. Omit for a provider that sends no header at all, which is the case
     * a client must fall back to a computed backoff for.
     */
    retryAfter?: number | string;
    /** Payload the result URL serves once. Default `{ rows: 3 }`. */
    payload?: unknown;
}

const HOST = 'https://bulk.example.com';

/** One submitted job's server-side state. */
interface JobRecord {
    id: string;
    pollsSeen: number;
    /** Fetches of this job's result URL; the second one 404s. */
    resultFetches: number;
}

/**
 * The three-endpoint async job API. One instance is one server: submit as many jobs as you like,
 * each gets its own id and its own poll counter.
 */
export class FakeJobApi {
    /** Every hit, in order, across all three endpoints. */
    readonly hits: RecordedHit[] = [];
    private readonly clock: Clock;
    private readonly inProgressPolls: number;
    private readonly terminal: 'JobComplete' | 'Failed';
    private readonly retryAfter: string | undefined;
    private readonly payload: unknown;
    private readonly jobs = new Map<string, JobRecord>();
    private nextId = 1;

    constructor(opts: JobsOptions) {
        this.clock = opts.clock;
        this.inProgressPolls = opts.inProgressPolls ?? 3;
        this.terminal = opts.terminal ?? 'JobComplete';
        this.retryAfter =
            opts.retryAfter === undefined ? undefined : String(opts.retryAfter);
        this.payload = opts.payload ?? { rows: 3 };
    }

    /** How many times `POST /jobs` was called. **`> 1` is a duplicate-submitted job.** */
    get submits(): number {
        return this.hits.filter(
            (h) => h.path === '/jobs' && h.method === 'POST',
        ).length;
    }

    /** The ids the server minted, in submission order. */
    get jobIds(): string[] {
        return [...this.jobs.keys()];
    }

    /** Every `GET /jobs/{id}` hit for one job. `.length` IS the poll count. */
    polls(id: string): RecordedHit[] {
        return this.hits.filter(
            (h) => h.method === 'GET' && h.path === `/jobs/${id}`,
        );
    }

    /** Virtual-clock ms between successive polls of one job — the pacing, measured. */
    gaps(id: string): number[] {
        const at = this.polls(id).map((h) => h.at);
        return at.slice(1).map((t, i) => t - at[i]!);
    }

    /** Every hit on a result URL, whatever its job. */
    get resultFetches(): RecordedHit[] {
        return this.hits.filter((h) => h.path.startsWith('/results/'));
    }

    /** The `Location`-relative path for a job id — what step 1's header carries. */
    static locationOf(id: string): string {
        return `/jobs/${id}`;
    }

    /** Absolute URL for a job id, for a client that already knows the id (the resume case). */
    static statusUrl(id: string): string {
        return `${HOST}/jobs/${id}`;
    }

    /** The submit endpoint's absolute URL. */
    static get submitUrl(): string {
        return `${HOST}/jobs`;
    }

    adapter(): Adapter {
        return async (req: AdapterRequest): Promise<AdapterResponse> => {
            const path = new URL(req.url).pathname;
            const method = req.method.toUpperCase();
            const res = this.route(method, path);
            this.hits.push({
                method,
                path,
                status: res.status,
                at: this.clock.now(),
            });
            return res;
        };
    }

    private route(method: string, path: string): AdapterResponse {
        if (method === 'POST' && path === '/jobs') return this.submit();
        if (method === 'GET' && path.startsWith('/jobs/'))
            return this.status(path.slice('/jobs/'.length));
        if (method === 'GET' && path.startsWith('/results/'))
            return this.result(path.slice('/results/'.length));
        return {
            status: 404,
            headers: {},
            body: { message: `no route ${path}` },
        };
    }

    // Step 1 — 202 Accepted. The body deliberately carries NOTHING useful: the only place the job
    // id appears is the `Location` HEADER, which is what makes this scenario's first hop hard.
    private submit(): AdapterResponse {
        const id = `job-${this.nextId++}`;
        this.jobs.set(id, { id, pollsSeen: 0, resultFetches: 0 });
        return {
            status: 202,
            headers: {
                location: FakeJobApi.locationOf(id),
                ...(this.retryAfter === undefined
                    ? {}
                    : { 'retry-after': this.retryAfter }),
            },
            body: {},
        };
    }

    // Step 2 — always HTTP 200. `InProgress` for the first N polls, then the terminal state.
    private status(id: string): AdapterResponse {
        const job = this.jobs.get(id);
        if (!job)
            return {
                status: 404,
                headers: {},
                body: { message: `unknown job ${id}` },
            };
        job.pollsSeen += 1;
        const done = job.pollsSeen > this.inProgressPolls;
        if (!done)
            return {
                status: 200,
                headers:
                    this.retryAfter === undefined
                        ? {}
                        : { 'retry-after': this.retryAfter },
                body: {
                    id,
                    state: 'InProgress',
                } satisfies JobStatus,
            };
        return {
            status: 200,
            headers: {},
            body:
                this.terminal === 'JobComplete'
                    ? ({
                          id,
                          state: 'JobComplete',
                          resultUrl: `${HOST}/results/${id}`,
                      } satisfies JobStatus)
                    : ({
                          id,
                          state: 'Failed',
                          errorMessage: 'InvalidBatch : Field name not found',
                      } satisfies JobStatus),
        };
    }

    // Step 3 — SINGLE-USE. The pre-signed link expires on first successful fetch; every later
    // fetch is a permanent 404 that a naive `retry` will happily attempt three times.
    private result(id: string): AdapterResponse {
        const job = this.jobs.get(id);
        if (!job)
            return {
                status: 404,
                headers: {},
                body: { message: `unknown result ${id}` },
            };
        job.resultFetches += 1;
        if (job.resultFetches > 1)
            return {
                status: 404,
                headers: {},
                body: { message: 'link expired' },
            };
        return { status: 200, headers: {}, body: this.payload };
    }
}

/** Read `state` off a job-status body. */
export const stateOf = (body: unknown): JobStatus['state'] | undefined =>
    (body as JobStatus | null | undefined)?.state;

/** Read `resultUrl` off a job-status body. */
export const resultUrlOf = (body: unknown): string | undefined =>
    (body as JobStatus | null | undefined)?.resultUrl;

/** Read `errorMessage` off a job-status body. */
export const errorMessageOf = (body: unknown): string | undefined =>
    (body as JobStatus | null | undefined)?.errorMessage;
