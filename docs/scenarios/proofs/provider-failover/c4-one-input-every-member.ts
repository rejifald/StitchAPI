// C4 — do `any`/`race` share `all()`'s one-input-for-every-member behaviour? Two providers with
// different paths and different auth is the NORMAL case for failover, so this is not an edge: it is
// whether the combinators can address the pair at all.
//
// The answer splits cleanly along the CONFIG / INPUT line, and the capture (which only asks whether
// the behaviour is shared — it is, `runMember` at pipe.ts:75-86 builds one `memberInput` and hands
// the same object shape to every member) misses BOTH halves of what that means in practice:
//
//   • BETTER than feared: everything DECLARED on the stitch is per-member and survives intact.
//     Different origin, different path, different auth scheme, even different response shapes
//     normalised by a per-stitch `pick` — measured working, zero user code.
//   • WORSE than feared: everything passed AT CALL TIME is broadcast to every member, including
//     `headers`. A per-call `Authorization` intended for the primary was measured ARRIVING AT THE
//     BACKUP — one vendor receiving another vendor's credential, silently, with no type error.
//
//   pnpm exec tsx docs/scenarios/proofs/provider-failover/c4-one-input-every-member.ts
import { apiKey, bearer } from '../../../../packages/core/src/auth';
import { stitch } from '../../../../packages/core/src/index';
import { any, race } from '../../../../packages/core/src/pipe';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeProvider, hits, outcomeOf } from './fake-provider';
import { check, checkSeq, finish, heading, note } from './harness';
import { rig } from './providers';

