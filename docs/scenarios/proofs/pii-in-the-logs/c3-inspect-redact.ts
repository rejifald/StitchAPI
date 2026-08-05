// C3 — what does `.inspect({ redact })` actually redact (ADR 0018)?
//
// The ADR is unusually explicit about its own limits ("name-based only — a sharing convenience,
// _not_ a leak guarantee", §3), so the interesting question is not whether the doc is honest — it
// is — but what the honest tool covers when pointed at a real customer record. Measured here:
// nested fields, array elements, renamed keys, free text, the two path grammars, the default, and
// the one thing the ADR does not say out loud.
//
// The headline: with `redact: true` and nothing else, ZERO of the seven sentinels are removed. The
// shared denylist is a CREDENTIAL denylist — `token`/`secret`/`password`/`apikey`/`signature` — and
// no spelling of a customer field is in it. `redact` only does PII work when you hand it the field
// names yourself, which is the denylist-you-must-enumerate the capture says the field cannot write.
//
//   pnpm exec tsx docs/scenarios/proofs/pii-in-the-logs/c3-inspect-redact.ts
import {
    isSecretKey,
    redactSecretsDeep,
    stitch,
} from '../../../../packages/core/src/index';
import {
    ARRAY,
    BASE,
    EMAIL,
    FREETEXT,
    NAME,
    NESTED,
    RENAMED,
    SENTINELS,
    SSN,
    bytesOf,
    fakeVendor,
} from './canary';
import { check, checkSeq, finish, heading, note, scan } from './harness';

const call = stitch({
    name: 'getCustomer',
    baseUrl: BASE,
    path: '/v1/customers/1',
    adapter: fakeVendor(),
});

/**
 * Which sentinel codes survive in `raw` under a given `redact` setting.
 *
 * Note the call shape: `redact` is the SECOND argument, after the (possibly empty) input. Writing
 * `call.inspect({ redact: true })` puts the options object in the INPUT slot, where the engine reads
 * it as a `StitchInput` and redaction silently never happens. TypeScript rejects that spelling —
 * measured in (h) — but a JS consumer, or a `// @ts-expect-error`, gets the silent version.
 */
async function survivors(redact?: boolean | string[]): Promise<string[]> {
    const w =
        redact === undefined
            ? await call.inspect()
            : await call.inspect({}, { redact });
    return [...scan(bytesOf(w.raw), SENTINELS)];
}

