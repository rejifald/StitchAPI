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

// ── Nested envelopes and inline fragments: EPC covers them only PARTLY ──────
// These are checked against their DECLARED types (`AtLeastOne<WireOptions>`,
// `Partial<StitchConfig> | Stitch`) rather than against the inferred `C`, so freshness survives and
// excess-property checking fires — but only in the shape below. `AtLeastOne<T>` is a UNION over its
// keys, and a literal that selects one arm carries its excess keys along unreported; what rejects
// these two is that they match NO arm at all, which needs the unknown key to stand ALONE. Add one
// valid sibling and the same typo sails through — pinned as a residual limit at the end of the file.
// Partial cover is still cover, and it is the reason `NoUnknownConfigKeys` deliberately does NOT
// walk `Layers<C>`, which keeps its `tsc` cost to one `keyof` and one `Exclude` per call site.
expectError(stitch({ path: '/things', wire: { bogusNested: 1 } }));
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

// ── RESIDUAL LIMIT: a nested key WITH a valid sibling is unguarded ──────────
// The counterpart to the EPC block above. `NoUnknownConfigKeys` reads `keyof C`, so it sees
// `wire`/`timeout`/`retry` but never their contents, and the `AtLeastOne` union stops reporting
// excess the moment a real key selects an arm. So these typos are silently dead config — the shape
// every real call site has, since nobody authors an envelope holding only a typo. Deliberate for the
// same reason as the `Layers<C>` walk, hence NOT `expectError`.
stitch({ path: '/things', wire: { array: 'repeat', bogusNested: 1 } });
stitch({ path: '/things', retry: { attempts: 3, totallyBogusRetryKey: true } });

// Which is why RENAMING an envelope key needs a tombstone to fail loudly. `timeout.perAttempt` is
// declared as an unsatisfiable `ConfigError`, so the pre-rename spelling is rejected BY NAME in the
// shape that actually leaks — next to the `total` that real call sites carry — instead of compiling
// and quietly dropping the per-attempt bound.
expectError(
    stitch({ path: '/things', timeout: { total: '10s', perAttempt: '3s' } }),
);
expectError(stitch({ path: '/things', timeout: { perAttempt: '3s' } }));

// Positive controls: the new spelling authors cleanly, alone and alongside `total`.
stitch({ path: '/things', timeout: { each: '3s' } });
stitch({ path: '/things', timeout: { total: '10s', each: '3s' } });
