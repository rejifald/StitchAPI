/**
 * Browser shim for `node:crypto` — B1 (browser `stitch` build).
 *
 * `engine.ts` imports `randomUUID` on the HOT PATH (`applyIdempotency()` on
 * writes) and `otlp.ts` imports `randomBytes` for span/trace ids. The bundler
 * aliases `node:crypto` to this module (see build-stitch-browser.mjs). Both are
 * backed by Web Crypto, which IS available in Web Workers (B1-SPIKE §7), so the
 * shim is safe in the runner's Worker scope.
 *
 * Surface used by core (the only two symbols imported anywhere in the reachable
 * graph — B1-SPIKE §1):
 *   - randomUUID(): string            (engine.ts:38)
 *   - randomBytes(n): { toString('hex') }  (otlp.ts:7, via `hex()`)
 *
 * NOTE: `randomBytes` in core is only ever called as `randomBytes(n).toString('hex')`,
 * so the returned object only needs a `.toString('hex')`. We return a real
 * Uint8Array-shaped value with a hex `toString` to stay faithful without pulling
 * in a Buffer polyfill.
 */

const webcrypto: Crypto =
    (globalThis as { crypto?: Crypto }).crypto as Crypto;

/** Web Crypto UUID — used by engine.ts on the write hot path. */
export function randomUUID(): string {
    return webcrypto.randomUUID();
}

const HEX = '0123456789abcdef';

/**
 * `node:crypto` returns a Buffer; core only ever calls `.toString('hex')` on it
 * (otlp.ts `hex()`). We return a Uint8Array subclass whose `toString('hex')`
 * yields the hex string Node's Buffer would, so the call site is unchanged.
 */
class HexBytes extends Uint8Array {
    override toString(encoding?: string): string {
        if (encoding === 'hex' || encoding === undefined) {
            let out = '';
            for (let i = 0; i < this.length; i++) {
                const b = this[i] as number;
                out += HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
            }
            return out;
        }
        // Best-effort for any other encoding core might one day pass.
        return super.toString();
    }
}

/** Web-Crypto-backed `randomBytes` faithful to `randomBytes(n).toString('hex')`. */
export function randomBytes(size: number): HexBytes {
    const buf = new HexBytes(size);
    webcrypto.getRandomValues(buf);
    return buf;
}

// Some bundles/callers do `import crypto from 'node:crypto'` (default import).
const _default = { randomUUID, randomBytes };
export default _default;