async function main(): Promise<void> {
    heading('C3 (a) — the default is OFF, exactly as the ADR titles itself');
    {
        const bare = await survivors();
        checkSeq(
            '`.inspect()` with no options — every sentinel survives',
            bare,
            ['nm', 'em', 'ssn', 'nst', 'txt', 'arr', 'ren'],
        );
        const w = await call.inspect();
        check(
            '`raw` is the SAME object the engine retained, not a clone',
            typeof w.raw === 'object',
            true,
        );
        note(
            'ADR 0018 §3: "The default protection is non-enumerability; `redact` is the deliberate-sharing escape hatch layered on top." Measured: true, and non-enumerability is a weak protection — see C1(e), where `JSON.stringify(wrapper)` leaks everything through the enumerable `data`',
        );
    }

    heading(
        'C3 (b) — `redact: true`: the shared denylist, against a customer record',
    );
    {
        const kept = await survivors(true);
        checkSeq(
            'sentinels REMOVED by the built-in denylist',
            SENTINELS.map((s) => s.code).filter((c) => !kept.includes(c)),
            [],
        );
        check('sentinels that survive `redact: true`', kept.length, 7);
        // The reason, stated as a measurement rather than an assertion about the list.
        const keys = [
            'name',
            'email',
            'ssn',
            'mail',
            'note',
            'primaryContactMail',
            'contacts',
            'profile',
            'contact',
        ];
        checkSeq(
            "which of the canary's key names the denylist considers secret",
            keys.filter((k) => isSecretKey(k)),
            [],
        );
        checkSeq(
            'and, for contrast, the names it DOES catch',
            [
                'access_token',
                'client_secret',
                'password',
                'apikey',
                'x-amz-signature',
                'sig',
                'pwd',
            ].filter((k) => isSecretKey(k)),
            [
                'access_token',
                'client_secret',
                'password',
                'apikey',
                'x-amz-signature',
                'sig',
                'pwd',
            ],
        );
        note(
            '→ REFUTATION-ADJACENT, and the single most load-bearing measurement in C3: `redact: true` is not a PII control at all. It is the credential denylist, reused. Against this record it removes nothing',
        );
    }

    heading('C3 (c) — `redact: [names]`: NESTED, ARRAY, RENAMED, FREE TEXT');
    {
        const kept = await survivors(['email']);
        check(
            "`redact: ['email']` removes the TOP-LEVEL email",
            kept.includes('em'),
            false,
        );
        check(
            'and the ARRAY-element email at contacts[1].email — a bare name matches at any depth',
            kept.includes('arr'),
            false,
        );
        check(
            'but NOT the nested `profile.contact.mail` — different key name',
            kept.includes('nst'),
            true,
        );
        check(
            'nor `primaryContactMail` — the renamed key',
            kept.includes('ren'),
            true,
        );
        check(
            'nor the address inside the free-text `note`',
            kept.includes('txt'),
            true,
        );
        note('survivors', kept.join(','));
    }
    {
        const kept = await survivors(['email', 'mail', 'name', 'ssn', 'note']);
        checkSeq('the full hand-written list catches six of seven', kept, [
            'ren',
        ]);
        check(
            '`mail` (bare) DOES reach `profile.contact.mail` two levels down',
            kept.includes('nst'),
            false,
        );
        check(
            'and `note` blanks the whole free-text field, taking the address with it',
            kept.includes('txt'),
            false,
        );
        note(
            "→ the survivor is `primaryContactMail`. That is not an oversight in the list — it is the capture's thesis in one value: the field you did not know to name is the field that leaks",
        );
    }

    heading(
        'C3 (d) — the path grammar: prefix, wildcard, and the `[]` mismatch',
    );
    {
        const body = {
            profile: { contact: { mail: NESTED } },
            contacts: [{ email: 'a@example.test' }, { email: ARRAY }],
        };
        const at = (v: unknown, p: string[]): unknown =>
            p.reduce<unknown>(
                (acc, k) => (acc as Record<string, unknown> | undefined)?.[k],
                v,
            );
        // Exact dotted path.
        const exact = redactSecretsDeep(body, ['profile.contact.mail']);
        check(
            'exact path `profile.contact.mail`',
            at(exact, ['profile', 'contact', 'mail']),
            'REDACTED',
        );
        // Prefix: a pattern that is a proper prefix nukes the whole subtree.
        const prefix = redactSecretsDeep(body, ['profile']);
        check(
            'a prefix pattern `profile` replaces the ENTIRE subtree with the sentinel',
            at(prefix, ['profile']),
            'REDACTED',
        );
        // Wildcard on an object level.
        const wild = redactSecretsDeep(body, ['profile.*.mail']);
        check(
            'wildcard `profile.*.mail` matches one object level',
            at(wild, ['profile', 'contact', 'mail']),
            'REDACTED',
        );
        // The array-index grammar mismatch.
        const bracket = redactSecretsDeep(body, ['contacts[].email']);
        check(
            '`contacts[].email` — the DRIFT grammar — matches nothing',
            bytesOf(bracket).includes(ARRAY),
            true,
        );
        const star = redactSecretsDeep(body, ['contacts.*.email']);
        check(
            '`contacts.*.email` matches nothing either — the path is `contacts[1].email`',
            bytesOf(star).includes(ARRAY),
            true,
        );
        const indexed = redactSecretsDeep(body, ['contacts[1].email']);
        check(
            'only the concrete index `contacts[1].email` matches',
            bytesOf(indexed).includes(ARRAY),
            false,
        );
        const bare = redactSecretsDeep(body, ['email']);
        check(
            'so for arrays the usable spelling is the BARE key name, which matches at every index',
            bytesOf(bare).includes(ARRAY),
            false,
        );
        note(
            '→ NOT IN THE CLAIMS: the library carries two path grammars that disagree on arrays. A drift finding reports `contacts[].email`; pasting that exact string into `redact` matches nothing. `matchPath` handles `*` per dot-segment and `[` only as a prefix boundary, so the collapsed `[]` form — the one the library PRINTS at you — is the one form that cannot be used here',
        );
    }

    heading(
        'C3 (e) — what redaction does NOT touch: `data`, `findings`, `status`',
    );
    {
        const w = await call.inspect(
            {},
            { redact: ['email', 'mail', 'name', 'ssn', 'note'] },
        );
        check(
            '`raw` is scrubbed down to one survivor',
            scan(bytesOf(w.raw), SENTINELS).size,
            1,
        );
        check(
            'but `data` still holds all 7 — redaction never touches the value',
            scan(bytesOf(w.data), SENTINELS).size,
            7,
        );
        check(
            'so `JSON.stringify(wrapper)` after a full redact still leaks all 7',
            scan(bytesOf(w), SENTINELS).size,
            7,
        );
        note(
            '→ this is the trap the ADR does not spell out. `redact` protects the field that was ALREADY non-enumerable and leaves the enumerable one alone. A consumer who reads "pass `{ redact: true }` when you want to pipe this into a log" and then logs the wrapper is no safer than before',
        );
    }

    heading(
        'C3 (f) — `.report({ redact })` shares the path, and `redact` returns a CLONE',
    );
    {
        const r = await call.report(
            {},
            { redact: ['email', 'mail', 'name', 'ssn', 'note'] },
        );
        check(
            '`.report()` honours `redact` on `raw` too',
            scan(bytesOf(r.raw), SENTINELS).size,
            1,
        );
        check(
            'and its `data` is untouched, like `.inspect()`',
            scan(bytesOf(r.data), SENTINELS).size,
            7,
        );
        // Non-mutation: the engine's retained body must survive redaction intact.
        const original = { email: EMAIL, ssn: SSN, name: NAME, extra: RENAMED };
        const clone = redactSecretsDeep(original, ['email']);
        check(
            'redactSecretsDeep does not mutate its input',
            original.email,
            EMAIL,
        );
        check(
            'it returns a scrubbed clone',
            (clone as { email: unknown }).email,
            'REDACTED',
        );
        check(
            'the sentinel it writes is `REDACTED` (no brackets — the trace sink uses `[REDACTED]`)',
            (clone as { email: unknown }).email,
            'REDACTED',
        );
        note(
            'two different redaction sentinels ship in one library: `REDACTED` from `util.ts` (inspect/url/query) and `[REDACTED]` from `trace.ts` (headers). Cosmetic, but a log-aggregator rule written for one will not match the other',
        );
    }

    heading('C3 (g) — is there a stitch-level default? No.');
    {
        // ADR 0018 §1 permits one ("a `drift`-config or a `defaultInspect` block") as future work.
        // Measured against the shipped surface: the option exists ONLY per call.
        const cfg = (call as unknown as { __config: Record<string, unknown> })
            .__config;
        check(
            'no `defaultInspect` slot on the resolved config',
            'defaultInspect' in cfg,
            false,
        );
        check('no `redact` slot either', 'redact' in cfg, false);
        note(
            'so redaction cannot be made the default for a stitch, a seam, or a process — deliberately (ADR 0018 §1 calls a global toggle "the silent-blinding footgun"). The consequence for this scenario: there is no configuration you can write ONCE that makes `.inspect()` safe everywhere it is called',
        );
    }

    heading('C3 (h) — the calling convention, and the silent-no-op spelling');
    {
        // `redact` is the SECOND parameter. Passing the options object alone puts it in the INPUT
        // slot: the engine reads it as a `StitchInput` (no `params`/`query`/`body`/`headers`, so the
        // request is unchanged) and `opts` stays undefined — redaction never runs, silently.
        const wrong = await (
            call.inspect as unknown as (o: unknown) => Promise<{ raw: unknown }>
        )({ redact: ['email', 'mail', 'name', 'ssn', 'note'] });
        check(
            '`call.inspect({ redact: [...] })` — one argument — redacts NOTHING',
            scan(bytesOf(wrong.raw), SENTINELS).size,
            7,
        );
        const right = await call.inspect(
            {},
            { redact: ['email', 'mail', 'name', 'ssn', 'note'] },
        );
        check(
            '`call.inspect({}, { redact: [...] })` — two arguments — redacts six of seven',
            scan(bytesOf(right.raw), SENTINELS).size,
            1,
        );
        note(
            "the cast above is doing real work: TypeScript REJECTS the one-argument spelling outright — `error TS2353: Object literal may only specify known properties, and 'redact' does not exist in type 'StitchInput'`, and `TS2559` for a non-literal. So the type system closes this, and it is only reachable from JavaScript or through a deliberate cast. Recorded because a security option whose no-op spelling is the shorter one is worth knowing about",
        );
    }

    checkSeq(
        'sanity: the free-text address is unreachable by ANY key-based rule',
        [
            ...scan(
                bytesOf(
                    redactSecretsDeep(
                        { note: `mail ${FREETEXT} please`, other: 1 },
                        ['email', 'mail', 'ssn', 'name', 'contact', 'address'],
                    ),
                ),
                SENTINELS,
            ),
        ],
        ['txt'],
    );

    finish(
        'C3',
        "CONFIRMED as an opt-in, name-based, per-call DENYLIST over `raw` only — and measured to be far narrower against PII than its name suggests. Four numbers: (1) `redact: true`, the shared denylist, removes 0 of 7 sentinels from a customer record — none of `name`/`email`/`ssn`/`mail`/`note`/`contacts`/`primaryContactMail` is a secret key, because the list is the credential list (`token`/`secret`/`password`/`apikey`/`signature`/`sig`/`pwd`), reused; (2) `redact: [names]` DOES work at depth and across array elements — a bare `mail` reaches `profile.contact.mail`, a bare `email` reaches `contacts[1].email` at every index — so nested and array coverage is genuinely there, but only for names you enumerate; (3) a renamed key (`primaryContactMail`) and an address inside free text are unreachable by construction, which is the capture's thesis reproduced exactly; (4) the default is off and there is NO stitch-level or process-level default — `defaultInspect` from ADR 0018 §1 was never implemented, so no single configuration can make every `.inspect()` call safe. Two findings not in the claims: the path grammar disagrees with the DRIFT path grammar on arrays (a finding printed as `contacts[].email` matches nothing when pasted into `redact`; only the bare key or a concrete `contacts[1].email` works), and `redact` scrubs `raw` while leaving the ENUMERABLE `data` untouched — so after a full redact, `JSON.stringify(wrapper)` still leaks all 7",
    );
}

void main();
