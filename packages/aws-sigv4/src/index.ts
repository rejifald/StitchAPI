// @stitchapi/aws-sigv4 — AWS Signature Version 4 request signing as an AuthStrategy.
//
// Core's built-in auth covers bearer / apiKey / basic / cookieSession / oauth2 —
// but not request SIGNING, which AWS APIs, S3-compatible stores, and many webhook
// endpoints require. This adds it: `awsSigV4(...)` returns an `AuthStrategy` whose
// `apply` signs the fully-built request (method + URI + query + headers + payload
// hash) and attaches the `Authorization` / `x-amz-*` headers — at call time, so the
// secret never reaches the call site or a trace.
//
// Crypto is the platform's Web Crypto (`crypto.subtle`), so it runs unchanged on
// Node 20+, edge runtimes (Workers / Deno), and the browser; Node 18 falls back to
// `node:crypto`'s `webcrypto`. The low-level `signRequestV4` is exported too, so it
// can be unit-tested against the official AWS test vectors.
import type { AuthStrategy } from 'stitchapi';

// ---------------------------------------------------------------------------
// Secret
// ---------------------------------------------------------------------------

/** A credential value — a string or a zero-arg getter resolved at call time (so an
 * `env()`-style thunk reads per call and the agent never sees the value). Mirrors
 * core's `Secret`. */
export type Secret = string | (() => string);

function resolveSecret(secret: Secret): string {
    return typeof secret === 'function' ? secret() : secret;
}

// ---------------------------------------------------------------------------
// Web Crypto (edge-safe, with a node:crypto fallback for Node < 20)
// ---------------------------------------------------------------------------

let subtlePromise: Promise<SubtleCrypto> | undefined;
function getSubtle(): Promise<SubtleCrypto> {
    if (!subtlePromise) {
        const g = (globalThis as { crypto?: Crypto }).crypto;
        subtlePromise = g?.subtle
            ? Promise.resolve(g.subtle)
            : // Node 18 has no global Web Crypto; pull it from node:crypto. Edge and
              // browser never reach here (they have globalThis.crypto).
              import('node:crypto').then(
                  (m) => m.webcrypto.subtle as SubtleCrypto,
              );
    }
    return subtlePromise;
}

const enc = new TextEncoder();
// Copy into a fresh ArrayBuffer-backed view so the type is `Uint8Array<ArrayBuffer>`
// (what Web Crypto's `BufferSource` wants — `TextEncoder.encode` is `ArrayBufferLike`).
function bytes(s: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(enc.encode(s));
}

function hex(buf: ArrayBuffer | Uint8Array): string {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let out = '';
    for (const b of u) out += b.toString(16).padStart(2, '0');
    return out;
}

async function sha256Hex(data: string): Promise<string> {
    const subtle = await getSubtle();
    return hex(await subtle.digest('SHA-256', bytes(data)));
}

