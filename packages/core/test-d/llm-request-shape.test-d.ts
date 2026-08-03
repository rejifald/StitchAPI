// The `llm` surface owns how it frames a chat completion: the live surface's `buildRequest` always
// forces `method: 'POST'` and a JSON body and replaces it with `provider.buildBody(...)` (ADR 0005
// Decision 1 — a surface owns *shaping*), so either field authored on an `llm()` config is never
// read. Same class as the graphql `wire.body` guard and the download `method` one; this surface just
// fixes one of each.
//
// `wire.response` is the control throughout: `buildRequest` leaves it alone, so it is a LIVE knob
// here and must keep typechecking. A guard that rejected it would be rejecting config that is
// honoured — and since `wire.body` and `wire.response` now live in the SAME envelope, that control
// is also what proves the guard closes one member rather than the whole of `wire`.
import { seam, stitch } from '../src';
import type { Stitch } from '../src';
import { llm, openai } from '../src/llm';
import type { LlmResult } from '../src/llm';
import { llmSurface } from '../src/llm';

import { expectError, expectType } from 'tsd';

// ── Legal: an llm stitch that says nothing about the request shape ──────────
const chat = llm({ provider: openai, model: 'gpt-4o' });
expectType<Stitch<LlmResult>>(chat);

// Every other config key is unaffected — including `wire.response`, which the surface never touches.
llm({
    provider: openai,
    model: 'gpt-4o',
    wire: { response: 'json' },
    headers: { 'x-trace': '1' },
    timeout: 60_000,
    retry: 2,
});

// Other members of the same envelope are equally live.
llm({ provider: openai, model: 'gpt-4o', wire: { array: 'repeat' } });

// ── Illegal: `method` on the `llm()` preset ─────────────────────────────────
expectError(llm({ provider: openai, model: 'gpt-4o', method: 'PUT' }));

// Even the verb the surface actually sends is rejected — it is the surface's to decide.
expectError(llm({ provider: openai, model: 'gpt-4o', method: 'POST' }));

// ── Illegal: `wire.body` on the `llm()` preset ──────────────────────────────
expectError(
    llm({ provider: openai, model: 'gpt-4o', wire: { body: 'multipart' } }),
);
expectError(llm({ provider: openai, model: 'gpt-4o', wire: { body: 'form' } }));
expectError(llm({ provider: openai, model: 'gpt-4o', wire: { body: 'json' } }));

// A live sibling in the same envelope does not launder the rejected member.
expectError(
    llm({
        provider: openai,
        model: 'gpt-4o',
        wire: { body: 'form', response: 'json' },
    }),
);

// `wire.multipart` comes along for free: `MultipartOnlyOnMultipartBody` requires
// `wire.body: 'multipart'` before it is legal, and that spelling is exactly what the guard above
// rejects.
expectError(
    llm({
        provider: openai,
        model: 'gpt-4o',
        wire: { body: 'multipart', multipart: 'dot' },
    }),
);

// `llm.stitch` is the same function as the callable, so it inherits the guard.
llm.stitch({ provider: openai, model: 'gpt-4o' });
expectError(llm.stitch({ provider: openai, model: 'gpt-4o', method: 'PUT' }));

// ── The guard binds the seam-bound spelling too (CONTRACT.md P16) ───────────
const api = seam({ baseUrl: 'https://api.openai.com' });
const bound = llm.bind(api);

bound.stitch({ provider: openai, model: 'gpt-4o' });
bound.stitch({ provider: openai, model: 'gpt-4o', wire: { response: 'json' } });
expectError(bound.stitch({ provider: openai, model: 'gpt-4o', method: 'PUT' }));
expectError(
    bound.stitch({
        provider: openai,
        model: 'gpt-4o',
        wire: { body: 'form' },
    }),
);

// `llm.bind(options)` builds its own seam and must guard identically.
const owned = llm.bind({ baseUrl: 'https://api.openai.com' });
owned.stitch({ provider: openai, model: 'gpt-4o' });
expectError(owned.stitch({ provider: openai, model: 'gpt-4o', method: 'PUT' }));

// ── `stitch({ kind: llmSurface })` is deliberately NOT guarded ──────────────
// The exported `llmSurface` is only the redaction/inspection identity (ADR 0005 Decision 11) and
// carries no `buildRequest` — the overriding surface is built per stitch by `makeLlmSurface`, which
// only `llm()` reaches. So on this path `method` really is honoured, and guarding it off the `id`
// would reject config that works. This must keep typechecking.
const raw = stitch({
    url: 'https://api.openai.com/v1/chat/completions',
    kind: llmSurface,
    method: 'POST',
    wire: { body: 'json' },
});
expectType<Stitch<unknown>>(raw);

// ── NOT converted to the composed `Layers` read, deliberately ───────────────
// Its siblings walk `Layers<C>` (#597) so an enabler inherited through `extends` counts. This guard
// has no `C` to walk — the parameter is non-generic, which is what preserves the excess-property
// checking asserted below — so it intersects unconditionally. At the LITERAL level that is strictly
// stronger than a conditional: every spelling above is rejected without needing a layer scan.
//
// The cost is one fail-open, and it is the same one the composed guards list as their first
// residual limit: a violation living entirely inside a fragment is not reported. Pinned here so it
// is a decision on record rather than a surprise.
llm({
    provider: openai,
    model: 'gpt-4o',
    extends: [{ wire: { body: 'form' } }],
});

// ── Excess-property checking is preserved (P4) ──────────────────────────────
// `llm()`'s parameter is deliberately non-generic; that is what keeps a fresh object literal subject
// to excess-property checks, which is what makes the removed `maxTokens` spelling an error. A
// generic parameter — the shape the graphql/download guards need — would silently lose this.
expectError(llm({ provider: openai, model: 'gpt-4o', maxTokens: 16 }));
expectError(llm({ provider: openai, model: 'gpt-4o', notAField: true }));

// The same check reaches INTO the envelope: `wire` is a closed shape too, so the pre-`wire` flat
// spellings are excess properties now rather than silently-ignored ones.
expectError(llm({ provider: openai, model: 'gpt-4o', wire: { type: 'json' } }));
