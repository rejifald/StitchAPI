// Config bindings: values a stitch resolves at CALL time from somewhere else — an environment
// variable, an injected config source, a secrets file. The binding is the inert part (`Secret`,
// `SecretSource`); the resolvers (`env`/`optionalEnv`/`secretsFile`/`secretFrom`) are the thunks
// that read it when the request is made, so a credential is never captured at construction and
// never lands on the JSON-inspectable `__config` (P0).
//
// This is deliberately NOT an auth module. Auth is the biggest consumer, but not the only one:
// `@stitchapi/aws-sigv4` takes its access key / secret / session token as `Secret`s that never
// become an `AuthStrategy`, and a `Secret` thunk is equally at home in a header or a request body.
// Splitting bindings out from `./auth` is what lets the strategy factories move to their own
// subpath without dragging the credential primitive along, and gives the integration packages one
// import instead of a hand-copied `type Secret = string | (() => string)`.
//
// Runtime leaf: depends only on `./util`, so `stitchapi/bindings` stays browser-safe and cheap —
// `nodeFs()` is absent in a browser bundle and `secretsFile` falls through to the env var.
import { nodeFs, readEnv } from './util';

/**
 * A value supplied either directly (`'sk-live-…'`) or as a thunk resolved at call time
 * (`env('API_KEY')`). The thunk form is the one to prefer: it keeps the credential out of the
 * construction-time config, so rotating the environment rotates the credential with no rebuild.
 */
export type Secret = string | (() => string);

/**
 * Read a {@link Secret} to its string value — the literal as-is, the thunk by calling it. Call this
 * at request time, never at construction: a `Secret` resolved early is a `Secret` captured early.
 */
export const resolveSecret = (s: Secret): string =>
    typeof s === 'function' ? s() : s;

/**
 * A resolver that may yield no value: `bearer` attaches the header only when it resolves to a
 * value, and otherwise skips it (announcing the miss) instead of failing. Produced by
 * {@link optionalEnv}, and branded so `bearer` can tell it apart from a required {@link Secret} —
 * which also keeps it, at the type level, out of the strategies that demand a credential
 * (`apiKey`, `basic`, `oauth2`).
 */
export interface OptionalSecret {
    (): string | undefined;
    readonly __optional: true;
    /** Human-readable source (e.g. `env var GITHUB_TOKEN`), used in the announced `info` event. */
    readonly label: string;
}

/** Narrow a credential to the may-be-absent {@link OptionalSecret} form (the `__optional` brand). */
export const isOptionalSecret = (
    s: Secret | OptionalSecret,
): s is OptionalSecret => typeof s === 'function' && '__optional' in s;

/**
 * Resolve a REQUIRED secret from an environment variable at call time. An exported-but-empty var
 * (`MY_TOKEN=`) counts as missing and throws — mirroring {@link optionalEnv}, which treats `''` as
 * absent — so a blank credential can never silently ride along. For the may-or-may-not-be-set case,
 * use {@link optionalEnv}.
 */
export function env(name: string): () => string {
    return () => {
        const v = readEnv(name);
        if (v == null || v === '')
            throw new Error(
                `missing env var ${name}. Fix: set it in the environment, or use optionalEnv()/secretFrom() if it's optional.`,
            );
        return v;
    };
}

/** A source `secretFrom` pulls a named value from: an object with a `get(name)` method
 *  (e.g. a NestJS ConfigService or a secrets-manager client) or a plain `(name) => value` fn. */
export type SecretSource =
    | { get(name: string): string | undefined }
    | ((name: string) => string | undefined);

/**
 * Resolve a REQUIRED secret from an arbitrary injected `source` at call time — for DI'd apps that
 * supply config WITHOUT touching `process.env` (a ConfigService, a secrets-manager client, a
 * validated config object). Throws if the source yields no value (unset or empty), mirroring
 * {@link env}. Compose with `bearer`/`apiKey`/`basic`/`oauth2` exactly like `env()`:
 * `bearer(secretFrom(configService, 'GITHUB_TOKEN'))`.
 */
export function secretFrom(source: SecretSource, name: string): () => string {
    return () => {
        const v =
            typeof source === 'function' ? source(name) : source.get(name);
        if (v == null || v === '')
            throw new Error(
                `missing secret ${name}. Fix: set it in the environment, or use optionalEnv()/secretFrom() if it's optional.`,
            );
        return v;
    };
}

/**
 * Like {@link env}, but OPTIONAL: resolves the variable's value, or *absent* (`undefined`) when it
 * is unset or empty — it never throws. Pass it to {@link bearer} to attach the credential only when
 * present, otherwise send the request unauthenticated (announced in the trace):
 * `bearer(optionalEnv('GITHUB_TOKEN'))`. For local/dev runs, notebooks, and agent loops where a
 * token may or may not be exported; when the call must be authenticated, use the throwing
 * `bearer(env('GITHUB_TOKEN'))`. In a browser bundle (no process environment) it resolves absent,
 * so `bearer` simply attaches nothing.
 */
export function optionalEnv(name: string): OptionalSecret {
    // An exported-but-empty var (`MY_TOKEN=`) counts as absent — never send `Bearer ` with no token.
    const read = (): string | undefined => {
        const v = readEnv(name);
        return v == null || v === '' ? undefined : v;
    };
    return Object.assign(read, {
        __optional: true as const,
        label: `env var ${name}`,
    });
}

/**
 * Read a named secret from `~/.stitch/secrets.json` (plaintext JSON — keep
 * the file private); falls back to the env var of the same name if the file
 * is absent or does not contain the key; throws if neither is available.
 *
 * WARNING: the secrets file is unencrypted plaintext JSON. Restrict its
 * permissions (`chmod 600 ~/.stitch/secrets.json`) and never commit it.
 */
export function secretsFile(name: string): () => string {
    return () => {
        try {
            // No node:fs (browser): skip the file, fall through to the env var.
            const fs = nodeFs();
            const file = `${readEnv('HOME')}/.stitch/secrets.json`;
            if (fs?.existsSync(file)) {
                const obj = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
                    string,
                    unknown
                >;
                // Scalars only. A bare `String(value)` would turn an object or array entry into
                // the literal '[object Object]' and send THAT as the credential; fall through to
                // the env var instead, so a malformed file fails loudly rather than authenticating
                // with garbage.
                const v = obj[name];
                if (typeof v === 'string') return v;
                if (typeof v === 'number' || typeof v === 'boolean')
                    return String(v);
            }
        } catch {
            /* fall through */
        }
        const v = readEnv(name);
        if (v == null) throw new Error(`missing secret ${name}`);
        return v;
    };
}