async function hmac(
    key: Uint8Array<ArrayBuffer>,
    data: string,
): Promise<Uint8Array<ArrayBuffer>> {
    const subtle = await getSubtle();
    const k = await subtle.importKey(
        'raw',
        key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    return new Uint8Array(await subtle.sign('HMAC', k, bytes(data)));
}

/** SHA-256 of the empty string — the payload hash for a body-less request. */
export const EMPTY_PAYLOAD_SHA256 =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ---------------------------------------------------------------------------
// Canonicalisation (RFC 3986 / AWS-strict)
// ---------------------------------------------------------------------------

/** AWS-strict percent-encoding: everything but the RFC 3986 unreserved set
 * (`A-Za-z0-9-_.~`). Unlike `encodeURIComponent`, it also encodes `!'()*`. */
function uriEncode(value: string, encodeSlash = true): string {
    let out = '';
    for (const ch of value) {
        if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
        else if (ch === '/' && !encodeSlash) out += ch;
        else
            for (const b of bytes(ch))
                out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
}

function canonicalUri(pathname: string): string {
    if (!pathname) return '/';
    return pathname
        .split('/')
        .map((seg) => uriEncode(seg))
        .join('/');
}

function canonicalQuery(search: URLSearchParams): string {
    const pairs: [string, string][] = [];
    for (const [k, v] of search) pairs.push([uriEncode(k), uriEncode(v)]);
    pairs.sort((a, b) =>
        a[0] < b[0]
            ? -1
            : a[0] > b[0]
              ? 1
              : a[1] < b[1]
                ? -1
                : a[1] > b[1]
                  ? 1
                  : 0,
    );
    return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

// ---------------------------------------------------------------------------
// signRequestV4 — the pure signer (verifiable against AWS test vectors)
// ---------------------------------------------------------------------------

export interface SignV4Options {
    method: string;
    /** The fully-built request URL (host, path, query). */
    url: string;
    /** Headers to sign. Lower-cased internally; `host` is derived from `url` if absent. */
    headers: Record<string, string>;
    /** Hex SHA-256 of the payload, or `'UNSIGNED-PAYLOAD'`. */
    payloadHash: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region: string;
    service: string;
    /** Amz datetime, `YYYYMMDDTHHMMSSZ`. */
    dateTime: string;
}

export interface SignV4Result {
    /** The `Authorization` header value. */
    authorization: string;
    signedHeaders: string;
    signature: string;
    amzDate: string;
}

/**
 * Compute a SigV4 signature for a request. Pure (given `dateTime`), so it is
 * verifiable against the official AWS `aws-sig-v4-test-suite` vectors. The
 * {@link awsSigV4} strategy wraps this with timestamping, payload hashing, and
 * header attachment.
 */
export async function signRequestV4(p: SignV4Options): Promise<SignV4Result> {
    const u = new URL(p.url);
    const amzDate = p.dateTime;
    const dateStamp = amzDate.slice(0, 8);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.headers)) {
        headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
    }
    if (!headers['host']) headers['host'] = u.host;

    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
    const signedHeaders = names.join(';');

    const canonicalRequest = [
        p.method.toUpperCase(),
        canonicalUri(u.pathname),
        canonicalQuery(u.searchParams),
        canonicalHeaders,
        signedHeaders,
        p.payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${p.region}/${p.service}/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        scope,
        await sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = await hmac(bytes(`AWS4${p.secretAccessKey}`), dateStamp);
    const kRegion = await hmac(kDate, p.region);
    const kService = await hmac(kRegion, p.service);
    const kSigning = await hmac(kService, 'aws4_request');
    const signature = hex(await hmac(kSigning, stringToSign));

    const authorization = `AWS4-HMAC-SHA256 Credential=${p.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { authorization, signedHeaders, signature, amzDate };
}

// ---------------------------------------------------------------------------
// awsSigV4 — the AuthStrategy
// ---------------------------------------------------------------------------

export interface AwsSigV4Options {
    /** AWS region, e.g. `'us-east-1'`. */
    region: string;
    /** AWS service, e.g. `'s3'`, `'execute-api'`, `'dynamodb'`. */
    service: string;
    accessKeyId: Secret;
    secretAccessKey: Secret;
    /** Optional STS session token (temporary credentials). */
    sessionToken?: Secret;
    /**
     * Hash the request body into the signature (`x-amz-content-sha256`). A **string**
     * body is hashed by default (exact bytes); a non-string body is sent
     * `UNSIGNED-PAYLOAD` unless `signBody: true`. `false` forces `UNSIGNED-PAYLOAD` for
     * any body.
     *
     * When `true`, the hash is taken over the exact bytes the transport sends, chosen by
     * `bodyType`: a JSON body (`bodyType` `'json'` or unset) hashes `JSON.stringify(body)`;
     * a `'form'` body hashes its `application/x-www-form-urlencoded` encoding. A
     * `'multipart'` body **cannot** be payload-signed — the transport generates a
     * non-deterministic boundary — so `signBody: true` with a multipart body **throws**;
     * leave it unset (or `false`) to send `UNSIGNED-PAYLOAD`, or pass a pre-serialised
     * string body to sign it.
     */
    signBody?: boolean;
}

function amzDateOf(d: Date): string {
    return d
        .toISOString()
        .replace(/[:-]/g, '')
        .replace(/\.\d{3}/, '');
}

/**
 * Serialise a non-string `bodyType: 'form'` body to `application/x-www-form-urlencoded`
 * for payload signing. A byte-for-byte mirror of core's transport — `encodeRequestBody`
 * in `packages/core/src/http-adapter.ts` (a `URLSearchParams`, `String(v)`, null/undefined
 * skipped). It MUST stay identical to that encoding, or a signed form payload hash won't
 * match the bytes the transport actually sends. Only reached with `signBody: true`.
 */
function formEncode(body: unknown): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (v !== undefined && v !== null) params.append(k, String(v));
    }
    return params.toString();
}

/**
 * Sign every request with AWS Signature V4. Attach it as a stitch's `auth`:
 *
 * ```ts
 * import { stitch, env } from 'stitchapi';
 * import { awsSigV4 } from '@stitchapi/aws-sigv4';
 *
 * const putObject = stitch({
 *     baseUrl: 'https://my-bucket.s3.us-east-1.amazonaws.com',
 *     path: '/{key}',
 *     method: 'PUT',
 *     auth: awsSigV4({
 *         region: 'us-east-1',
 *         service: 's3',
 *         accessKeyId: env('AWS_ACCESS_KEY_ID'),
 *         secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
 *     }),
 * });
 * ```
 *
 * Credentials resolve at call time (so an agent never sees them), and the signature
 * is computed on the final request — after path templating and query building — so
 * it always matches the bytes the transport sends.
 */
export function awsSigV4(opts: AwsSigV4Options): AuthStrategy {
    return {
        name: 'awsSigV4',
        async apply(req, ctx) {
            const accessKeyId = resolveSecret(opts.accessKeyId);
            const secretAccessKey = resolveSecret(opts.secretAccessKey);
            const sessionToken = opts.sessionToken
                ? resolveSecret(opts.sessionToken)
                : undefined;

            const amzDate = amzDateOf(new Date());
            const url = new URL(req.url);

            const body = req.body;
            const method = req.method.toUpperCase();
            let payloadHash: string;
            if (method === 'GET' || method === 'HEAD') {
                // The transport drops the body for GET/HEAD (`encodeRequestBody` in
                // core's http-adapter.ts short-circuits to no body), so the bytes on the
                // wire are empty regardless of any `body`/`signBody`. Sign the empty
                // payload to match — hashing the body here would sign bytes the transport
                // never sends → 403 SignatureDoesNotMatch.
                payloadHash = EMPTY_PAYLOAD_SHA256;
            } else if (body === undefined || body === null || body === '') {
                payloadHash = EMPTY_PAYLOAD_SHA256;
            } else if (typeof body === 'string') {
                // Every transport sends a string body verbatim, so its bytes are
                // known exactly — hash them unless signing is opted out.
                payloadHash =
                    opts.signBody === false
                        ? 'UNSIGNED-PAYLOAD'
                        : await sha256Hex(body);
            } else if (req.bodyType === 'form') {
                // Core serialises a form body as `application/x-www-form-urlencoded`
                // (URLSearchParams), NOT JSON. Hashing JSON here would sign bytes the
                // transport never sends → 403 SignatureDoesNotMatch. Mirror the exact
                // wire encoding so the signed hash matches (see `formEncode`).
                payloadHash =
                    opts.signBody === true
                        ? await sha256Hex(formEncode(body))
                        : 'UNSIGNED-PAYLOAD';
            } else if (req.bodyType === 'multipart') {
                // A multipart body is sent as FormData; the transport picks the
                // boundary at send time, so the exact bytes are not knowable here and
                // the payload cannot be signed. Refuse loudly rather than emit a hash
                // that is guaranteed not to match (a silent 403 at AWS is worse).
                if (opts.signBody === true)
                    throw new Error(
                        'awsSigV4: signBody:true cannot sign a multipart body — the ' +
                            'transport generates the multipart boundary at send time, ' +
                            'so the payload hash can never match the bytes sent. Use ' +
                            'signBody:false (UNSIGNED-PAYLOAD is accepted over HTTPS) ' +
                            'or send a pre-serialised string body to sign it.',
                    );
                payloadHash = 'UNSIGNED-PAYLOAD';
            } else {
                // JSON (`bodyType: 'json'` or unset): core sends `JSON.stringify(body)`,
                // so re-serialising the SAME object with the SAME call here yields the
                // exact wire bytes. Keep this a literal re-serialisation, NOT a
                // canonical/sorted "stable" object hash — `x-amz-content-sha256` must be
                // the SHA-256 of the bytes actually sent (insertion-order JSON), so
                // sorting keys would itself cause SignatureDoesNotMatch.
                payloadHash =
                    opts.signBody === true
                        ? await sha256Hex(JSON.stringify(body))
                        : 'UNSIGNED-PAYLOAD';
            }

            // Attach the SigV4 headers, then sign the request's WHOLE header set.
            req.headers['host'] = url.host;
            req.headers['x-amz-date'] = amzDate;
            req.headers['x-amz-content-sha256'] = payloadHash;
            if (sessionToken)
                req.headers['x-amz-security-token'] = sessionToken;

            // Sign every header on the request, not just the SigV4 ones. AWS requires
            // `host` AND every `x-amz-*` header to be in SignedHeaders; a request carrying
            // a custom `x-amz-*` (e.g. `x-amz-acl`, `x-amz-server-side-encryption` —
            // routine for S3) that sends the header on the wire but leaves it out of the
            // signature is rejected with 403 SignatureDoesNotMatch. Signing the full set
            // is safe: the transport (`fetchAdapter`) sends `req.headers` verbatim and only
            // *adds* a `content-type` when one is absent — a header present on the wire but
            // unsigned is permitted by AWS; the fatal case (signed-but-absent) can't happen
            // because everything signed here is sent. `signRequestV4` lower-cases, sorts,
            // trims, and canonicalises arbitrary headers.
            const toSign: Record<string, string> = { ...req.headers };

            const { authorization } = await signRequestV4({
                method: req.method,
                url: req.url,
                headers: toSign,
                payloadHash,
                accessKeyId,
                secretAccessKey,
                ...(sessionToken ? { sessionToken } : {}),
                region: opts.region,
                service: opts.service,
                dateTime: amzDate,
            });

            req.headers['authorization'] = authorization;
            ctx.emit('auth', `aws sigv4 ${opts.service}/${opts.region}`);
        },
    };
}
