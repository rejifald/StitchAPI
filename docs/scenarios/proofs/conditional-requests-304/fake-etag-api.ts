// A fake, in-memory CONDITIONAL-REQUEST API, shaped the way GitHub's REST API is:
//
//   GET /repos/o/r/issues                       → 200 + body + `ETag: "v1"`
//   GET … with `If-None-Match: "v1"` (matching)  → **304, NO body**, `ETag: "v1"` echoed
//   GET … with `If-None-Match: "v0"` (stale)     → 200 + the NEW body + `ETag: "v2"`
//
// Everything runs off an injected {@link Clock} and nothing touches the network. The provider
// records EVERY hit with the exact `If-None-Match` string it received, which makes four things
// measurements rather than arguments:
//
//   - `billed` — responses that would count against a rate limit. GitHub's rule: a 304 answered
//     from a correctly-authorized conditional request costs nothing, a 200 costs one. This counter
//     IS the payoff C8 measures.
//   - `validators` — the byte-exact `If-None-Match` value on every request (`'(none)'` when the
//     header was absent). `W/"v1"` surviving as `W/"v1"` is C7's whole claim.
//   - `notModified` / `full` — the response mix.
//   - per-`token` state — the resource's ETag is minted per credential, the way GitHub's is, so
//     replaying principal A's validator as principal B is visibly a MISS (C6).
//
// The 304 body is `undefined`, not `null` and not `''`. That is not a guess: `fetchAdapter` decodes
// a zero-byte JSON response as `text === '' ? undefined` (http-adapter.ts:135), and C1 pins that
// end-to-end through the real adapter with an injected `fetch` rather than trusting this fake.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    Clock,
} from '../../../../packages/core/src/types';

/** One recorded request, as the server saw it. */
export interface RecordedHit {
    method: string;
    /** Path only (the fake has one host), e.g. `/repos/o/r/issues`. */
    path: string;
    /** The RAW `If-None-Match` value received, byte-exact, or `'(none)'` when absent. */
    inm: string;
    /** The bearer token the request carried, or `'(none)'` — the ETag namespace. */
    token: string;
    status: number;
    /** Would this response count against a rate limit? `false` only for a 304. */
    billed: boolean;
    /** Virtual time (ms) the request arrived, read off the injected clock. */
    at: number;
}

/** The resource body. `version` moves on every `mutate()`; `etag` tracks it. */
export interface Issues {
    repo: string;
    version: number;
    /** WHOSE view this is — the token that asked. Private per credential. */
    viewer: string;
    issues: { id: number; title: string }[];
}

export interface EtagApiOptions {
    clock: Clock;
    /**
     * How the server namespaces its validators.
     *
     * - `'token'` (default) — the ETag string embeds the credential, GitHub-style. One principal's
     *   validator can never match another's, so a cross-principal replay merely MISSES.
     * - `'content'` — the ETag is derived from the representation alone, which is what a naive
     *   server (and Apache's non-inode default) does. The BODY still differs per credential
     *   (`viewer`), so replaying principal A's validator on principal B's request returns **304**
     *   and a client that then serves its stored body hands B **A's private data**. This is the
     *   footgun the per-credential keying rule exists to prevent, and it is only visible against
     *   a server shaped like this one.
     */
    etagScope?: 'token' | 'content';
    /**
     * Mint WEAK validators (`W/"v1"`) instead of strong ones (`"v1"`). RFC 9110 says
     * `If-None-Match` compares WEAKLY, so a compliant server matches `W/"v1"` against `"v1"` —
     * this fake does the same, and records what it was actually sent either way.
     */
    weak?: boolean;
    /**
     * The **load-balancer inode case**: every response gets a fresh, unique ETag even when the
     * body is byte-identical (Apache's default `FileETag` embeds the inode, so two servers behind
     * a balancer never agree). Revalidation then NEVER succeeds and the feature silently does
     * nothing — measurable as `billed === polls`.
     */
    inodeEtags?: boolean;
    /** Repo name in the body/path. Default `'octo/hello'`. */
    repo?: string;
}

const HOST = 'https://api.github.example';

/** Case-insensitive header read — a real server does not care how the client cased the name. */
const header = (
    headers: Record<string, string> | undefined,
    name: string,
): string | undefined => {
    if (!headers) return undefined;
    const lc = name.toLowerCase();
    for (const [k, v] of Object.entries(headers))
        if (k.toLowerCase() === lc) return v;
    return undefined;
};

/**
 * RFC 9110 §8.8.3.2 WEAK comparison, which is the one `If-None-Match` is specified to use: strip a
 * leading `W/` from both sides and compare the opaque quoted tags. `W/"v1"` therefore matches
 * `"v1"`. `*` matches any existing representation.
 */
const weakMatch = (candidate: string, current: string): boolean => {
    const strip = (t: string): string => (t.startsWith('W/') ? t.slice(2) : t);
    return candidate.split(',').some((raw) => {
        const t = raw.trim();
        return t === '*' || strip(t) === strip(current);
    });
};

