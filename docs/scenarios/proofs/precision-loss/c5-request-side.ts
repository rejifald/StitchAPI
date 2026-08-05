// C5 — the REQUEST side: does a large ID survive going OUT?
//
// C1–C4 are about a value arriving wrong. This is the other direction, and it is the one that
// produces the `Unknown Channel` in the linked openclaw issue: you hold an id and you have to put
// it back in a URL or a body. Three positions, measured by capturing what the transport actually
// handed to `fetch` — the URL string and the encoded request body, not the config that produced
// them.
//
// The capture predicts one thing here: "A `bigint` in a request body is a `JSON.stringify` throw,
// not silent corruption." That is confirmed exactly. But the survey turns up a THIRD outcome the
// capture did not anticipate, and it is worse than either: a `bigint` in `params` is neither
// corrupted nor rejected — it VANISHES, expanding to the empty string and producing a request to
// the wrong URL.
//
//   pnpm exec tsx docs/scenarios/proofs/precision-loss/c5-request-side.ts
import { fetchAdapter } from '../../../../packages/core/src/http-adapter';
import { stitch } from '../../../../packages/core/src/index';
import type { Adapter } from '../../../../packages/core/src/types';
import { check, checkStr, finish, heading, note } from './harness';
import { BASE, ONE_ID_TEXT, SNOWFLAKE } from './wire';

/** What the transport actually put on the wire for one request. */
interface Sent {
    url: string;
    body: string;
    error: string;
}

/**
 * An adapter that records the URL and encoded body `fetch` was called with. Built on the real
 * `fetchAdapter`, so `encodeRequestBody` (the library's own JSON/form encoder) runs for real —
 * the recorded `body` is the literal bytes, not a re-derivation.
 */
