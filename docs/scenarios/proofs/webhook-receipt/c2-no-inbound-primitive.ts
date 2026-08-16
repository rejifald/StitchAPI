// C2 — is there ANY inbound-signature / HMAC-verification primitive anywhere in the packages?
//
// A grep answers this, and a grep is not evidence — a missing export could be hiding behind a
// re-export chain or a differently-spelled name. So this script IMPORTS every public entry point
// of `stitchapi` and enumerates what is actually there at runtime, then checks the two things that
// LOOK like an answer and are not:
//
//   • `xxh128` (hash.ts:110-113) is a hash, and it is unkeyed and non-cryptographic. The proof
//     computes it with no secret at all, which is exactly why it cannot authenticate anything.
//   • `awsSigV4` (aws-sigv4/src/index.ts:291) is the only HMAC in the repo, and it runs in the
//     other direction: the script signs an OUTBOUND request with it and shows the strategy's only
//     verb is `apply`, with no verify counterpart. Its HMAC key is imported with usages `['sign']`
//     (aws-sigv4/src/index.ts:84) — it could not verify even if asked.
//
// And the near-miss the capture names: `idempotency` is about outbound WRITES. The script measures
// the header it puts on the wire, which is the opposite end of the duplicate problem.
//
//   pnpm exec tsx docs/scenarios/proofs/webhook-receipt/c2-no-inbound-primitive.ts
import { awsSigV4 } from '../../../../packages/aws-sigv4/src/index';
import * as auth from '../../../../packages/core/src/auth';
import * as cache from '../../../../packages/core/src/cache';
import { xxh128 } from '../../../../packages/core/src/hash';
import * as core from '../../../../packages/core/src/index';
import { stitch } from '../../../../packages/core/src/index';
import * as pipe from '../../../../packages/core/src/pipe';
import * as serveMod from '../../../../packages/core/src/serve';
import * as testing from '../../../../packages/core/src/testing';
import type {
    Adapter,
    AdapterRequest,
    AuthContext,
} from '../../../../packages/core/src/types';
import { check, checkSeq, finish, heading, note } from './harness';

/** Words a verification primitive would have to be spelled with, in any reasonable naming scheme. */
const INBOUND_WORDS =
    /verif|hmac|signature|webhook|constanttime|timingsafe|digest.*compare|receive|inbound/i;

