// Pins issue #149: drift runs on the TRANSFORM output, not the raw response body.
//
// The engine pipeline is transform → unwrap → validateOutput (engine.ts), so when a stitch
// scrapes an HTML string into a structured object via `transform`, drift validates the
// *structured* value against the schema — exactly the high-value case where a silent
// markup/selector rename must become a loud contract error.
//
// The proof is in the drift PATH: `[].score` exists only on the parsed shape, never anywhere
// in the raw HTML string. An error/missing finding on that path can only come from drift
// inspecting the transformed value.
import { drift, stitch } from '../../src';
import type { DriftFinding, StitchEvent } from '../../src';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-gap-drift-transform-${process.pid}.jsonl`,
);

let server: MockServer;

beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

// Drain a stream into every event so we can inspect drift findings and ordering.
async function collect<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
): Promise<StitchEvent<T>[]> {
    const events: StitchEvent<T>[] = [];
    for await (const ev of gen) events.push(ev);
    return events;
}

const driftFindings = (events: StitchEvent[]): DriftFinding[] =>
    events
        .filter(
            (e): e is Extract<StitchEvent, { type: 'drift' }> =>
                e.type === 'drift',
        )
        .map((e) => e.finding);

// One catalog row. The score cell's class is the selector the parser keys off — renaming it
// is the silent markup break we want drift to catch.
const row = (scoreClass: string): string =>
    `<tr class="row1">` +
    `<td class="title"><a href="/i/1">Item A</a></td>` +
    `<td class="${scoreClass}">42</td>` +
    `</tr>`;

const page = (scoreClass: string): string =>
    `<table id="catalog">${row(scoreClass)}</table>`;

// A trivial hand-rolled scraper (no cheerio dependency). The score selector is hardcoded to
// `td.score` — precisely what a markup rename (score -> rank) silently breaks: `score` is
// simply omitted from the parsed item, with no error at the HTTP layer.
function scrape(html: unknown): { items: Record<string, unknown>[] } {
    const text = String(html);
    const rows = text.split(/<tr[^>]*class="row1"[^>]*>/i).slice(1);
    const items = rows.map((chunk) => {
        const item: Record<string, unknown> = {};
        const title =
            /<td[^>]*class="title"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i.exec(
                chunk,
            );
        const score = /<td[^>]*class="score"[^>]*>\s*(\d+)\s*<\/td>/i.exec(
            chunk,
        )?.[1];
        if (title) {
            item['title'] = title[2]!.trim();
            item['link'] = title[1];
        }
        if (score !== undefined) item['score'] = Number(score);
        return item;
    });
    return { items };
}

// The structured contract the rest of the pipeline (and drift) is written for. `score` is
// REQUIRED and critical — a markup rename that drops it must be a loud error, not a silent gap.
const schema = z.array(
    z.object({
        title: z.string(),
        link: z.string().optional(),
        score: z.number(),
    }),
);

test('drift fires on the TRANSFORM output: a required scraped field renamed away is an error', async () => {
    const listings = stitch({
        baseUrl: server.url,
        path: '/catalog',
        transform: scrape, // HTML string -> { items: [...] }
        unwrap: 'items',
        // `score` is REQUIRED — losing it is a hard contract violation, validated on the
        // STRUCTURED shape (`[].score` exists only on the parsed object, not the raw HTML).
        output: drift(schema),
    });

    // Original markup: the transform yields a complete item — validates clean, no drift.
    server.route('GET', '/catalog', { body: page('score') });
    const first = await collect(listings.stream());
    expect(driftFindings(first)).toHaveLength(0);
    const firstResult = first.find((e) => e.type === 'result');
    expect(
        (firstResult as Extract<StitchEvent, { type: 'result' }>).value,
    ).toEqual([{ title: 'Item A', link: '/i/1', score: 42 }]);

    // The score cell renamed `score` -> `rank`. The scraper silently drops `score`; the HTTP
    // layer is none the wiser. Drift, validating the transformed value, must SHOUT — on a path
    // (`[].score`) that exists only on the parsed object, proving it inspected the transform
    // output, not the raw HTML body.
    server.reset();
    server.route('GET', '/catalog', { body: page('rank') });
    const second = await collect(listings.stream());
    const missing = driftFindings(second).find((f) => f.path.includes('score'));
    expect(missing?.level).toBe('error');
    expect(missing?.change).toBe('invalid');
    expect(missing?.path).toBe('[].score');

    // A required-field violation is a contract break: no `result`, the stream errors, and the
    // await path rejects (not a silent `undefined`).
    expect(second.some((e) => e.type === 'result')).toBe(false);
    expect(second.some((e) => e.type === 'error')).toBe(true);
    await expect(listings()).rejects.toThrow();
});
