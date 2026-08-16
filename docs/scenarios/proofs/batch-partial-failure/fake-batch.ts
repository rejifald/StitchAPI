// Two fake, in-memory batch-write providers that report PER-ITEM failure inside an HTTP 200:
//
//   - {@link FakeDynamo} — DynamoDB `BatchWriteItem`: `POST /batch` with `{ RequestItems }` answers
//     `200 { Processed, UnprocessedItems }`. Optionally driven by a real WRITE-CAPACITY BUCKET
//     (AWS's actual cause of `UnprocessedItems`) refilling off the injected clock, so "retry
//     immediately and you will simply be throttled again" is a measurable property, not a slogan.
//   - {@link FakeElastic} — Elasticsearch `_bulk`: `200 { errors: true, items: [{ index: { status } }] }`
//     with a MIX of `429` (retryable) and `400` (terminal, a mapping error) per item.
//
// Both count how many times EACH INDIVIDUAL ITEM was written, so duplicate application is measured
// rather than argued about: `writeCount('a')` is 3 if the client wrote `a` three times.
//
// Everything is driven by an INJECTED {@link Clock} and nothing touches the network.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    Clock,
} from '../../../../packages/core/src/types';

/** One item in a batch. `id` is what the provider counts writes against. */
export interface BatchItem {
    id: string;
    [key: string]: unknown;
}

/** One recorded hit, as the provider saw it. */
export interface RecordedRequest {
    /** Item ids the client actually sent in THIS request — the measure of "what got replayed". */
    ids: string[];
    /** Item ids this request wrote. */
    accepted: string[];
    /** Virtual time (ms) the request arrived. */
    at: number;
}

/** Shared write-counting book-keeping. */
abstract class CountingProvider {
    /** Every hit, in order. `requests.length` IS the request count. */
    readonly requests: RecordedRequest[] = [];
    protected readonly writes = new Map<string, number>();
    protected readonly clock: Clock;

    protected constructor(clock: Clock) {
        this.clock = clock;
    }

    /** How many times this item was WRITTEN. `> 1` is a duplicate application. */
    writeCount(id: string): number {
        return this.writes.get(id) ?? 0;
    }

    /** Items written at least once, in insertion order. */
    get landed(): string[] {
        return [...this.writes.keys()];
    }

    /** Total writes across all items — `landed.length` when nothing was applied twice. */
    get totalWrites(): number {
        let n = 0;
        for (const c of this.writes.values()) n += c;
        return n;
    }

    /** Writes beyond the first for each item. **Zero is the only correct value.** */
    get duplicateWrites(): number {
        let n = 0;
        for (const c of this.writes.values()) n += c - 1;
        return n;
    }

    protected record(id: string): void {
        this.writes.set(id, (this.writes.get(id) ?? 0) + 1);
    }
}

export interface DynamoOptions {
    clock: Clock;
    /**
     * Items accepted per request, flat. Default 1 — every request lands one item and returns the
     * rest as `UnprocessedItems`, which is the smallest shape that still needs a real loop.
     */
    accepts?: number;
    /**
     * Write-capacity units refilling per second. Set it to model DynamoDB's ACTUAL cause of
     * `UnprocessedItems`: a request writes only as many items as the table has capacity for right
     * now, so a client that retries without waiting gets nothing through. Overrides `accepts`.
     */
    writeUnitsPerSec?: number;
    /** Capacity available at t=0 under `writeUnitsPerSec`. Default 2. */
    burst?: number;
}

/**
 * DynamoDB `BatchWriteItem`, shaped as the vendor shapes it: HTTP **200**, with the items that did
 * not land echoed back under `UnprocessedItems` in the same form they were sent (so a resend needs
 * no transformation — the property AWS's own docs point at).
 */
export class FakeDynamo extends CountingProvider {
    private readonly accepts: number;
    private readonly writeUnitsPerSec: number | undefined;
    private available: number;
    private lastRefillAt: number;

    constructor(opts: DynamoOptions) {
        super(opts.clock);
        this.accepts = opts.accepts ?? 1;
        this.writeUnitsPerSec = opts.writeUnitsPerSec;
        this.available = opts.burst ?? 2;
        this.lastRefillAt = opts.clock.now();
    }

    private capacityNow(): number {
        if (this.writeUnitsPerSec === undefined) return this.accepts;
        const nowMs = this.clock.now();
        const elapsedSec = (nowMs - this.lastRefillAt) / 1000;
        this.lastRefillAt = nowMs;
        if (elapsedSec > 0)
            this.available += elapsedSec * this.writeUnitsPerSec;
        return Math.floor(this.available);
    }

