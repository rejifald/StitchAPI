// C2 — DECIDING. Can the model's `input` object redirect or rewrite the call?
//
// `run_stitch({ name, input })` takes a free-form object, so `input` is the security boundary. The
// capture's hypothesis came from scenario 10, which measured `engine.ts:231`:
//
//   const headers = { ...(cfg.headers ?? {}), ...(input.headers ?? {}) };
//
// input headers merge OVER config headers. If the model's object reached that merge unfiltered, a
// prompt injection could set any header on a call it did not author. **That hypothesis is refuted
// for the MCP path**, and the reason is a named function that exists for exactly this:
// `sanitizeAgentInput` (mcp.ts:125-130) deletes `input.headers` unless the stitch declares an
// `input.headers` schema. This script measures the strip, then measures precisely what a stitch
// that DOES opt in exposes — and then walks every other field of the input object.
//
// Every assertion is on what the recording adapter received, so "the model can set this field" and
// "this is what the vendor saw" are never conflated.
//
//   pnpm exec tsx docs/scenarios/proofs/agent-holds-the-tool/c2-input-rewrite.ts
import {
    apiKey,
    bearer,
    cookieSession,
    env,
} from '../../../../packages/core/src/auth';
import { seam } from '../../../../packages/core/src/index';
import type { StitchRegistry } from '../../../../packages/core/src/registry';
import { inProcess } from './client';
import { check, checkWire, finish, heading, note } from './harness';
import { buildRegistry, schema } from './stitches';
import { BASE, ENV, SECRETS, Wire, installSecrets, route } from './vendor';

const anyObject = schema(
    'an object',
    (v) => v === undefined || (typeof v === 'object' && v !== null),
);

/**
 * The variant shapes C2 needs that an ordinary registry would not contain: a stitch that opts into
 * agent headers AND carries a cookie session, a stitch whose path uses RFC 6570 reserved expansion
 * (`{+id}`, which does not percent-encode `/`), and a stitch whose whole `url` is a template.
 *
 * They are built here rather than in `stitches.ts` because they are not what an operator would
 * normally write — they are the authoring choices whose blast radius C2 is quantifying.
 */
function variants(wire: Wire): StitchRegistry {
    const api = seam({ baseUrl: BASE, adapter: wire.adapter() });
    const login = api.stitch({
        name: 'login',
        method: 'POST',
        path: '/auth/login',
    });
    return {
        // Opts into agent headers, and its credential is a COOKIE — the one strategy whose header
        // the engine merges into rather than overwrites (`setCookiePair`, auth.ts:228-245).
        profileOpenHeaders: api.stitch({
            name: 'profileOpenHeaders',
            path: '/v1/profile',
            auth: cookieSession({
                login,
                cookie: 'SESSION',
                tenancy: 'app',
                loginInput: () => ({
                    body: { user: 'svc', password: env(ENV.loginPassword)() },
                }),
            }),
            input: { headers: anyObject },
            pick: 'data',
        }),
        // Reserved expansion: `{+id}` renders `/` and `.` literally (util.ts:369-379).
        orderReserved: api.stitch({
            name: 'orderReserved',
            path: '/v1/orders/{+id}',
            auth: bearer(env(ENV.bearer)),
        }),
        // The whole endpoint is a template, and `url` bypasses `baseUrl` entirely (engine.ts:184).
        openEndpoint: api.stitch({
            name: 'openEndpoint',
            url: '{+endpoint}',
            auth: bearer(env(ENV.bearer)),
        }),
    };
}

