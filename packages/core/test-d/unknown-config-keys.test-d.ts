// A config key that is not a `StitchConfig` slot must not typecheck. Without a guard it does, and
// the reason is subtle enough to be worth stating: the authoring overloads infer `const C` from the
// config argument so `InputOf` can read path-template vars off the literal, and that inference is
// exactly what SUPPRESSES TypeScript's excess-property check — the literal is compared against a `C`
// just inferred from it, so nothing is ever "excess". The `C extends Partial<StitchConfig>`
// constraint is then checked by ordinary assignability, which ignores freshness.
//
// The consequence is what this file exists to prevent: REMOVING or RENAMING a config slot leaves
// every call site that still authors the old spelling typechecking silently. That is the trap #591
// hit (2 files found by typechecking, 30 by running the suite), the reason `LlmOptions`' parameter is
// deliberately non-generic, and the migration hazard flagged in #600's review notes for folding
// `acceptStatus` into `verdict`. `NoUnknownConfigKeys` closes it WITHOUT giving up `const C`
// inference, so the positive controls below assert that inference still works.
//
// Every authoring entry point is covered (CONTRACT.md P16 — a guard binds every surface that authors
// a stitch): `stitch`, `seam.stitch`, `seam.graphql`, `graphql`, `download`, `sse`, `stream`, and the
// `.bind(...)` binders — plus the three other option bags reached through an inferred generic:
// `LlmOptions` (`llm`), `RequestOptions`/`EmitOptions`/`EventsOptions` (`postmessage`), and
// `StitchInput` (`Stitch.with`). All bind `NoUnknownKeys` to their own allowed set.
//
// One nuance the cases below depend on: TypeScript's WEAK-TYPE detection gives partial cover for
// free, because these option bags are all-optional — a literal sharing NO property with the target
// is rejected regardless of freshness. That is why every `expectError` here includes a VALID sibling
// key: without one the rejection would be attributable to weak-type detection rather than to the
// guard, and the guard is what covers the case that actually leaked.
import { seam, stitch } from '../src';
import type { Stitch, StitchConfig } from '../src';
import { download } from '../src/download';
import { anthropic, llm } from '../src/llm';
import type { PostMessageChannel } from '../src/postmessage';
import { sse } from '../src/sse';
import { graphql } from '../src/stitch';
import { stream } from '../src/stream';

import { expectError, expectType } from 'tsd';

const URL_ = 'https://api.example.com/things';

// ── Positive controls: every real slot still authors cleanly ─────────────────
// If the guard were over-eager these would fail, and each rejection below would be unattributable.
stitch({ path: '/things', timeout: 500, retry: 2, headers: { a: '1' } });
stitch({ url: URL_, wire: { array: 'repeat' }, cache: '1m' });
stitch({ path: '/things', verdict: { accept: [404] } });
stitch({ extends: [{ baseUrl: 'https://api.example.com' }], path: '/things' });

// ── Illegal: a key that is not a `StitchConfig` slot ────────────────────────
expectError(stitch({ path: '/things', totallyMadeUpProperty: 123 }));

// A TYPO of a real slot is the same error, and the common one.
expectError(stitch({ path: '/things', timeut: 500 }));
expectError(stitch({ path: '/things', retires: 2 }));

// The #600 migration case, now the REAL one: ADR 0022 folded `acceptStatus` into the `verdict`
// envelope (legal spelling above), leaving the flat slot dead. That rename shipped documented as
// having NO compile-time net — the `const C extends Partial<StitchConfig>` generic suppresses
// excess-property checking, so a stale `acceptStatus:` was silently ignored and the status quietly
// started throwing again. This guard reads `keyof C` instead, so it catches exactly that, and the
// migration stops depending on a repo-wide grep.
expectError(stitch({ path: '/things', acceptStatus: [404] }));

// ── STRONGER than excess-property checking: a hoisted config is caught too ──
// EPC only fires on a FRESH literal, so lifting the same object into a `const` escapes it entirely.
// The guard reads `keyof C` off the binding's inferred type, so the hoisted spelling is still
// rejected — this is the case that makes a rename safe repo-wide rather than only at inline sites.
const hoisted = { path: '/things', totallyMadeUpProperty: 123 };
expectError(stitch(hoisted));

// Positive control for the same shape minus the unknown key.
const hoistedOk = { path: '/things', timeout: 500 };
stitch(hoistedOk);

// ── The guard binds every authoring entry point ─────────────────────────────
const api = seam({ baseUrl: 'https://api.example.com' });

