// C7 — weak validators. `W/"v1"` and `"v1"` are different strings, `If-None-Match` is specified to
// compare WEAKLY (RFC 9110 §8.8.3.2), and a client that normalises or strips the `W/` prefix breaks
// revalidation against a compliant server — or, worse, matches where it should not.
//
// The measurement is byte-exactness end to end: what the server minted, what the client stored, and
// what came back on the wire. It is taken twice — once through the fake adapter that every other
// claim uses, and once through the REAL `fetchAdapter` with an injected `fetch`, because header
// mangling would live in the transport if it lived anywhere.
//
// StitchAPI has no ETag code at all (`grep -r 'If-None-Match\|304' packages/core/src` finds nothing;
// the sole `ETag` mention is fingerprint.ts:53, a comment about strong/weak SCHEMA fingerprints).
// Headers are a plain `Record<string, string>` merged at engine.ts:232 and handed to the transport
// untouched. That absence is exactly why this passes.
//
//   pnpm exec tsx docs/scenarios/proofs/conditional-requests-304/c7-weak-validators.ts
import { fetchAdapter, stitch } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeEtagApi } from './fake-etag-api';
import { check, checkSeq, finish, heading, note } from './harness';

/** The `execute` revalidator, parameterised only by the transport. */
function revalidating(transport: ReturnType<FakeEtagApi['adapter']>): Surface {
    const store = new Map<string, { etag: string; body: unknown }>();
    return {
        id: 'http+revalidate',
        execute: async (req) => {
            const key = `${req.method} ${req.url}`;
            const entry = store.get(key);
            if (entry) req.headers['If-None-Match'] = entry.etag;
            const res = await transport(req);
            if (res.status === 304 && entry)
                return { ...res, body: entry.body };
            const etag = res.headers['etag'];
            if (res.status === 200 && etag !== undefined)
                store.set(key, { etag, body: res.body });
            return res;
        },
    };
}