async function main(): Promise<void> {
    installSecrets();
    const wire = new Wire(route);
    const registry = buildRegistry(wire);
    const client = await inProcess(registry);

    heading('C2 (a) — headers, on a stitch that does NOT declare a schema');
    wire.reset();
    const injected = await client.callTool('run_stitch', {
        name: 'getOrder',
        input: {
            params: { id: '77' },
            headers: {
                authorization: 'Bearer attacker-token',
                cookie: 'SESSION=attacker',
                host: 'evil.test',
                'x-forwarded-for': '127.0.0.1',
                'content-type': 'text/plain',
                'x-anything': 'anything',
            },
        },
    });
    check('the call still succeeded', injected.isError, false);
    checkWire('headers (6 sent by the model)', Object.keys(wire.last.headers), [
        'authorization',
    ]);
    checkWire(
        '.authorization',
        wire.last.headers['authorization'],
        `Bearer ${SECRETS.bearer}`,
    );
    note(
        'sanitizeAgentInput deleted the whole slot',
        'mcp.ts:128 — `if (stitch.__config.input?.headers === undefined) delete obj.headers`',
    );

    heading('C2 (b) — headers, on a stitch that DOES declare a schema');
    wire.reset();
    await client.callTool('run_stitch', {
        name: 'searchOrders',
        input: {
            headers: {
                authorization: 'Bearer attacker-token',
                cookie: 'SESSION=attacker',
                'x-forwarded-for': '10.0.0.1',
                'x-actor': 'admin',
            },
        },
    });
    checkWire(
        '.authorization (auth applies LAST)',
        wire.last.headers['authorization'],
        `Bearer ${SECRETS.bearer}`,
    );
    checkWire('.cookie', wire.last.headers['cookie'], 'SESSION=attacker');
    checkWire(
        '.x-forwarded-for',
        wire.last.headers['x-forwarded-for'],
        '10.0.0.1',
    );
    checkWire('.x-actor', wire.last.headers['x-actor'], 'admin');
    note(
        'the model cannot overwrite the credential header',
        'engine.ts:647 applies `auth` to a clone of the built request, AFTER the input merge — so `authorization` is rewritten every time',
    );
    note(
        'it CAN set every other header',
        'an audit header, a tenant header, an X-Forwarded-For a vendor trusts, a Cookie on a non-cookie stitch',
    );

    heading(
        'C2 (c) — headers on a COOKIE-session stitch: the two cookie writers disagree',
    );
    const varWire = new Wire(route);
    const varClient = await inProcess(variants(varWire));
    varWire.reset();
    const profile = await varClient.callTool('run_stitch', {
        name: 'profileOpenHeaders',
        input: { headers: { cookie: 'tracking=xyz; SESSION=attacker' } },
    });
    // `cookieSession.apply` CONCATENATES (auth.ts:918-921) rather than replacing, so the model's
    // pair is sent FIRST and the real session second. RFC 6265 §5.4 gives no ordering rule for a
    // duplicate name; Express, Rails, Go's net/http and PHP all read the FIRST occurrence.
    checkWire(
        '.cookie (model pair, then the real session)',
        varWire.last.headers['cookie'],
        `tracking=xyz; SESSION=attacker; SESSION=${SECRETS.session}`,
    );
    check(
        'a vendor that reads the FIRST pair sees the MODEL’s session',
        profile.isError,
        true,
    );
    note(
        'cookieSession.apply is a plain join (auth.ts:918-921)',
        '`req.headers.cookie = [req.headers.cookie, cookie].filter(Boolean).join("; ")` — no same-name replacement',
    );
    // The contrast: `apiKey({ in: 'cookie' })` writes the same header through `setCookiePair`,
    // which DOES replace a same-named pair (auth.ts:228-245). Same header, two behaviours.
    const cookieKeyWire = new Wire(route);
    const cookieKeyApi = seam({
        baseUrl: BASE,
        adapter: cookieKeyWire.adapter(),
    });
    const cookieKeyClient = await inProcess({
        reportsViaCookie: cookieKeyApi.stitch({
            name: 'reportsViaCookie',
            path: '/v1/reports',
            auth: apiKey({
                in: 'cookie',
                name: 'SESSION',
                secret: env(ENV.apiKeyHeader),
            }),
            input: { headers: anyObject },
        }),
    });
    await cookieKeyClient.callTool('run_stitch', {
        name: 'reportsViaCookie',
        input: { headers: { cookie: 'tracking=xyz; SESSION=attacker' } },
    });
    checkWire(
        '.cookie under apiKey({ in: "cookie" })',
        cookieKeyWire.last.headers['cookie'],
        `tracking=xyz; SESSION=${SECRETS.apiKeyHeader}`,
    );
    note(
        'the same header, two behaviours',
        'apiKey uses setCookiePair (replace); cookieSession uses a join (prepend) — only the second is forgeable',
    );

    heading('C2 (d) — query: can the model overwrite an operator’s pin?');
    wire.reset();
    const pinned = await client.callTool('run_stitch', { name: 'listOrders' });
    check(
        'default tenant, echoed by the vendor',
        (
            pinned.message.result as { content: { text: string }[] }
        ).content[0]?.text.includes('"tenant": "acme"'),
        true,
    );
    wire.reset();
    const stolen = await client.callTool('run_stitch', {
        name: 'listOrders',
        input: { query: { tenant: 'globex' } },
    });
    checkWire('url', wire.last.url, `${BASE}/v1/orders?tenant=globex`);
    check(
        'the vendor echoed the MODEL’s tenant',
        (
            stolen.message.result as { content: { text: string }[] }
        ).content[0]?.text.includes('"tenant": "globex"'),
        true,
    );
    note(
        'engine.ts:202 — `{ ...predefined, ...(input.query ?? {}) }`',
        'a query parameter pinned in the configured path is a DEFAULT, not a constraint',
    );

    heading(
        'C2 (e) — query on the apiKey(query) stitch: can the key be shadowed?',
    );
    wire.reset();
    const shadow = await client.callTool('run_stitch', {
        name: 'getMetrics',
        input: { query: { api_key: 'attacker-key' } },
    });
    checkWire(
        'url',
        wire.last.url,
        [
            `${BASE}/v1/metrics?api_key=attacker-key&api_key=${SECRETS.apiKeyQuery}`,
        ][0],
    );
    check(
        'the vendor read the FIRST api_key and rejected the call',
        shadow.text,
        'HTTP 401',
    );
    note(
        'the real key is APPENDED, not substituted (auth.ts:289)',
        'a model can therefore break its own call — a self-inflicted 401, not an escalation; no credential is disclosed either way',
    );

    heading('C2 (f) — params: path traversal');
    wire.reset();
    await client.callTool('run_stitch', {
        name: 'getOrder',
        input: { params: { id: '../../v1/api-keys' } },
    });
    checkWire(
        'url with a simple {id} template',
        wire.last.url,
        `${BASE}/v1/orders/..%2F..%2Fv1%2Fapi-keys`,
    );
    note(
        'RFC 6570 simple expansion percent-encodes the separator (util.ts:377)',
        'so the request stayed on the endpoint the operator authored',
    );
    varWire.reset();
    await varClient.callTool('run_stitch', {
        name: 'orderReserved',
        input: { params: { id: '../../v1/api-keys' } },
    });
    checkWire(
        'url with a RESERVED {+id} template',
        varWire.last.url,
        `${BASE}/v1/orders/../../v1/api-keys`,
    );
    check(
        'and the request normalises onto a DIFFERENT endpoint',
        new URL(varWire.last.url).pathname,
        '/v1/api-keys',
    );
    checkWire(
        'with the real credential attached',
        varWire.last.headers['authorization'],
        `Bearer ${SECRETS.bearer}`,
    );

    heading('C2 (g) — anything URL-shaped');
    wire.reset();
    await client.callTool('run_stitch', {
        name: 'getOrder',
        input: {
            params: { id: '77' },
            url: 'https://evil.test/steal',
            baseUrl: 'https://evil.test',
            path: '/steal',
            adapter: 'x',
            auth: 'x',
        },
    });
    checkWire('url (6 rogue keys sent)', wire.last.url, `${BASE}/v1/orders/77`);
    note(
        'the engine reads input by FIELD NAME',
        '`url`/`baseUrl`/`path`/`adapter`/`auth` are config slots, not input slots — an unknown key is inert',
    );
    varWire.reset();
    const ssrf = await varClient.callTool('run_stitch', {
        name: 'openEndpoint',
        input: { params: { endpoint: 'https://metadata.internal/latest' } },
    });
    checkWire(
        'url when the WHOLE endpoint is a {+template}',
        varWire.last.url,
        'https://metadata.internal/latest',
    );
    check('and it reached the internal service', ssrf.isError, false);
    checkWire(
        'with the vendor credential attached',
        varWire.last.headers['authorization'],
        `Bearer ${SECRETS.bearer}`,
    );

    heading('C2 (h) — body, on a write with no body schema');
    wire.reset();
    const refunded = await client.callTool('run_stitch', {
        name: 'refund',
        input: { body: { amount: 999_999, note: 'chosen by the model' } },
    });
    checkWire('body', wire.last.body, {
        amount: 999_999,
        note: 'chosen by the model',
    });
    check('the write succeeded', refunded.isError, false);
    note('the body is the model’s, whole', refunded.text.replace(/\s+/g, ' '));

    heading('C2 (i) — the fields the sanitizer does not name');
    wire.reset();
    const signalled = await client.callTool('run_stitch', {
        name: 'getOrder',
        input: { params: { id: '77' }, signal: { aborted: true } },
    });
    // `signal` is a runtime-only slot (`AbortSignal`), and JSON can only fill it with a plain
    // object. The engine threads it onto the request regardless (engine.ts:250), so the model can
    // make a call fail before it is sent — a self-inflicted denial, with no request on the wire.
    check(
        'run_stitch with a forged input.signal → isError',
        signalled.isError,
        true,
    );
    check('…and no request reached the vendor', wire.count, 0);
    note('the error the model got back', signalled.text);
    note(
        'sanitizeAgentInput is a DENYLIST of one key, not an allowlist',
        'only `headers` is removed — every other input slot, present and future, is forwarded to the engine as-authored',
    );

    finish(
        'C2',
        "THE CAPTURE'S HEADER HYPOTHESIS IS REFUTED; FIVE OTHER LEVERS ARE REAL. The `engine.ts:231` header merge is real, but `sanitizeAgentInput` (mcp.ts:125-130) deletes `input.headers` before it: six model-supplied headers including `authorization`, `cookie` and `host` reached the vendor as ZERO headers, and the only header on the wire was the real `Bearer sk_live_…`. The credential header specifically is unforgeable even when a stitch DOES opt in, because `auth` is applied to a clone AFTER the merge (engine.ts:647) — `authorization` was rewritten to the real token on every attempt. What the model CAN do, ON AN ORDINARY STITCH WITH NO OPT-IN: (1) OVERWRITE A QUERY PARAMETER PINNED IN THE CONFIGURED PATH — `tenant=acme` became `tenant=globex` and the vendor returned the other tenant's data, because `{ ...predefined, ...input.query }` makes a pin a default; (2) send the entire request BODY of a write, uncapped, when no `input.body` schema is declared (a 999,999 refund); (3) shadow an `apiKey({ in: 'query' })` credential with a duplicate parameter, and abort a call before it is sent with a forged `input.signal` — both self-inflicted denials, no disclosure. And where the OPERATOR opted in: (4) with an `input.headers` schema, every non-credential header — and on a `cookieSession` stitch the model's `SESSION=attacker` is sent BEFORE the real one, measured `SESSION=attacker; SESSION=sess_live_…`, because `cookieSession.apply` joins where `apiKey({ in: 'cookie' })` replaces (auth.ts:918-921 vs 228-245); a vendor that reads the first pair runs the call as the model's session; (5) with RFC 6570 reserved expansion, cross-endpoint traversal WITH the credential attached — `{+id}` sent the bearer token to `/v1/api-keys`, while the ordinary `{id}` percent-encoded it to `..%2F..%2F`, and templating the whole endpoint (`url: '{+endpoint}'`) reached `metadata.internal`. Nothing URL-shaped in `input` is read otherwise: `url`, `baseUrl`, `path`, `adapter` and `auth` keys were inert",
    );
}

void main();