async function main(): Promise<void> {
    heading('C4 — one input, two providers that are not the same endpoint');

    // ── (a) what is DECLARED per stitch survives ───────────────────────────────────────────────
    // The reassuring half, and it is worth stating plainly because the "one input" headline
    // suggests otherwise: url, path, method, static headers and `auth` are config, not input.
    {
        const { p, primary, backup } = rig();
        await any(primary, backup)({ body: { prompt: 'hi' } });

        check('(a) primary path', p.primary.calls[0]?.path, '/v1/complete');
        check('(a) backup path', p.backup.calls[0]?.path, '/generate');
        check(
            '(a) primary auth header',
            p.primary.calls[0]?.headers['authorization'],
            'Bearer pk-primary',
        );
        check(
            '(a) backup auth header',
            p.backup.calls[0]?.headers['x-api-key'],
            'sk-backup',
        );
        check(
            '(a) did the primary’s bearer leak to the backup?',
            p.backup.calls[0]?.headers['authorization'],
            undefined,
        );
        check(
            '(a) did the backup’s key leak to the primary?',
            p.primary.calls[0]?.headers['x-api-key'],
            undefined,
        );
        note(
            '(a) → different origin + path + auth scheme, no user code',
            'each member is a whole stitch, so `auth` is applied per member (engine.ts buildRequest→auth) and never crosses',
        );
    }

    // ── (b) what is PASSED is broadcast, verbatim ──────────────────────────────────────────────
    // `runMember` builds `{ ...input, signal }` once per member from the SAME input (pipe.ts:75-86)
    // — every slot (`body`, `query`, `params`, `headers`) goes to everyone.
    {
        const { p, primary, backup } = rig();
        await any(
            primary,
            backup,
        )({
            body: { model: 'primary-large', max_tokens: 100 },
            query: { stream: 'false' },
        });
        checkSeq(
            '(b) body.model received by [primary, backup]',
            [
                (p.primary.calls[0]?.body as { model: string }).model,
                (p.backup.calls[0]?.body as { model: string }).model,
            ],
            ['primary-large', 'primary-large'],
        );
        checkSeq(
            '(b) query received by [primary, backup]',
            [p.primary.calls[0]?.query, p.backup.calls[0]?.query],
            ['stream=false', 'stream=false'],
        );
        note(
            '(b) → the backup was asked for a model only the primary has',
            'two providers of the same SHAPE still take different request envelopes; the shared input cannot be shaped per member, so a `transform`-equivalent for the REQUEST is the missing seam',
        );
    }

    // ── (c) a per-call credential reaches the other vendor ─────────────────────────────────────
    // The sharp edge. Config headers merge under input headers (engine.ts:232), then `auth.apply`
    // overwrites its own header — so the primary's bearer is replaced on the PRIMARY and survives
    // on the BACKUP, whose strategy writes a different header name.
    {
        const { p, primary, backup } = rig();
        await any(
            primary,
            backup,
        )({
            body: { prompt: 'hi' },
            headers: { authorization: 'Bearer per-call-primary-jwt' },
        });
        check(
            '(c) primary saw its own strategy header',
            p.primary.calls[0]?.headers['authorization'],
            'Bearer pk-primary',
        );
        check(
            '(c) the BACKUP received the per-call bearer',
            p.backup.calls[0]?.headers['authorization'],
            'Bearer per-call-primary-jwt',
        );
        note(
            '(c) → a per-call credential is broadcast to every member',
            'the same holds for any vendor-specific per-call header (`anthropic-version`, `OpenAI-Organization`, an idempotency key minted for one vendor) — there is no per-member input slot',
        );
    }

    // ── (d) different param names: the union, and a silent hole ────────────────────────────────
    // Azure-shaped primary (`/{deployment}/complete`) against a model-in-path backup
    // (`/generate/{model}`). One input has to carry BOTH names; supply only one and the other slot
    // expands to EMPTY with no error (`expandPath`, util.ts:453-482 — RFC 6570 drops undefined).
    {
        const clock = manualClock();
        const pri = new FakeProvider({
            name: 'primary',
            clock,
            origin: 'https://primary.llm.test',
            path: '/v1/gpt-x/complete',
        });
        const bak = new FakeProvider({
            name: 'backup',
            clock,
            origin: 'https://backup.llm.test',
            path: '/generate/claude-y',
        });
        const primary = stitch({
            name: 'primary',
            url: 'https://primary.llm.test/v1/{deployment}/complete',
            method: 'POST',
            adapter: pri.adapter(),
            auth: bearer('pk-primary'),
            clock,
        });
        const backup = stitch({
            name: 'backup',
            url: 'https://backup.llm.test/generate/{model}',
            method: 'POST',
            adapter: bak.adapter(),
            auth: apiKey({
                in: 'header',
                name: 'x-api-key',
                secret: 'sk-backup',
            }),
            clock,
        });

        // The union supplied: both members address their own endpoint correctly.
        await any(
            primary,
            backup,
        )({
            params: { deployment: 'gpt-x', model: 'claude-y' },
            body: {},
        });
        checkSeq(
            '(d) union of params → paths hit',
            [pri.calls[0]?.path, bak.calls[0]?.path],
            ['/v1/gpt-x/complete', '/generate/claude-y'],
        );

        // Only the backup's name supplied: the primary's slot vanishes, silently.
        pri.reset();
        bak.reset();
        const outcome = await outcomeOf(() =>
            any(primary, backup)({ params: { model: 'claude-y' }, body: {} }),
        );
        check('(d) missing `deployment` → call outcome', outcome, 'ok');
        check(
            '(d) path the primary was actually sent',
            pri.calls[0]?.path,
            '/v1//complete',
        );
        check('(d) primary status for that path', pri.calls[0]?.status, 404);
        note(
            '(d) → a member’s missing param is not an error, it is a malformed URL',
            'the call still "succeeds" because the OTHER member answered — `any` converts a silent misconfiguration into a permanently-degraded-but-green failover',
        );
    }

    // ── (e) response normalisation IS declarable, per member ───────────────────────────────────
    // The two providers return different shapes; `pick` is per-stitch config, so the combinator's
    // output is uniform without touching the caller. The one thing in this claim that is free.
    {
        const { p, primary, backup } = rig({
            onPrimary: { pick: 'choices.0.text' },
            onBackup: { pick: 'output' },
        });
        const won = await any(primary, backup)({ body: {} });
        check('(e) normalised primary result', won, 'answer from primary');
        p.primary.respond(503);
        const failed = await any(primary, backup)({ body: {} });
        check('(e) normalised backup result', failed, 'answer from backup');
        note(
            '(e) → `pick` (engine.ts:968) runs inside each member',
            '`getPath` splits on "." and indexes arrays by string key (util.ts:311-320), so `choices.0.text` reaches into the primary’s envelope — different response vocabularies normalise with zero user code',
        );
    }

    // ── (f) `race` behaves identically — it is the same `runMember` ─────────────────────────────
    {
        const { p, primary, backup } = rig();
        await race(
            primary,
            backup,
        )({
            body: { prompt: 'hi' },
            headers: { authorization: 'Bearer per-call-primary-jwt' },
        });
        checkSeq('(f) race → [primary, backup]', hits(p), [1, 1]);
        check(
            '(f) race: backup received the per-call bearer',
            p.backup.calls[0]?.headers['authorization'],
            'Bearer per-call-primary-jwt',
        );
        note(
            '(f) → all three combinators share `runMember` (pipe.ts:75-86)',
            'so the input-broadcast behaviour is a property of the composition layer, not of `all`',
        );
    }

    finish(
        'C4',
        'SHARED, and the consequence splits along the CONFIG / INPUT line — which is the part the capture does not draw. `any` and `race` use the same `runMember` as `all` (pipe.ts:75-86, one `{ ...input, signal }` per member from one input), so everything the CALLER passes is broadcast and everything the stitch DECLARES is per-member. Declared side, working with zero user code: the pair measured `/v1/complete` + `Authorization: Bearer pk-primary` and `/generate` + `x-api-key: sk-backup`, with neither credential appearing on the other provider, and per-stitch `pick` (`choices.0.text` vs `output`) normalised two different response envelopes into one string. Passed side, and this is the sharp edge: a per-call `headers: { authorization: "Bearer per-call-primary-jwt" }` intended for the primary was measured ARRIVING AT THE BACKUP verbatim — one vendor handed another vendor’s credential, silently, with no type error — because config headers merge under input headers and each strategy only overwrites its OWN header name. The same broadcast sends the primary’s `model` to the backup, and a member whose template param was not supplied is not an error: `/v1/{deployment}/complete` with no `deployment` expanded to `/v1//complete` (util.ts:453-482, RFC 6570 drops undefined vars), the provider 404’d, and the CALL STILL SUCCEEDED because the other member answered — a silent misconfiguration that presents as a permanently-degraded-but-green failover',
    );
}

void main();