/**
 * The conditional-request API. One instance is one server. State is per-`token` because ETags are
 * per-credential on GitHub: `mutate()` moves the resource for everyone, but each token's minted
 * validator is its own string, so one principal's validator is never valid for another.
 */
export class FakeEtagApi {
    /** Every hit, in order. */
    readonly hits: RecordedHit[] = [];
    private readonly clock: Clock;
    private readonly weak: boolean;
    private readonly inodeEtags: boolean;
    private readonly etagScope: 'token' | 'content';
    private readonly repo: string;
    /** Bumped by `mutate()`; the resource's content version. */
    private version = 1;
    /** Per-token ETag suffix, so two credentials never mint the same validator string. */
    private readonly tokenTag = new Map<string, string>();
    private nextTokenTag = 0;
    /** Monotonic counter behind `inodeEtags` — a new "inode" on every single response. */
    private inode = 0;

    constructor(opts: EtagApiOptions) {
        this.clock = opts.clock;
        this.weak = opts.weak ?? false;
        this.inodeEtags = opts.inodeEtags ?? false;
        this.etagScope = opts.etagScope ?? 'token';
        this.repo = opts.repo ?? 'octo/hello';
    }

    /** The resource's URL. */
    get url(): string {
        return `${HOST}/repos/${this.repo}/issues`;
    }

    /** Responses that would COUNT against a rate limit — every non-304. The payoff metric. */
    get billed(): number {
        return this.hits.filter((h) => h.billed).length;
    }

    /** How many requests arrived at all (billed or not). */
    get requests(): number {
        return this.hits.length;
    }

    /** How many were answered `304 Not Modified`. */
    get notModified(): number {
        return this.hits.filter((h) => h.status === 304).length;
    }

    /** The byte-exact `If-None-Match` value on every request, in order. */
    get validators(): string[] {
        return this.hits.map((h) => h.inm);
    }

    /** The status of every response, in order. */
    get statuses(): number[] {
        return this.hits.map((h) => h.status);
    }

    /** Change the resource. Every stored validator is now stale. */
    mutate(): void {
        this.version += 1;
    }

    /** The validator this server would mint right now for `token`. */
    etagFor(token: string): string {
        if (!this.tokenTag.has(token))
            this.tokenTag.set(token, `t${(this.nextTokenTag += 1)}`);
        const scope =
            this.etagScope === 'content'
                ? ''
                : `.${this.tokenTag.get(token) ?? 't0'}`;
        const tag = this.inodeEtags
            ? `i${(this.inode += 1)}`
            : `v${this.version}${scope}`;
        return this.weak ? `W/"${tag}"` : `"${tag}"`;
    }

    /** The body served at the current version, as `token` sees it. */
    body(token: string): Issues {
        return {
            repo: this.repo,
            version: this.version,
            viewer: token,
            issues: Array.from({ length: this.version }, (_, i) => ({
                id: i + 1,
                title: `issue ${i + 1} for ${token}`,
            })),
        };
    }

    /** A StitchAPI {@link Adapter} bound to this server. */
    adapter(): Adapter {
        return async (req: AdapterRequest): Promise<AdapterResponse> => {
            const { status, etag, body } = this.handle(
                req.method,
                req.url,
                req.headers,
            );
            // A real 304 carries NO body. `fetchAdapter` decodes an empty JSON response as
            // `undefined` (http-adapter.ts:135), so that is what the wire hands the engine.
            return {
                status,
                headers: { etag, 'content-type': 'application/json' },
                body,
            };
        };
    }

    /**
     * A `fetch`-shaped entry point onto the same server. C9's hand-rolled twin drives this, and the
     * StitchAPI side drives it through the REAL `fetchAdapter({ fetch })` — so the comparison runs
     * both implementations over one transport contract rather than giving either a shortcut.
     */
    fetchImpl(): typeof fetch {
        return async (input, init) => {
            const url = typeof input === 'string' ? input : String(input);
            const headers: Record<string, string> = {};
            new Headers(init?.headers).forEach((v, k) => {
                headers[k] = v;
            });
            const { status, etag, body } = this.handle(
                init?.method ?? 'GET',
                url,
                headers,
            );
            return new Response(status === 304 ? null : JSON.stringify(body), {
                status,
                headers: { etag, 'content-type': 'application/json' },
            });
        };
    }

    /** The one request handler both entry points share. */
    private handle(
        method: string,
        url: string,
        headers: Record<string, string>,
    ): { status: number; etag: string; body: Issues | undefined } {
        const inm = header(headers, 'if-none-match');
        const auth = header(headers, 'authorization');
        const token = auth ? auth.replace(/^Bearer\s+/i, '') : '(none)';
        const current = this.etagFor(token);
        const matched = inm !== undefined && weakMatch(inm, current);
        const status = matched ? 304 : 200;
        this.hits.push({
            method,
            path: new URL(url).pathname,
            inm: inm ?? '(none)',
            token,
            status,
            billed: status !== 304,
            at: this.clock.now(),
        });
        return {
            status,
            etag: current,
            body: matched ? undefined : this.body(token),
        };
    }
}