api.stitch({ path: '/things', timeout: 500 });
expectError(api.stitch({ path: '/things', totallyMadeUpProperty: 123 }));

api.graphql({ document: 'query { me { id } }' });
expectError(
    api.graphql({ document: 'query { me { id } }', totallyMadeUpProperty: 1 }),
);

graphql({ document: 'query { me { id } }' });
expectError(
    graphql({ document: 'query { me { id } }', totallyMadeUpProperty: 1 }),
);

download({ url: URL_ });
expectError(download({ url: URL_, totallyMadeUpProperty: 1 }));
expectError(download.stitch({ url: URL_, totallyMadeUpProperty: 1 }));

sse({ path: '/events' });
expectError(sse({ path: '/events', totallyMadeUpProperty: 1 }));

stream({ path: '/chunks' });
expectError(stream({ path: '/chunks', totallyMadeUpProperty: 1 }));

// The `.bind(...)` binders inherit it through their declared member type.
const boundDl = download.bind(api);
boundDl.stitch({ path: '/report.pdf' });
expectError(boundDl.stitch({ path: '/report.pdf', totallyMadeUpProperty: 1 }));

const boundSse = sse.bind(api);
boundSse.stitch({ path: '/events' });
expectError(boundSse.stitch({ path: '/events', totallyMadeUpProperty: 1 }));

const boundStream = stream.bind(api);
boundStream.stitch({ path: '/chunks' });
expectError(boundStream.stitch({ path: '/chunks', totallyMadeUpProperty: 1 }));

// ── Nested envelopes: `NoUnknownNestedKeys`, and why EPC was never covering them ──
// This block used to assert that nested envelopes "were already covered by EPC", on the reasoning
// that `wire` is checked against its DECLARED `AtLeastOne<WireOptions>` and so stays fresh. That
// reasoning was wrong, and the two cases pinning it were passing for a different reason: NEITHER
// carried a valid sibling, so both were rejected by weak-type detection (and by `AtLeastOne`, which
// an all-unknown object cannot satisfy) — exactly the attribution error the preamble above warns
// about. `const C` is inferred from the WHOLE config object, so the envelope is no longer fresh
// either; EPC is suppressed at every depth, not just at the root.
//
// Add one valid sibling and the pre-guard behaviour was total silence:
//   stitch({ circuit: { failures: 1, cooldown: '30s', totalNonsense: 1 } })   // no error
// `NoUnknownNestedKeys` closes that, naming the ENVELOPE's own type in the message so the report
// reads against the vocabulary the key was misspelled against.
expectError(stitch({ path: '/things', wire: { bogusNested: 1 } }));
expectError(
    stitch({ path: '/things', wire: { array: 'repeat', bogusNested: 1 } }),
);
expectError(
    stitch({
        path: '/things',
        circuit: { failures: 1, cooldown: '30s', totalNonsense: 1 },
    }),
);
expectError(stitch({ path: '/things', retry: { attempts: 2, nonsense: 1 } }));
expectError(
    stitch({ path: '/things', timeout: { total: '5s', perAttemptMs: 1 } }),
);
expectError(stitch({ path: '/things', cache: { ttl: '1m', bogusCache: 1 } }));
expectError(
    stitch({ path: '/things', verdict: { accept: [404], bogusVerdict: 1 } }),
);

// Two levels down — the depth CONTRACT.md §6 actually renamed at (`baseMs`→`base`,
// `maxMs`→`max` inside `retry.backoff`, P4/P17). A one-level walk would have left those silent.
expectError(
    stitch({
        path: '/things',
        retry: { attempts: 2, backoff: { curve: 'fixed', baseMs: 100 } },
    }),
);
expectError(
    stitch({
        path: '/things',
        wire: { body: 'multipart', multipart: { nesting: 'dot', bogus: 1 } },
    }),
);
expectError(
    stitch({ path: '/things', sse: { reconnect: { attempts: 2, bogus: 1 } } }),
);
expectError(
    stitch({
        path: '/things',
        stream: { decode: 'lines', buffer: { chars: 10, bogus: 1 } },
    }),
);

// HOISTED, one level down — the case EPC could never have caught even in principle, and the one
// that makes a nested rename safe repo-wide rather than only at inline call sites.
const hoistedNested = {
    path: '/things',
    circuit: { failures: 1, cooldown: '30s', totalNonsense: 1 },
};
expectError(stitch(hoistedNested));

