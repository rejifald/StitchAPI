// The canary payload, the fake vendor, and the capture rigs every claim in this directory shares.
//
// THE METHOD. The response body carries seven sentinels — literal strings that appear nowhere else
// in the process. Each destination (an event, a sink's file, a captured stderr buffer, a store
// write, an `.inspect()` wrapper) is reduced to BYTES and scanned for each sentinel. A row of the
// C1 table is therefore a measurement of what a destination actually holds, never a summary of what
// the source code appears to promise.
//
// The seven are chosen to break each of the field's four named workarounds in turn:
//
//   nm  a name           — no denylist has ever contained "name"
//   em  an email         — the one field every denylist DOES contain
//   ssn an SSN           — the one field every compliance doc names
//   nst a NESTED mail    — `profile.contact.mail`: a flat denylist misses it
//   txt a FREE-TEXT mail — inside prose: a key-based redactor cannot see it at all
//   arr an ARRAY-element mail — `contacts[1].email`: needs a walker, not a `delete`
//   ren a RENAMED key    — `primaryContactMail`: the "vendor added a field" case, today
//
// Everything here is offline: the transport is a fake in-memory `Adapter`, and the only file
// written is a JSONL trace under a `mkdtemp` directory that each script deletes.
import { memoryStore } from '../../../../packages/core/src/index';
import { fileSink } from '../../../../packages/core/src/trace';
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    StitchEvent,
    StitchStore,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';
import type { Sentinel } from './harness';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- the sentinels ---------------------------------------------------------

export const NAME = 'Wilhelmina Ashcombe';
export const EMAIL = 'w.ashcombe@example.test';
export const SSN = '078-05-1120';
export const NESTED = 'nested-canary@example.test';
export const FREETEXT = 'freetext-canary@example.test';
export const ARRAY = 'array-canary@example.test';
export const RENAMED = 'renamed-canary@example.test';
/**
 * An EIGHTH sentinel, used only by {@link bulkyCanary} and never by the main table: it sits past
 * the trace sink's default 2048-character cap. Kept out of {@link SENTINELS} so its absence measures
 * the cap and nothing else — sharing a literal with an early field would have made a truncation
 * measurement read as a survival.
 */
export const LATE = 'late-canary@example.test';

export const SENTINELS: readonly Sentinel[] = [
    { code: 'nm', value: NAME, at: 'customer.name' },
    { code: 'em', value: EMAIL, at: 'customer.email' },
    { code: 'ssn', value: SSN, at: 'customer.ssn' },
    { code: 'nst', value: NESTED, at: 'profile.contact.mail' },
    { code: 'txt', value: FREETEXT, at: 'note (free text)' },
    { code: 'arr', value: ARRAY, at: 'contacts[1].email' },
    { code: 'ren', value: RENAMED, at: 'primaryContactMail' },
];

// ---- the credential sentinels (C4) -----------------------------------------
// Distinct from the PII set so one scan can tell a credential leak from a customer-data leak. None
// of these literals contains a secret-looking KEY name — the denylist matches keys, never values,
// so a value that happened to spell `token` would make the measurement meaningless.

export const BEARER_TOKEN = 'canary-bearer-9RKQ4W';
export const QUERY_KEY = 'canary-apikey-4WZT1M';
export const COOKIE_VALUE = 'canary-cookie-1MPD7X';

export const CREDENTIALS: readonly Sentinel[] = [
    { code: 'bea', value: BEARER_TOKEN, at: 'Authorization: Bearer …' },
    { code: 'qry', value: QUERY_KEY, at: '?api_key= (url + query)' },
    { code: 'ckl', value: COOKIE_VALUE, at: 'Cookie: sid=…' },
];

// ---- the payload -----------------------------------------------------------

/** The vendor's customer record. A fresh object each call — nothing is shared between runs. */
export function canary(): Record<string, unknown> {
    return {
        id: 'cus_7Q2',
        plan: 'enterprise',
        name: NAME,
        email: EMAIL,
        ssn: SSN,
        primaryContactMail: RENAMED,
        note: `Customer asked us to reach them at ${FREETEXT} instead of the address on file.`,
        profile: {
            locale: 'en-GB',
            contact: { mail: NESTED, phone: '+44 20 7946 0958' },
        },
        contacts: [
            { label: 'work', email: 'desk@example.test' },
            { label: 'home', email: ARRAY },
        ],
    };
}

/**
 * The same record padded past the trace sink's default 2048-character body cap, with a sentinel
 * DELIBERATELY placed after the padding. Truncation is not redaction, and this is what proves it:
 * the sentinels before the cap survive into the `preview`, the one after it does not.
 */
export function bulkyCanary(): Record<string, unknown> {
    const base = canary();
    return {
        ...base,
        // ~2.4 KB of filler between the early sentinels and the last one.
        history: Array.from({ length: 40 }, (_, i) => ({
            at: `2026-0${(i % 9) + 1}-01T00:00:00Z`,
            event: 'plan.renewed',
            actor: 'billing-service',
            detail: `renewal #${i} processed against the enterprise plan`,
        })),
        // Placed last on purpose: past the default cap, so its absence measures the cap, not a policy.
        lateContact: { mail: LATE },
    };
}