    adapter(): Adapter {
        return async (req: AdapterRequest): Promise<AdapterResponse> => {
            const items =
                (req.body as { RequestItems?: BatchItem[] } | undefined)
                    ?.RequestItems ?? [];
            const room = this.capacityNow();
            const accepted = items.slice(0, Math.max(0, room));
            const unprocessed = items.slice(accepted.length);
            if (this.writeUnitsPerSec !== undefined)
                this.available -= accepted.length;
            for (const item of accepted) this.record(item.id);
            this.requests.push({
                ids: items.map((i) => i.id),
                accepted: accepted.map((i) => i.id),
                at: this.clock.now(),
            });
            // THE TRAP: a partial failure is a 200. Nothing in the status line says anything failed.
            return {
                status: 200,
                headers: {},
                body: { Processed: accepted, UnprocessedItems: unprocessed },
            };
        };
    }
}

export interface ElasticOptions {
    clock: Clock;
    /** Ids that always answer `400` — a mapping error. Retrying one is a hang, not a fix. */
    terminal?: string[];
    /** Non-terminal docs accepted per request; the rest answer `429`. Default 1. */
    accepts?: number;
}

/** One entry of an Elasticsearch `_bulk` response's `items` array. */
export interface BulkItem {
    index: {
        _id: string;
        status: number;
        error?: { type: string; reason: string };
    };
}

/**
 * Elasticsearch `_bulk`, shaped as the vendor shapes it: HTTP **200** with `errors: true` and a
 * PER-ITEM `status` — some `429` (the queue is full: retry it), some `400` (the document does not
 * fit the mapping: retrying it forever is the hang elasticsearch-py#1004 is about).
 *
 * The request body here is a plain `{ operations: [...] }` rather than the real NDJSON action/doc
 * pairs: the framing is not what this scenario is about, and JSON keeps the proof about the loop.
 */
export class FakeElastic extends CountingProvider {
    private readonly terminal: Set<string>;
    private readonly accepts: number;

    constructor(opts: ElasticOptions) {
        super(opts.clock);
        this.terminal = new Set(opts.terminal ?? []);
        this.accepts = opts.accepts ?? 1;
    }

    adapter(): Adapter {
        return async (req: AdapterRequest): Promise<AdapterResponse> => {
            const docs =
                (req.body as { operations?: BatchItem[] } | undefined)
                    ?.operations ?? [];
            const accepted: string[] = [];
            let room = this.accepts;
            const items: BulkItem[] = docs.map((doc) => {
                if (this.terminal.has(doc.id))
                    return {
                        index: {
                            _id: doc.id,
                            status: 400,
                            error: {
                                type: 'mapper_parsing_exception',
                                reason: `failed to parse field [ts] of type [date] in document [${doc.id}]`,
                            },
                        },
                    };
                if (room > 0) {
                    room--;
                    accepted.push(doc.id);
                    this.record(doc.id);
                    return { index: { _id: doc.id, status: 201 } };
                }
                return {
                    index: {
                        _id: doc.id,
                        status: 429,
                        error: {
                            type: 'es_rejected_execution_exception',
                            reason: 'rejected execution of bulk request',
                        },
                    },
                };
            });
            this.requests.push({
                ids: docs.map((d) => d.id),
                accepted,
                at: this.clock.now(),
            });
            return {
                status: 200,
                headers: {},
                body: {
                    took: 1,
                    errors: items.some((i) => i.index.status >= 400),
                    items,
                },
            };
        };
    }
}

/** `{ RequestItems: [...] }` for `ids` — the request body both providers' loops start from. */
export const dynamoBody = (ids: string[]): { RequestItems: BatchItem[] } => ({
    RequestItems: ids.map((id) => ({ id, payload: `row-${id}` })),
});

/** `{ operations: [...] }` for `ids`. */
export const bulkBody = (ids: string[]): { operations: BatchItem[] } => ({
    operations: ids.map((id) => ({ id, payload: `doc-${id}` })),
});

/** Read `UnprocessedItems` off a DynamoDB-shaped 200 body. */
export const unprocessedOf = (body: unknown): BatchItem[] =>
    (body as { UnprocessedItems?: BatchItem[] } | null | undefined)
        ?.UnprocessedItems ?? [];

/** Read `Processed` off a DynamoDB-shaped 200 body. */
export const processedOf = (body: unknown): BatchItem[] =>
    (body as { Processed?: BatchItem[] } | null | undefined)?.Processed ?? [];

/** Read the `items` array off an Elasticsearch-shaped `_bulk` body. */
export const bulkItemsOf = (body: unknown): BulkItem[] =>
    (body as { items?: BulkItem[] } | null | undefined)?.items ?? [];