// Positive controls — every scalar/positional shorthand must survive the walk. A guard that read
// `keyof` on these would report `circuit: [5, '30s']` as 30-odd unknown array keys, and reject the
// `retry: 3` / `stream: 'ndjson'` / `sse: true` spellings outright (P12/P13/P15).
stitch({ path: '/things', circuit: [5, '30s'] });
stitch({ path: '/things', retry: 3 });
stitch({ path: '/things', timeout: '5s' });
stitch({ path: '/things', throttle: '2/s' });
stitch({ path: '/things', stream: 'ndjson' });
stitch({ path: '/things', sse: true });
stitch({ path: '/things', cache: '1m' });
stitch({ path: '/things', retry: { attempts: 2, backoff: 'fixed' } });
stitch({ path: '/things', wire: { body: 'multipart', multipart: 'dot' } });
stitch({ path: '/things', hooks: { onRequest: () => {} } });
stitch({ path: '/things', paginate: { next: () => undefined, pages: 3 } });

// And a FOREIGN object in a slot the walk must not descend into: `output` takes a `SchemaLike`,
// whose Zod arm is the phantom `{ _output: unknown }`. A schema carries dozens of keys beyond it,
// so a walk derived from `StitchConfig[K]` rather than from the house-envelope table would report
// `safeParse` as a misspelling and break every config that validates anything.
stitch({
    path: '/things',
    output: (v: unknown): v is string => typeof v === 'string',
});
stitch({ path: '/things', input: { body: (v: unknown) => v != null } });

// The nested guard binds every authoring surface, not just `stitch`.
expectError(
    api.stitch({ path: '/things', retry: { attempts: 2, nonsense: 1 } }),
);
expectError(sse({ path: '/events', retry: { attempts: 2, nonsense: 1 } }));
expectError(stream({ path: '/chunks', retry: { attempts: 2, nonsense: 1 } }));
expectError(download({ url: URL_, retry: { attempts: 2, nonsense: 1 } }));
expectError(
    llm({
        provider: anthropic,
        model: 'm',
        retry: { attempts: 2, nonsense: 1 },
    }),
);

// ── RESIDUAL LIMIT (fail-open): `extends` fragments are still the `Layers` axis ──
// The guard reads the literal's OWN slots, so a fragment's keys — at any depth — are not its
// business. An inline fragment carrying a valid sibling is therefore NOT rejected: `C` is inferred
// from the whole config, so the fragment is not fresh either, and weak-type detection is satisfied
// by the real key. Deliberate, hence not `expectError` — catching it needs the `Layers<C>` walk
// `NoUnknownConfigKeys`'s JSDoc declines, and the fragment's declaration site is where it belongs.
stitch({
    path: '/things',
    extends: [{ baseUrl: 'https://api.example.com', bogusInFragment: 1 }],
});
expectError(stitch({ path: '/things', extends: [{ bogusInFragment: 1 }] }));

// A BOUND fragment carrying ONLY unknown keys is rejected too, though by a third mechanism again —
// TypeScript's weak-type detection. `Partial<StitchConfig>` is all-optional, so a value sharing NO
// property with it is unassignable regardless of freshness.
const allBogus = { bogusInFragment: 1 };
expectError(stitch({ path: '/things', extends: [allBogus] }));

// ── RESIDUAL LIMIT (fail-open): a BOUND fragment mixing real and unknown keys ──
// This is the one hole. The binding is not fresh, so EPC does not fire at the `extends` position; the
// real `baseUrl` satisfies weak-type detection, so that does not fire either; and the guard reads
// only the literal's own keys. Accepted rather than resolved: catching it needs a `Layers<C>` walk on
// every call site, and the fragment's own declaration site is the natural place to type it
// (`const frag: Partial<StitchConfig> = { … }` gets EPC there). Deliberate, so NOT `expectError`.
const mixedFragment = {
    baseUrl: 'https://api.example.com',
    bogusInFragment: 1,
};
stitch({ path: '/things', extends: [mixedFragment] });

// ── RESIDUAL LIMIT (fail-open by design): an already-typed config ───────────
// A value whose static type is `Partial<StitchConfig>` has no unknown keys left to find; its
// declaration site is where the spelling was checked, and that site had EPC.
declare const typed: Partial<StitchConfig>;
stitch(typed);

// The loose `string | Partial<StitchConfig>` escape hatch is unchanged — the guard's `C extends
// string` arm distributes to `unknown` on both arms of the union.
declare const loose: string | Partial<StitchConfig>;
expectType<Stitch<unknown>>(stitch(loose));
expectType<Stitch<unknown>>(stitch('/plain'));