async function main(): Promise<void> {
    heading('C2 — searching the runtime for an inbound-signature primitive');

    // ── (a) enumerate every public entry point's exports and filter for the words ─────────────
    const entries: Array<[string, Record<string, unknown>]> = [
        ['stitchapi', core as unknown as Record<string, unknown>],
        ['stitchapi/auth', auth as unknown as Record<string, unknown>],
        ['stitchapi/cache', cache as unknown as Record<string, unknown>],
        ['stitchapi/pipe', pipe as unknown as Record<string, unknown>],
        ['stitchapi/serve', serveMod as unknown as Record<string, unknown>],
        ['stitchapi/testing', testing as unknown as Record<string, unknown>],
    ];
    let total = 0;
    const hits: string[] = [];
    for (const [name, mod] of entries) {
        const names = Object.keys(mod);
        total += names.length;
        for (const n of names)
            if (INBOUND_WORDS.test(n)) hits.push(`${name}#${n}`);
    }
    note('(a) runtime exports enumerated across 6 entry points', total);
    checkSeq(
        '(a) exports matching /verif|hmac|signature|webhook|…/',
        hits.sort(),
        [
            'stitchapi/testing#verifyAdapterContract',
            'stitchapi/testing#verifyFingerprintContract',
            'stitchapi/testing#verifySinkContract',
            'stitchapi/testing#verifyStoreContract',
        ],
    );
    note(
        '(a) → the four hits are conformance suites for BYO plugins',
        'they verify that a store/adapter/sink/fingerprinter obeys its contract — nothing to do with a signature',
    );

    // ── (b) the AuthStrategy surface: one verb, and it points outward ─────────────────────────
    // `auth` is the only place a credential meets a request, so if inbound verification lived
    // anywhere it would live here. The strategy interface has no verify arm.
    {
        const strategy = auth.bearer(() => 'tok');
        checkSeq('(b) AuthStrategy keys', Object.keys(strategy).sort(), [
            'apply',
            'name',
            'scheme',
        ]);
        note(
            '(b) `scheme` is a DESCRIPTION, not a verb',
            'a declarative wire shape for OpenAPI export (types.ts:1234-1236) — it inspects nothing',
        );
        check(
            '(b) does any auth export mention verifying an inbound request?',
            Object.keys(auth).some((n) => /verif|inbound|receive/i.test(n)),
            false,
        );
        note(
            '(b) → `apply(req, ctx)` mutates an OUTGOING request',
            'there is no `AuthStrategy` member that inspects an incoming one',
        );
    }

    // ── (c) the only HMAC in the repo, run — and its direction ────────────────────────────────
    {
        const sig = awsSigV4({
            accessKeyId: 'AKIDEXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
            region: 'us-east-1',
            service: 'execute-api',
        });
        const req: AdapterRequest = {
            url: 'https://example.test/v1/thing',
            method: 'GET',
            headers: {},
        };
        const store = core.memoryStore();
        const ctx: AuthContext = {
            store,
            vault: store,
            emit: () => undefined,
        };
        await sig.apply(req, ctx);
        check(
            '(c) awsSigV4 produced an Authorization header on the OUTBOUND request',
            (req.headers['authorization'] ?? '').startsWith('AWS4-HMAC-SHA256'),
            true,
        );
        checkSeq('(c) awsSigV4 strategy keys', Object.keys(sig).sort(), [
            'apply',
            'name',
        ]);
        await store.close?.();
        note(
            '(c) → the one HMAC in the repo signs, and only signs',
            'its key is imported with usages ["sign"] (aws-sigv4/src/index.ts:84) — it cannot verify',
        );
    }

    // ── (d) the hash that is NOT a signature ──────────────────────────────────────────────────
    // Someone reaching for a "compare a digest" primitive will find `xxh128` first. It takes no
    // key, which is the whole story: an attacker can compute it as easily as you can.
    {
        const payload = '{"id":"evt_1","type":"charge.succeeded"}';
        const a = xxh128(payload);
        const b = xxh128(payload);
        check(
            '(d) xxh128 arity (a keyed MAC would take 2 args)',
            xxh128.length,
            1,
        );
        check(
            '(d) xxh128 is deterministic with NO secret involved',
            a === b,
            true,
        );
        check('(d) digest width in hex chars', a.length, 32);
        note(
            '(d) → hash.ts:110 self-describes as "non-cryptographic"',
            'unkeyed, so it authenticates nobody; it exists for cache keys and schema fingerprints',
        );
    }

    // ── (e) the near-miss: `idempotency` is an OUTBOUND write concern ──────────────────────────
    // Same word, opposite end of the pipe. It puts a key ON a request you send so a SERVER can
    // collapse your duplicate. It has no inbound counterpart.
    {
        let sentHeaders: Record<string, string> = {};
        const capture: Adapter = async (req) => {
            sentHeaders = { ...req.headers };
            return { status: 200, headers: {}, body: { ok: true } };
        };
        const write = stitch({
            url: 'https://api.test/v1/charges',
            method: 'POST',
            adapter: capture,
            retry: { attempts: 2 },
            idempotency: {
                keyOf: (input) => String((input.body as { ref?: string }).ref),
            },
        });
        const r = await write.safe({
            body: { ref: 'evt_1PqR', amount: 100 },
        });
        check('(e) the write succeeded', r.ok, true);
        check(
            '(e) `idempotency` set a header on the OUTBOUND request',
            sentHeaders['Idempotency-Key'] ?? sentHeaders['idempotency-key'],
            'evt_1PqR',
        );
        note(
            '(e) → the key rides OUT, for a server to dedup on',
            'nothing in the config dedups something arriving IN; that ledger is C5',
        );
    }

    finish(
        'C2',
        'NO — nothing in any package verifies an inbound signature, measured at runtime rather than by grep. Enumerating every public entry point turned up exactly four exports matching /verif|hmac|signature|webhook|…/ and all four are BYO-plugin conformance suites (`verifyStoreContract`, `verifyAdapterContract`, `verifySinkContract`, `verifyFingerprintContract`). `AuthStrategy` has exactly three keys, `{apply, name, scheme}` — `apply(req, ctx)` mutates an OUTGOING request, `scheme` is a declarative wire description, and there is no inbound arm. The only HMAC in the repo is `@stitchapi/aws-sigv4`, which ran here and produced an `AWS4-HMAC-SHA256` Authorization header on an outbound request; its subtle key is imported with usages ["sign"] (aws-sigv4/src/index.ts:84), so it structurally cannot verify. The nearest-looking primitive, `xxh128` (hash.ts:110-113), is UNKEYED and self-described as non-cryptographic — measured taking 1 argument and returning the same 32-char digest with no secret anywhere, which is precisely why it authenticates nobody. And `idempotency`, which wears the same word as the dedup problem, was measured putting `Idempotency-Key: evt_1PqR` on an OUTBOUND POST — the opposite end of the pipe',
    );
}

void main();