function sendingAdapter(): { adapter: Adapter; sent: Sent[] } {
    const sent: Sent[] = [];
    const inner = fetchAdapter({
        fetch: (async (url: string, init: { body?: unknown }) => {
            sent.push({
                url: String(url),
                body: typeof init.body === 'string' ? init.body : '',
                error: '',
            });
            return new Response(ONE_ID_TEXT, {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as unknown as typeof fetch,
    });
    return { adapter: inner, sent };
}

/** Fire one request with the given config/input and report what went out (or what threw). */
async function send(
    cfg: Record<string, unknown>,
    input: Record<string, unknown>,
): Promise<Sent> {
    const { adapter, sent } = sendingAdapter();
    const call = stitch({
        name: 'send',
        baseUrl: BASE,
        adapter,
        ...cfg,
    } as never);
    const r = await call.safe(input as never);
    return (
        sent[0] ?? {
            url: '',
            body: '',
            error: r.error?.message ?? '<no request was made>',
        }
    );
}

async function main(): Promise<void> {
    heading('C5 (a) — `params`: a path parameter');
    {
        // Three spellings of "the same id", through `/v1/things/{id}`.
        const asString = await send(
            { path: '/v1/things/{id}' },
            { params: { id: SNOWFLAKE } },
        );
        checkStr(
            'a STRING param — the digits survive',
            asString.url,
            `${BASE}/v1/things/${SNOWFLAKE}`,
        );

        // A number param. Note the source literal is ALREADY the corrupted double — this is the
        // value a caller would be holding after C1, so it is the honest input.
        const asNumber = await send(
            { path: '/v1/things/{id}' },
            { params: { id: 1234567890123456789 } },
        );
        checkStr(
            'a NUMBER param — the corrupted digits, shortest-form',
            asNumber.url,
            `${BASE}/v1/things/1234567890123456800`,
        );
        note(
            'note it is 1234567890123456800, not the exact 1234567890123456768: `String(double)` picks the shortest round-tripping decimal. A third wrong id',
            '',
        );

        // And a bigint — the value a C3-repaired pipeline is holding.
        const asBigint = await send(
            { path: '/v1/things/{id}' },
            { params: { id: BigInt(SNOWFLAKE) } },
        );
        checkStr(
            'a BIGINT param — measured',
            asBigint.url,
            `${BASE}/v1/things/`,
        );
        check(
            'the id VANISHED from the URL',
            asBigint.url.includes(SNOWFLAKE),
            false,
        );
        check(
            'and the call still succeeded — no error, no event',
            asBigint.error,
            '',
        );
        note(
            '→ NOT IN THE CAPTURE, and the worst outcome of the three. `expandTemplateVar` (util.ts:392) branches on `string | number | boolean`; a bigint matches none of them and falls to the object arm, where `Object.entries(9007199254740993n)` is `[]`, so nothing is emitted. A repaired pipeline that hands its BigInt id straight back to a path parameter silently requests the COLLECTION instead of the item',
            '',
        );
    }

    heading('C5 (b) — `query`: a query-string parameter');
    {
        const asString = await send(
            { path: '/v1/things' },
            { query: { since: SNOWFLAKE } },
        );
        checkStr(
            'a STRING query param',
            asString.url,
            `${BASE}/v1/things?since=${SNOWFLAKE}`,
        );

        const asNumber = await send(
            { path: '/v1/things' },
            { query: { since: 1234567890123456789 } },
        );
        checkStr(
            'a NUMBER query param — corrupted, shortest-form',
            asNumber.url,
            `${BASE}/v1/things?since=1234567890123456800`,
        );

        const asBigint = await send(
            { path: '/v1/things' },
            { query: { since: BigInt(SNOWFLAKE) } },
        );
        checkStr(
            'a BIGINT query param — measured',
            asBigint.url,
            `${BASE}/v1/things?since=${SNOWFLAKE}`,
        );
        note(
            '→ the query path DOES handle bigint, correctly and exactly. `stringifyLeaf` (util.ts:332) lists `bigint` alongside number and boolean. So the two URL positions disagree with each other: `query` is bigint-safe, `params` drops it',
            '',
        );
    }

    heading('C5 (c) — a JSON request `body`');
    {
        const asString = await send(
            { path: '/v1/things', method: 'POST' },
            { body: { id: SNOWFLAKE } },
        );
        checkStr(
            'a STRING in the body — survives',
            asString.body,
            `{"id":"${SNOWFLAKE}"}`,
        );

        const asNumber = await send(
            { path: '/v1/things', method: 'POST' },
            { body: { id: 1234567890123456789 } },
        );
        checkStr(
            'a NUMBER in the body — the wrong digits, silently',
            asNumber.body,
            '{"id":1234567890123456800}',
        );

        const asBigint = await send(
            { path: '/v1/things', method: 'POST' },
            { body: { id: BigInt(SNOWFLAKE) } },
        );
        checkStr(
            'a BIGINT in the body — the exact throw',
            asBigint.error,
            'Do not know how to serialize a BigInt',
        );
        checkStr('and nothing went out', asBigint.url, '');
        note(
            '→ the capture is confirmed exactly here: a bigint body is a LOUD failure, and that is the good outcome. The number body is the silent one',
            '',
        );
    }

    heading('C5 (d) — a `form` request body');
    {
        // The fourth position, for completeness — `wire.body: 'form'` runs the same `flattenParams`
        // walker the query string does, so it inherits the query's bigint handling.
        const asBigint = await send(
            {
                path: '/v1/things',
                method: 'POST',
                wire: { body: 'form' },
            },
            { body: { id: BigInt(SNOWFLAKE) } },
        );
        checkStr('a BIGINT in a form body', asBigint.body, `id=${SNOWFLAKE}`);
        note(
            'so of four outbound positions, bigint works in two (query, form), throws in one (json body) and silently vanishes in one (params)',
            '',
        );
    }

    heading('C5 (e) — the round trip, end to end');
    {
        // The shape that actually bites: read an id, then use it. Measured with a plain pipeline.
        const { adapter, sent } = sendingAdapter();
        const read = stitch({
            name: 'read',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter,
        });
        const got = (await read()) as { id: number };
        const write = stitch({
            name: 'write',
            baseUrl: BASE,
            path: '/v1/things/{id}',
            adapter,
        });
        await write({ params: { id: got.id } });
        checkStr(
            'read an id, send it straight back — the URL that goes out',
            sent[1]?.url ?? '',
            `${BASE}/v1/things/1234567890123456800`,
        );
        check('and the vendor sent', SNOWFLAKE, '1234567890123456789');
        note(
            '→ this is the openclaw `Unknown Channel` shape, reproduced in eight lines: read a channel id, use it, get a 404 for an id that does not exist. Nothing in the pipeline reported anything',
            '',
        );
    }

    finish(
        'C5',
        'CONFIRMED for the body, and the survey found a THIRD outcome the capture did not anticipate. `params`: a string survives (/v1/things/1234567890123456789); a number goes out as 1234567890123456800 — the shortest-form rendering, a THIRD wrong digit string; and a BIGINT VANISHES, producing the URL https://api.snowflake.test/v1/things/ with no error and no event, because `expandTemplateVar` (util.ts:392) branches on string|number|boolean and `Object.entries(<bigint>)` is empty. `query`: string and bigint both survive EXACTLY (?since=1234567890123456789) because `stringifyLeaf` (util.ts:332) lists bigint; a number corrupts the same way. JSON `body`: a bigint throws exactly "Do not know how to serialize a BigInt" and no request is made — the capture confirmed, and the LOUD outcome. A `form` body handles bigint correctly (id=1234567890123456789), since it shares the query walker. So of four outbound positions, bigint works in two, throws in one, and silently vanishes in one — and the two URL positions disagree with each other. End to end, reading an id and handing it straight back produces a request for /v1/things/1234567890123456800: the openclaw `Unknown Channel` shape in eight lines, with nothing reported',
    );
}

void main();