// An index-signature config makes every key unknown, so it is rejected. It never satisfied
// `Partial<StitchConfig>` usefully; pinned so the behaviour is deliberate rather than latent.
declare const anyKeys: Record<string, unknown>;
expectError(stitch(anyKeys));

// ── `const C` inference survives the guard ──────────────────────────────────
// The whole point of the generic is `InputOf<C>` reading the RFC 6570 template off the literal. If
// the guard's intersection had collapsed the inferring overload into the loose one, `params` would
// stop being required and this would silently pass.
const byId = stitch({ url: 'https://api.example.com/things/{id}' });
expectError(byId());
byId({ params: { id: 't-1' } });

// And the result type is still inferred from `output`, not widened by the intersection.
const plain = stitch({ path: '/things' });
expectType<Stitch<unknown>>(plain);

// ── `llm` — `LlmOptions`, and the trade it no longer pays ───────────────────
// `llmStitch`'s parameter used to be NON-GENERIC on purpose: that was the only way to keep
// excess-property checking, and it is what rejected the removed `maxTokens` spelling (P4). The cost
// was total: no `const C`, so no `InputOf<C>` call-argument inference at all. Now that the guard
// supplies the rejection, the parameter is generic and gets BOTH.
llm({ provider: anthropic, model: 'claude-opus-4-8', tokens: 10, retry: 2 });
expectError(llm({ provider: anthropic, model: 'm', bogusLlmKey: 1 }));

// The P4 case the non-generic parameter existed to catch — still caught, now by the guard.
expectError(llm({ provider: anthropic, maxTokens: 10 }));

// What the generic BUYS: a path template now requires its `params`, which was impossible before.
const versioned = llm({
    provider: anthropic,
    url: 'https://llm.example.com/{version}/messages',
});
expectError(versioned());
versioned({ params: { version: 'v1' } });

// `llm.stitch` is the same function as the callable, and the seam binder declares the same member.
expectError(llm.stitch({ provider: anthropic, model: 'm', bogusLlmKey: 1 }));
const boundLlm = llm.bind(api);
boundLlm.stitch({ provider: anthropic, model: 'm' });
expectError(
    boundLlm.stitch({ provider: anthropic, model: 'm', bogusLlmKey: 1 }),
);

// ── RESIDUAL LIMIT: `Stitch.with(partial)` is deliberately UNGUARDED ────────
// Same bug class — `const P extends Partial<TIn>` suppresses EPC, so a typo'd input key binds
// nothing — but this is the only signature whose RETURN type reads `keyof P`, and
// `keyof (P & NoUnknownKeys<P, …>)` does not reduce while `P` is unresolved. Intersecting the
// parameter rewrites `RelaxKeys<TIn, keyof P>` into a deferred union that `tsup`'s declaration
// rollup emits differently than source, so `lib`'s `Stitch` stops matching `src`'s and every
// `S extends Stitch<unknown>` constraint in the package breaks. The F-bounded spelling that would
// keep the parameter bare is a circular constraint (TS2313). Guarding it would degrade the public
// `Stitch` type for every consumer, so it stays open — deliberate, hence NOT `expectError`.
const withable = stitch({ path: '/things/{id}' });
withable.with({ params: { id: 't-1' } });
withable.with({ params: { id: 't-1' }, parms: 2 });

// Weak-type detection still covers the no-valid-sibling case here, for free.
expectError(withable.with({ totallyBogus: 2 }));

// ── `postmessage` — RequestOptions / EmitOptions / EventsOptions ────────────
declare const ch: PostMessageChannel;

ch.request('ping', { timeout: 100, reply: 'pong' });
expectError(ch.request('ping', { timeout: 100, bogusPmKey: 1 }));

ch.emit('fire', { retry: 2 });
expectError(ch.emit('fire', { retry: 2, bogusPmKey: 1 }));

ch.events('tick', { retry: 2 });
expectError(ch.events('tick', { retry: 2, bogusPmKey: 1 }));

// Each option bag names ITS OWN type in the message, so the three are not interchangeable: `reply`
// belongs to `RequestOptions` only, and authoring it on `emit`/`events` is dead config.
expectError(ch.emit('fire', { retry: 2, reply: 'pong' }));
expectError(ch.events('tick', { retry: 2, reply: 'pong' }));

// The three bags embed `Partial<Omit<StitchConfig, …>>`, so they carry the same house envelopes and
// take the nested guard too.
expectError(ch.request('ping', { retry: { attempts: 2, nonsense: 1 } }));