export const BASE = 'https://vendor.example.test';

// ---- the fake vendor -------------------------------------------------------

export interface FakeVendor extends Adapter {
    /** Every request the transport saw, headers cloned at call time. */
    seen(): readonly AdapterRequest[];
    count(): number;
}

/** An in-memory `Adapter` that answers with a fixed body/status. No network, no `fetch`. */
export function fakeVendor(
    opts: {
        body?: unknown;
        status?: number;
        headers?: Record<string, string>;
    } = {},
): FakeVendor {
    const seen: AdapterRequest[] = [];
    const fn = (async (req: AdapterRequest): Promise<AdapterResponse> => {
        seen.push({ ...req, headers: { ...req.headers } });
        return {
            status: opts.status ?? 200,
            headers: opts.headers ?? { 'content-type': 'application/json' },
            body:
                opts.body === undefined ? canary() : structuredClone(opts.body),
            url: req.url,
        };
    }) as FakeVendor;
    fn.seen = () => seen;
    fn.count = () => seen.length;
    return fn;
}

// ---- capture rigs ----------------------------------------------------------

/** A `TraceSink` that keeps every RAW event — the event spine, exactly as the engine emitted it. */
export function collectingSink(): TraceSink & {
    events(): readonly StitchEvent[];
    types(): string[];
    of(type: string): StitchEvent | undefined;
    /** `JSON.stringify` of the whole spine — what a naive custom sink would log. */
    text(): string;
} {
    const events: StitchEvent[] = [];
    return {
        handle(event: StitchEvent, _ctx: TraceContext): void {
            events.push(event);
        },
        events: () => events,
        types: () => events.map((e) => e.type),
        of: (type: string) => events.find((e) => e.type === type),
        text: () => JSON.stringify(events),
    };
}

/**
 * Swap `process.stderr.write` for a collector — `consoleSink` writes there, so this captures the
 * exact bytes a terminal (and therefore a container log driver) would receive.
 */
export function captureStderr(): { text(): string; restore(): void } {
    const chunks: string[] = [];
    const proc = process as unknown as {
        stderr: { write: (s: string) => boolean };
    };
    const original = proc.stderr.write.bind(proc.stderr);
    proc.stderr.write = (s: string): boolean => {
        chunks.push(String(s));
        return true;
    };
    return {
        text: () => chunks.join(''),
        restore: () => {
            proc.stderr.write = original;
        },
    };
}

/** A `LoggerLike` that keeps every line — what `loggerSink` handed to pino/winston/console. */
export function captureLogger(): {
    error(m: string): void;
    warn(m: string): void;
    info(m: string): void;
    debug(m: string): void;
    lines(): readonly { level: string; message: string }[];
    text(): string;
} {
    const lines: { level: string; message: string }[] = [];
    const push =
        (level: string) =>
        (message: string): void => {
            lines.push({ level, message });
        };
    return {
        error: push('error'),
        warn: push('warn'),
        info: push('info'),
        debug: push('debug'),
        lines: () => lines,
        text: () => lines.map((l) => `${l.level} ${l.message}`).join('\n'),
    };
}

/**
 * A real `fileSink` writing into a fresh `mkdtemp` directory. `text()` reads the JSONL back — the
 * bytes that landed on disk, not a reconstruction — and `cleanup()` removes the directory.
 */
export function tempFileSink(opts?: Parameters<typeof fileSink>[1]): {
    sink: TraceSink;
    path: string;
    text(): string;
    cleanup(): void;
} {
    const dir = mkdtempSync(join(tmpdir(), 'stitch-pii-'));
    const path = join(dir, 'trace.jsonl');
    const sink = fileSink(path, opts);
    return {
        sink,
        path,
        text: () => {
            try {
                return readFileSync(path, 'utf8');
            } catch {
                return '';
            }
        },
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

/**
 * `memoryStore` with a tap on `set`. The default store holds values by reference, so "what is in
 * the cache" is not otherwise inspectable; this records the value the cache engine handed down,
 * which is the thing a Redis/file store would have serialised and persisted.
 */
export function recordingStore(): StitchStore & {
    writes(): readonly { key: string; value: unknown }[];
    /** JSON of every recorded write — the bytes a serialising store would have persisted. */
    text(): string;
} {
    const inner = memoryStore();
    const writes: { key: string; value: unknown }[] = [];
    const store = {
        ...inner,
        async set(key: string, value: unknown, ttl?: number): Promise<void> {
            writes.push({ key, value });
            await inner.set(key, value, ttl);
        },
        writes: () => writes,
        text: () => {
            try {
                return JSON.stringify(writes);
            } catch {
                return String(writes);
            }
        },
    };
    return store as StitchStore & {
        writes(): readonly { key: string; value: unknown }[];
        text(): string;
    };
}

/** Serialize anything to bytes for the scanner, surviving cycles and non-JSON values. */
export function bytesOf(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}