async function main(): Promise<void> {
    heading('C7 — does `W/"v1"` survive the round trip byte-exact?');

    // ── (a) a weak-validator server, end to end ───────────────────────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock, weak: true });
        const issues = stitch({
            url: api.url,
            kind: revalidating(api.adapter()),
            clock,
        });
        await issues.safe({});
        const second = await issues.safe({});
        api.mutate();
        const third = await issues.safe({});
        checkSeq('(a) `If-None-Match` on the wire', api.validators, [
            '(none)',
            'W/"v1.t1"',
            'W/"v1.t1"',
        ]);
        checkSeq('(a) statuses', api.statuses, [200, 304, 200]);
        check(
            '(a) 304 poll data.version',
            (second.data as { version?: number }).version,
            1,
        );
        check(
            '(a) post-mutation data.version',
            (third.data as { version?: number }).version,
            2,
        );
        note(
            '(a) → the `W/` prefix is neither stripped nor re-quoted',
            'headers are a plain Record merged at engine.ts:232 and handed to the transport untouched',
        );
    }

    // ── (b) the strong server, for contrast — same code path, different string ────────────────
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const issues = stitch({
            url: api.url,
            kind: revalidating(api.adapter()),
            clock,
        });
        await issues.safe({});
        await issues.safe({});
        checkSeq('(b) `If-None-Match` on the wire', api.validators, [
            '(none)',
            '"v1.t1"',
        ]);
        note(
            '(b) → the client carries whatever the server minted',
            'which is the only correct policy: the tag is OPAQUE to the client',
        );
    }

    // ── (c) through the REAL `fetchAdapter`, with an injected `fetch` ─────────────────────────
    // Header mangling, if it existed, would live here — `fetchAdapter` builds a `Headers` object
    // from `req.headers` (http-adapter.ts:40, 54-61) before calling `fetch`.
    {
        const sent: string[] = [];
        const record: typeof fetch = async (_input, init) => {
            sent.push(
                new Headers(init?.headers).get('if-none-match') ?? '(none)',
            );
            return new Response(null, {
                status: 304,
                headers: { etag: 'W/"v1"', 'content-type': 'application/json' },
            });
        };
        const adapter = fetchAdapter({ fetch: record });
        const res = await adapter({
            url: 'https://api.github.example/repos/octo/hello/issues',
            method: 'GET',
            headers: { 'If-None-Match': 'W/"v1"' },
        });
        checkSeq('(c) header the transport actually sent', sent, ['W/"v1"']);
        check(
            '(c) weak ETag read back off the response',
            res.headers['etag'],
            'W/"v1"',
        );

        // A multi-tag validator list — the other shape RFC 9110 allows — also survives whole.
        const list = 'W/"v1", "v2", W/"v3"';
        await adapter({
            url: 'https://api.github.example/repos/octo/hello/issues',
            method: 'GET',
            headers: { 'If-None-Match': list },
        });
        check('(c) multi-tag list survives', sent[1], list);
    }

    // ── (d) header NAME casing is preserved too, and never normalised ─────────────────────────
    // Worth pinning: the engine merges `cfg.headers` and `input.headers` with a plain spread
    // (engine.ts:232) and does no case folding, so `if-none-match` and `If-None-Match` are two
    // DIFFERENT keys in the outgoing record. A server reads them the same way; a `delete` in a
    // hook does not.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock, weak: true });
        const seenKeys: string[][] = [];
        const issues = stitch({
            url: api.url,
            adapter: api.adapter(),
            clock,
            headers: { 'if-none-match': 'W/"v1"' },
            hooks: {
                onRequest: (ctx) => {
                    // The obvious "clear it" line, written against the OTHER casing.
                    delete ctx.req?.headers['If-None-Match'];
                    seenKeys.push(Object.keys(ctx.req?.headers ?? {}));
                },
            },
        });
        await issues.safe({});
        checkSeq(
            '(d) outgoing header keys after the delete',
            seenKeys[0] ?? [],
            ['if-none-match'],
        );
        checkSeq('(d) validator still on the wire', api.validators, ['W/"v1"']);
        note(
            '(d) → `delete headers["If-None-Match"]` does NOT remove `headers["if-none-match"]`',
            'the engine never case-folds request header names (engine.ts:232), so a hook must match the casing it set',
        );
    }

    // ── (e) the client's OPACITY is what makes weak comparison work at all ────────────────────
    // Hand the server a STRONG tag for a representation it minted a WEAK validator for. RFC 9110
    // says `If-None-Match` compares weakly, so a compliant server matches — and it can only do that
    // because the client shipped the tag it was given, unaltered, rather than "canonicalising" it.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock, weak: true });
        const issues = stitch({ url: api.url, adapter: api.adapter(), clock });
        await issues.safe({});
        // `W/"v1.t1"` minted; send the strong form of the same tag.
        await issues.safe({ headers: { 'If-None-Match': '"v1.t1"' } });
        checkSeq('(e) `If-None-Match` on the wire', api.validators, [
            '(none)',
            '"v1.t1"',
        ]);
        checkSeq(
            '(e) statuses (weak comparison matched)',
            api.statuses,
            [200, 304],
        );
        note(
            '(e) → the server decided the match, on the exact bytes the client sent',
            'any client-side normalisation would have made this comparison the client’s to get wrong',
        );
    }

    finish(
        'C7',
        'YES — byte-exact, in both directions, through both transports. A weak-validator server round-trips as `["(none)", "W/\\"v1.t1\\"", "W/\\"v1.t1\\""]` on the wire with statuses `[200,304,200]`, the 304 poll yielding version 1 and the post-mutation poll version 2; the strong server on the identical code path sends `"v1.t1"`. Through the REAL `fetchAdapter` with an injected `fetch`, the header the transport handed to `fetch` was measured as `W/"v1"` and the response ETag read back as `W/"v1"`; a multi-tag list `W/"v1", "v2", W/"v3"` also survived whole. Because the client never touches the tag, the SERVER gets to apply RFC 9110’s weak comparison: sending the strong form `"v1.t1"` for a representation whose validator was minted `W/"v1.t1"` was measured as a 304. The reason all of this works is that there is nothing to survive: StitchAPI has NO ETag/`If-None-Match`/304 code anywhere in `packages/core/src` (the only `ETag` mention is fingerprint.ts:53, a comment about SCHEMA fingerprints), and request headers are a plain `Record<string, string>` merged with a spread at engine.ts:232. That same absence has a sharp edge, measured separately: header names are never case-folded, so `delete ctx.req.headers["If-None-Match"]` does not remove a validator that was set as `"if-none-match"` — measured, the key survived the delete and `W/"v1"` still went out',
    );
}

void main();
