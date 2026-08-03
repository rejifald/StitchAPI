// The `llm` surface owns how it frames a chat completion: the live surface's `buildRequest` always
// forces `method: 'POST'` and `bodyType: 'json'` and replaces the body with `provider.buildBody(...)`
// (ADR 0005 Decision 1 — a surface owns *shaping*), so either field authored on an `llm()` config is
// never read. Same class as the graphql `bodyType` guard and the download `method` one; this surface
// just fixes one of each.
//
// `responseType` is the control throughout: `buildRequest` leaves it alone, so it is a LIVE knob here
// and must keep typechecking. A guard that rejected it would be rejecting config that is honoured.
import { seam, stitch } from '../src';
import type { Stitch } from '../src';
import { llm, openai } from '../src/llm';
import type { LlmResult } from '../src/llm';
import { llmSurface } from '../src/llm';

import { expectError, expectType } from 'tsd';

// ── Legal: an llm stitch that says nothing about the request shape ──────────
const chat = llm({ provider: openai, model: 'gpt-4o' });
expectType<Stitch<LlmResult>>(chat);

// Every other config key is unaffected — including `responseType`, which the surface does not touch.
llm({
    provider: openai,
    model: 'gpt-4o',
    responseType: 'json',
    headers: { 'x-trace': '1' },
    timeout: 60_000,
    retry: 2,
});

// ── Illegal: `method` on the `llm()` preset ─────────────────────────────────
expectError(llm({ provider: openai, model: 'gpt-4o', method: 'PUT' }));

// Even the verb the surface actually sends is rejected — it is the surface's to decide.
expectError(llm({ provider: openai, model: 'gpt-4o', method: 'POST' }));

// ── Illegal: `bodyType` on the `llm()` preset ───────────────────────────────
expectError(llm({ provider: openai, model: 'gpt-4o', bodyType: 'multipart' }));
expectError(llm({ provider: openai, model: 'gpt-4o', bodyType: 'form' }));
expectError(llm({ provider: openai, model: 'gpt-4o', bodyType: 'json' }));

// `multipart` comes along for free: `MultipartOnlyOnMultipartBody` requires `bodyType: 'multipart'`
// before `multipart` is legal, and that spelling is exactly what the guard above rejects.
expectError(
    llm({
        provider: openai,
        model: 'gpt-4o',
        bodyType: 'multipart',
        multipart: 'dot',
    }),
);

// `llm.stitch` is the same function as the callable, so it inherits the guard.
llm.stitch({ provider: openai, model: 'gpt-4o' });
expectError(llm.stitch({ provider: openai, model: 'gpt-4o', method: 'PUT' }));

// ── The guard binds the seam-bound spelling too (CONTRACT.md P16) ───────────
const api = seam({ baseUrl: 'https://api.openai.com' });
const bound = llm.bind(api);

bound.stitch({ provider: openai, model: 'gpt-4o' });
bound.stitch({ provider: openai, model: 'gpt-4o', responseType: 'json' });
expectError(bound.stitch({ provider: openai, model: 'gpt-4o', method: 'PUT' }));
expectError(
    bound.stitch({ provider: openai, model: 'gpt-4o', bodyType: 'form' }),
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
    bodyType: 'json',
});
expectType<Stitch<unknown>>(raw);

// ── Excess-property checking is preserved (P4) ──────────────────────────────
// `llm()`'s parameter is deliberately non-generic; that is what keeps a fresh object literal subject
// to excess-property checks, which is what makes the removed `maxTokens` spelling an error. A
// generic parameter — the shape the graphql/download guards need — would silently lose this.
expectError(llm({ provider: openai, model: 'gpt-4o', maxTokens: 16 }));
expectError(llm({ provider: openai, model: 'gpt-4o', notAField: true }));
