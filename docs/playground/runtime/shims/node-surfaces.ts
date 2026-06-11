/**
 * Browser stand-ins for the Node-only auth/secret surfaces — B1.
 *
 * These are the surfaces in NODE_ONLY_SURFACES (contracts/dispatch.ts) that CAN
 * still run shimmed in the browser (unlike cli/serve/mcp). The browser entry
 * re-exports THESE in place of core's `keychain`/`env`/`cookieSession`. Each emits
 * a `RunNotice { kind:'shim', surface, … }` (SANDBOX §3/§5.7) so R1/the UI can show
 * "ran `keychain` shimmed".
 *
 * Policy (REQUIREMENTS §6, SANDBOX §3/§5.7):
 *   - keychain(name) → documented DEMO value (never touches a real keychain/fs).
 *   - env(name)      → documented DEMO value (never reads real env).
 *   - cookieSession  → core's pure-JS strategy is fine; the only Node bit is the
 *     `node:fs` co-import in auth.ts, already neutralised by the fs alias. The jar
 *     lives in whatever StitchStore the snippet uses (default memoryStore → an
 *     IN-MEMORY jar), so we re-export core's `cookieSession` unchanged but with a
 *     one-time shim notice.
 */
import { cookieSession as coreCookieSession } from '@stitchapi/core';
import { emitShimNotice } from './notices';

// `CookieSessionOpts`/`AuthStrategy` aren't re-exported from core's barrel, so we
// derive the exact param/return types from the function itself — keeps the shim
// faithful without depending on an internal type path.
type CookieSessionOpts = Parameters<typeof coreCookieSession>[0];
type AuthStrategy = ReturnType<typeof coreCookieSession>;

/**
 * Stable, obviously-fake demo secret for a given name. Deterministic so docs
 * snippets/snapshots are reproducible (SANDBOX §4.3). It is NOT a real credential.
 */
function demoSecretFor(name: string): string {
    return `demo-${name}-secret`;
}

/**
 * Browser `keychain`: returns a documented demo value instead of reading the OS
 * keychain / `~/.stitch/secrets.json`. Emits a shim notice on first resolution.
 */
export function keychain(name: string): () => string {
    return () => {
        emitShimNotice(
            'keychain',
            `keychain('${name}') is simulated in the browser sandbox — returning a demo value, ` +
                `not a real secret. Use the server tier (or a proxy) for real keychain access.`,
        );
        return demoSecretFor(name);
    };
}

/**
 * Browser `env`: returns a documented demo value instead of reading `process.env`.
 * Emits a shim notice on first resolution.
 */
export function env(name: string): () => string {
    return () => {
        emitShimNotice(
            'env',
            `env('${name}') is simulated in the browser sandbox — returning a demo value, ` +
                `not a real environment variable.`,
        );
        return demoSecretFor(name);
    };
}

/**
 * Browser `cookieSession`: core's strategy is pure JS and works as-is; the cookie
 * jar persists in the snippet's StitchStore (in-memory by default). We re-export
 * it but flag the run so the UI notes the jar is in-memory, not a real browser
 * cookie store (REQUIREMENTS §6).
 */
export function cookieSession(opts: CookieSessionOpts): AuthStrategy {
    emitShimNotice(
        'cookieSession',
        'cookieSession uses an in-memory cookie jar in the browser sandbox (not a ' +
            'persistent browser cookie store). The session lives for the run only.',
    );
    return coreCookieSession(opts);
}
