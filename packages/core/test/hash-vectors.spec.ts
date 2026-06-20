// Known-answer & stability vectors for the xxh128 cache/fingerprint primitive (src/hash.ts).
//
// cache-internals.spec.ts already checks the *structural* properties — determinism, the
// 32-lowercase-hex shape, and that distinct inputs differ. None of those pins the actual
// digest, so a regression in a constant, a rotation, or one of the tail branches would
// still hash deterministically and stay 32 hex chars — passing every existing test while
// silently changing every cache key (a mass, invisible invalidation; ADR 0003 / the
// KEY_VERSION freeze noted in src/hash.ts). These vectors close that gap:
//
//   1. Known-answer tests against the *canonical* XXH64 seed-0 reference vectors. xxh128's
//      first 16 hex chars are XXH64(input, 0), so they must equal the published values —
//      this verifies the implementation is real xxHash, not merely self-consistent.
//   2. Frozen golden digests across inputs chosen to drive every code path, so any
//      accidental algorithm change is caught as an explicit, reviewable diff.
import { xxh128 } from '../src/hash';

describe('xxh128 known-answer vectors (canonical XXH64, seed 0)', () => {
    // The seed-A pass is plain XXH64(input, 0); these are the reference xxHash vectors.
    it('matches XXH64("") = 0xEF46DB3751D8E999', () => {
        expect(xxh128('').slice(0, 16)).toBe('ef46db3751d8e999');
    });

    it('matches XXH64("abc") = 0x44BC2CF5AD770999', () => {
        expect(xxh128('abc').slice(0, 16)).toBe('44bc2cf5ad770999');
    });
});

describe('xxh128 frozen golden digests', () => {
    // The algorithm is bit-stable and pinned behind the cache KEY_VERSION (src/hash.ts):
    // a change here must be a deliberate key-schema bump, never an accident. Inputs drive
    // every branch of xxh64():
    //   ''        → short branch (seed + P5), no tail
    //   'a'       → 1-byte tail loop only
    //   'abc'     → 1-byte tail loop (x3)
    //   'abcd'    → 4-byte tail
    //   'abcdefgh'→ 8-byte tail
    //   'café'    → multi-byte UTF-8 (5 bytes: 4-byte + 1-byte tail)
    //   x31       → short branch + 8/4/1-byte tails
    //   x32       → exactly one 32-byte stripe, no tail
    //   x40       → one stripe + 8-byte tail
    //   pangram   → multiple stripes + mixed tails
    const VECTORS: readonly (readonly [string, string])[] = [
        ['', 'ef46db3751d8e9996ec6d05f61c7e7a7'],
        ['a', 'd24ec4f1a98c6e5b727c10e0d238e188'],
        ['abc', '44bc2cf5ad770999a7cb2aac405e36c7'],
        ['abcd', 'de0327b0d25d92cce85345c5982bba31'],
        ['abcdefgh', '3ad351775b4634b7980d1f27e25f8670'],
        ['café', '9a40a9b974d85a6abdd6f29e30bb510e'],
        ['x'.repeat(31), '60dd0d01083b99f00cbe8c70f400ea76'],
        ['x'.repeat(32), 'e2df261fc2ec30ebe9d4d41add98fbb1'],
        ['x'.repeat(40), '926f564e1b3e18d54e059f6c84f27bc3'],
        [
            'The quick brown fox jumps over the lazy dog',
            '0b242d361fda71bcb8a8089add7e03d9',
        ],
    ];

    it.each(VECTORS)('digest of %j is frozen', (input, expected) => {
        expect(xxh128(input)).toBe(expected);
    });

    it('combines two independent seeds (the 128-bit halves never coincide)', () => {
        for (const [input] of VECTORS) {
            const d = xxh128(input);
            expect(d.slice(0, 16)).not.toBe(d.slice(16));
        }
    });
});
