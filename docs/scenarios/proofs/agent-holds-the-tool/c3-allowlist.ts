// C3 — is there an allow-list, and what do the discovery tools disclose?
//
// Two questions, and they pull in opposite directions. An agent needs to know what it may call, so
// `list_stitches` and `describe_stitch` exist to tell it; the same read-out is a map of the
// operator's internal API handed to a caller that may be reciting an attacker's prompt. This
// script measures exactly what is on that map, and then measures what — if anything — keeps a
// stitch off it.
//
// The answer to the second question is the shape of the surface: `createMcpServer(registry)` takes
// a `StitchRegistry`, so the allow-list IS the object you pass, and there is no per-stitch opt-in.
// That is a defensible design, but `stitch mcp` (the documented way to start the server) builds
// that object with `collectStitches`, which sweeps up EVERY stitch a module exports — so the
// default exposure is "everything in the file", including a write and a stitch that only exists to
// serve another stitch's login.
//
// And one bypass worth knowing about: `selectStitch` resolves a name against the registry KEY and,
// failing that, against each stitch's CONFIGURED `name` — so leaving a stitch out of the keys is
// not the same as leaving it out of the registry.
//
//   pnpm exec tsx docs/scenarios/proofs/agent-holds-the-tool/c3-allowlist.ts
import { bearer, env } from '../../../../packages/core/src/auth';
import { seam } from '../../../../packages/core/src/index';
import { collectStitches } from '../../../../packages/core/src/registry';
import { inProcess } from './client';
import {
    check,
    checkDiscloses,
    checkSeq,
    finish,
    heading,
    note,
} from './harness';
import { buildRegistry } from './stitches';
import { BASE, ENV, Wire, installSecrets, route } from './vendor';

interface Described {
    name: string;
    endpoint: string;
    surface: string;
    input: Record<string, boolean>;
    output: { validated: boolean; pick: string | null };
    auth: string | null;
    policies: Record<string, boolean>;
    pipeline: string[];
    diagram: string;
}

async function main(): Promise<void> {
    installSecrets();
    const wire = new Wire(route);
    const registry = buildRegistry(wire);
    const client = await inProcess(registry);

    heading('C3 (a) — can the model run ANY registered stitch?');
    const listed = JSON.parse(
        (await client.callTool('list_stitches')).text,
    ) as { name: string; method: string; path: string }[];
    checkSeq(
        'list_stitches names',
        listed.map((s) => s.name),
        Object.keys(registry).sort(),
    );
    check(
        'every registered name is listed',
        listed.length,
        Object.keys(registry).length,
    );
    wire.reset();
    const wrote = await client.callTool('run_stitch', {
        name: 'refund',
        input: { body: { amount: 1 } },
    });
    check('an irreversible POST ran on first ask', wrote.isError, false);
    check('…and reached the vendor', wire.count, 1);
    note(
        'there is no per-stitch opt-in',
        'no config key excludes a stitch from MCP — StitchConfig has 32 top-level slots and none is `mcp`/`expose`/`internal`/`agent`',
    );
    // The nearest-looking key is `sensitive: true`, which reads like "do not expose this" and is
    // in fact a CACHE opt-out (types.ts:1652-1658). An operator who reaches for it gets no
    // agent-visibility change at all.
    const sensitiveWire = new Wire(route);
    const sensitiveApi = seam({
        baseUrl: BASE,
        adapter: sensitiveWire.adapter(),
    });
    const sensitiveClient = await inProcess({
        oneTimeToken: sensitiveApi.stitch({
            name: 'oneTimeToken',
            method: 'POST',
            path: '/v1/api-keys',
            auth: bearer(env(ENV.bearer)),
            cache: '1m',
            sensitive: true,
        }),
    });
    const stillListed = JSON.parse(
        (await sensitiveClient.callTool('list_stitches')).text,
    ) as { name: string }[];
    checkSeq(
        '`sensitive: true` is still listed',
        stillListed.map((s) => s.name),
        ['oneTimeToken'],
    );
    const stillRuns = await sensitiveClient.callTool('run_stitch', {
        name: 'oneTimeToken',
    });
    check('…and still runs', stillRuns.isError, false);
    note(
        '`sensitive` is a cache opt-out, not a visibility flag (types.ts:1652-1658)',
        'the one config word that reads like "do not expose this" changes nothing about who may call it',
    );

    heading('C3 (b) — what `list_stitches` discloses');
    note('per stitch', JSON.stringify(listed[0]));
    checkDiscloses('the route table', JSON.stringify(listed), '/v1/refunds');
    checkDiscloses(
        '…including the login route',
        JSON.stringify(listed),
        '/auth/login',
    );
    check(
        'the base URL is NOT in list_stitches',
        JSON.stringify(listed).includes(BASE),
        false,
    );

    heading('C3 (c) — what `describe_stitch` discloses');
    const described = JSON.parse(
        (await client.callTool('describe_stitch', { name: 'getMetrics' })).text,
    ) as Described;
    checkSeq('keys returned', Object.keys(described), [
        'name',
        'endpoint',
        'surface',
        'input',
        'output',
        'auth',
        'policies',
        'pipeline',
        'diagram',
    ]);
    check(
        'endpoint (the full internal URL)',
        described.endpoint,
        `GET ${BASE}/v1/metrics`,
    );
    check('auth (the SCHEME, not the credential)', described.auth, 'apiKey');
    note('input slots', JSON.stringify(described.input));
    note('policies', JSON.stringify(described.policies));
    note('pipeline', JSON.stringify(described.pipeline));
    note('diagram bytes', described.diagram.length);
    checkDiscloses(
        'the diagram repeats the endpoint',
        described.diagram,
        `${BASE}/v1/metrics`,
    );
    const bearerDescribed = JSON.parse(
        (await client.callTool('describe_stitch', { name: 'getOrder' })).text,
    ) as Described;
    check('a bearer stitch reports its scheme', bearerDescribed.auth, 'bearer');
    const sessionDescribed = JSON.parse(
        (await client.callTool('describe_stitch', { name: 'getProfile' })).text,
    ) as Described;
    check(
        'a cookie session reports apiKey (its declared scheme)',
        sessionDescribed.auth,
        'apiKey',
    );
    const loginDescribed = JSON.parse(
        (await client.callTool('describe_stitch', { name: 'login' })).text,
    ) as Described;
    check('a stitch with no auth reports null', loginDescribed.auth, null);

    heading('C3 (d) — what `describe_stitch` does NOT disclose');
    const secretWire = new Wire(route);
    const secretApi = seam({ baseUrl: BASE, adapter: secretWire.adapter() });
    const secretClient = await inProcess({
        internalOrders: secretApi.stitch({
            name: 'internalOrders',
            path: '/v1/orders',
            auth: bearer(env(ENV.bearer)),
            // Operator-set request headers: an internal tenant pin and a routing hint.
            headers: {
                'x-internal-tenant': 'acme-prod',
                'x-route-to': 'shard-7.internal',
            },
        }),
    });
    const internal = (
        await secretClient.callTool('describe_stitch', {
            name: 'internalOrders',
        })
    ).text;
    check(
        'configured request HEADERS are absent',
        internal.includes('x-internal-tenant') ||
            internal.includes('shard-7.internal'),
        false,
    );
    check(
        'the env VAR NAME the credential comes from is absent',
        internal.includes(ENV.bearer),
        false,
    );
    note(
        'those headers still ride every request',
        'the model cannot see them; it also cannot know they are what pins the tenant',
    );

    heading('C3 (e) — the allow-list bypass: keys are not the only names');
    // An operator filters the registry down to "the safe two" and renames the key, believing the
    // rename hides the original. `selectStitch` resolves the registry KEY first and then falls
    // back to each stitch's CONFIGURED `name` (registry.ts:71-74).
    const filtered = {
        readOnlyOrders: registry['getOrder'] as (typeof registry)['getOrder'],
    };
    const filteredClient = await inProcess(filtered);
    const byKey = await filteredClient.callTool('run_stitch', {
        name: 'readOnlyOrders',
        input: { params: { id: '77' } },
    });
    check('reachable by its registry key', byKey.isError, false);
    const byConfigName = await filteredClient.callTool('run_stitch', {
        name: 'getOrder',
        input: { params: { id: '77' } },
    });
    check('ALSO reachable by its configured name', byConfigName.isError, false);
    const filteredList = JSON.parse(
        (await filteredClient.callTool('list_stitches')).text,
    ) as { name: string }[];
    checkSeq(
        'but list_stitches shows only the key',
        filteredList.map((s) => s.name),
        ['readOnlyOrders'],
    );
    note(
        'a name the discovery tool never mentions is still callable',
        'registry.ts:71-74 — key first, then a scan of every `__config.name`',
    );

    heading('C3 (f) — what `stitch mcp` exposes by default');
    // The CLI builds its registry with `collectStitches`, which recognises a stitch structurally
    // and keys it by its EXPORT NAME. A module-shaped object stands in for the user's stitches.ts.
    const moduleShaped = {
        getOrder: registry['getOrder'],
        refund: registry['refund'],
        login: registry['login'],
        // Not a stitch — ignored, which is the only filtering `collectStitches` does.
        BASE_URL: BASE,
        helper: () => 'not a stitch',
    };
    const collected = collectStitches(moduleShaped);
    checkSeq('collectStitches keys', Object.keys(collected).sort(), [
        'getOrder',
        'login',
        'refund',
    ]);
    note(
        'the default exposure is the whole module',
        '`stitch mcp --module ./stitches.ts` (cli.ts:654-657) hands `collectStitches(mod)` straight to serveStdio — a write and an internal login stitch included',
    );

    finish(
        'C3',
        "NO ALLOW-LIST BEYOND THE REGISTRY OBJECT, AND THE DISCOVERY TOOLS ARE A MAP. Every registered stitch is equally callable: an irreversible `POST /v1/refunds` ran on first ask with no opt-in, and none of `StitchConfig`'s 32 top-level slots excludes a stitch from MCP — the nearest-looking word, `sensitive: true`, is a CACHE opt-out (types.ts:1652-1658) and a stitch carrying it was still listed and still ran. The allow-list is therefore the object handed to `createMcpServer` — which is a real, usable seam (one `Object.fromEntries` filter, measured in C8) — but the documented starter, `stitch mcp --module ./stitches.ts`, builds that object with `collectStitches`, which sweeps up EVERY exported stitch: the module here exposed a write and a login stitch alongside the read. DISCLOSED to the model: every stitch NAME, METHOD and PATH from `list_stitches`; and from `describe_stitch`, the full internal endpoint URL (`GET https://api.vendor.test/v1/metrics`), the surface, which input slots exist, whether output is validated, THE AUTH SCHEME, which of retry/throttle/cache/timeout are on, the engine-order pipeline, and a Mermaid diagram that repeats the endpoint — about 1KB per stitch. NOT disclosed: the credential (C1), the operator's configured request headers (an `x-internal-tenant` pin and an internal shard hostname stayed hidden), and the env var name the credential resolves from. THE BYPASS: `selectStitch` falls back from the registry key to each stitch's CONFIGURED `name` (registry.ts:71-74), so a filtered registry that RENAMES a stitch still answers to the original name — reachable, and absent from `list_stitches`, at the same time",
    );
}

void main();
