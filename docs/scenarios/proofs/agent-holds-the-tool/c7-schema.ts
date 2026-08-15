// C7 — schema quality. Is `input` typed enough for a model to use correctly, and does a declared
// schema constrain what the model may send?
//
// Three findings, in increasing order of consequence:
//
//   1. The TOOL schema is four untyped bags. `run_stitch.inputSchema` says `input` has `params`,
//      `query`, `headers` (objects) and `body` (anything) — with no per-stitch shape, no
//      `required`, and no `additionalProperties: false`. A model choosing arguments has nothing
//      here to be correct against.
//   2. `describe_stitch` reports PRESENCE, not shape. A stitch whose `params` schema demands
//      `{ id: <digits> }` is described to the model as `"params": true`. The schema is on the
//      config (`__config.input.params`) and is simply not projected, so the model must guess and
//      find out by failing.
//   3. A declared schema covers ONE slot — and since #663 it FILTERS that slot. This audit first
//      measured `validateInput` throwing on failure and otherwise DISCARDING the parsed value, so
//      a stripping schema let the model's `tenant=globex` through to the wire; we filed that as
//      #648, and #663 fixed it: `validateInput` (engine.ts:415-447) now RETURNS each declared
//      slot's parsed value — coerced, defaulted, stripped — and the engine runs on it. Section (e)
//      is the regression pin. What remains is (d): an UNDECLARED slot is the full passthrough.
//
// The good news is real and worth stating first: validation runs BEFORE any request is built, so a
// slot that fails its contract costs the vendor nothing.
//
//   pnpm exec tsx docs/scenarios/proofs/agent-holds-the-tool/c7-schema.ts
import { bearer, env } from '../../../../packages/core/src/auth';
import { seam } from '../../../../packages/core/src/index';
import type { Validator } from '../../../../packages/core/src/validator';
import { inProcess } from './client';
import { check, checkSeq, checkWire, finish, heading, note } from './harness';
import { buildRegistry } from './stitches';
import { BASE, ENV, Wire, installSecrets, route } from './vendor';

interface RunStitchSchema {
    type: string;
    properties: {
        name: { type: string; description: string };
        input: {
            type: string;
            description: string;
            properties: Record<string, unknown>;
            required?: string[];
            additionalProperties?: boolean;
        };
    };
    required: string[];
}

/**
 * A validator shaped like every mainstream schema library's default object mode: it ACCEPTS the
 * value and returns a copy with unknown keys removed. Zod's `.parse`, Valibot's `object`, ArkType's
 * default — all of them strip. The question is whether the engine uses what came back — before
 * #663 it did not; (e) pins that it now does.
 */
const strippingQuery: Validator = {
    validate: (value) =>
        Promise.resolve({
            ok: true as const,
            value: { limit: (value as { limit?: unknown } | undefined)?.limit },
        }),
};

async function main(): Promise<void> {
    installSecrets();
    const wire = new Wire(route);
    const registry = buildRegistry(wire);
    const client = await inProcess(registry);

    heading('C7 (a) — what the TOOL schema tells a model');
    const tools = (
        (await client.send('tools/list')).message.result as {
            tools: { name: string; inputSchema: unknown }[];
        }
    ).tools;
    const runSchema = tools.find((t) => t.name === 'run_stitch')
        ?.inputSchema as RunStitchSchema;
    checkSeq('run_stitch top-level required', runSchema.required, ['name']);
    checkSeq(
        'input slots offered',
        Object.keys(runSchema.properties.input.properties),
        ['params', 'query', 'body', 'headers'],
    );
    checkSeq(
        'their declared types',
        Object.values(runSchema.properties.input.properties).map(
            (v) => (v as { type?: string }).type ?? '(anything)',
        ),
        ['object', 'object', '(anything)', 'object'],
    );
    check(
        'input.additionalProperties',
        runSchema.properties.input.additionalProperties,
        undefined,
    );
    check('input.required', runSchema.properties.input.required, undefined);
    const listSchema = tools.find((t) => t.name === 'list_stitches')
        ?.inputSchema as { additionalProperties?: boolean };
    check(
        'by contrast, list_stitches is closed',
        listSchema.additionalProperties,
        false,
    );
    note(
        'the tool schema is the same four bags for every stitch',
        'code-mode’s whole premise — one tool, constant context — is why it cannot carry a per-stitch shape',
    );

    heading(
        'C7 (b) — what `describe_stitch` tells a model about a TYPED stitch',
    );
    const described = JSON.parse(
        (await client.callTool('describe_stitch', { name: 'getOrderTyped' }))
            .text,
    ) as { input: Record<string, boolean> };
    checkSeq('input read-out', Object.entries(described.input).flat(), [
        'params',
        true,
        'query',
        false,
        'body',
        false,
        'headers',
        false,
    ]);
    note(
        'the stitch’s params contract is `{ id: <digits> }`',
        'the model is told `true` — not the key name, not the type, not the pattern',
    );
    const guess = await client.callTool('run_stitch', {
        name: 'getOrderTyped',
        input: { params: { orderId: 77 } },
    });
    check('a plausible guess fails', guess.isError, true);
    note('and the failure is the only teacher', guess.text);

    heading('C7 (c) — the good half: validation runs BEFORE the request');
    wire.reset();
    await client.callTool('run_stitch', {
        name: 'getOrderTyped',
        input: { params: { id: 'not-a-number' } },
    });
    check('a failed contract costs the vendor nothing', wire.count, 0);
    note(
        'engine.ts:1773 — `input = await validateInput(cfg, callInput)` is the first thing `execute` does',
        'ahead of buildRequest, auth, throttle and the adapter',
    );

    heading('C7 (d) — a schema constrains ONE slot, not the input object');
    wire.reset();
    const sideDoor = await client.callTool('run_stitch', {
        name: 'getOrderTyped',
        input: {
            params: { id: '77' },
            // No `query` schema is declared on this stitch, so nothing checks this.
            query: { tenant: 'globex', include: 'internal_notes' },
        },
    });
    check('the call succeeded', sideDoor.isError, false);
    checkWire(
        'url',
        wire.last.url,
        `${BASE}/v1/orders/77?tenant=globex&include=internal_notes`,
    );
    note(
        'declaring `input.params` says nothing about `input.query`',
        'the slots are independent, and an undeclared slot is an open passthrough',
    );

    heading(
        'C7 (e) — a declared schema FILTERS: the request is built from the parsed value (#663)',
    );
    const stripWire = new Wire(route);
    const stripApi = seam({ baseUrl: BASE, adapter: stripWire.adapter() });
    const stripClient = await inProcess({
        listOrders: stripApi.stitch({
            name: 'listOrders',
            path: '/v1/orders?tenant=acme',
            auth: bearer(env(ENV.bearer)),
            // A schema that ACCEPTS and returns `{ limit }` only — every mainstream object schema
            // strips unknown keys like this by default.
            input: { query: strippingQuery },
        }),
    });
    const stripped = await stripClient.callTool('run_stitch', {
        name: 'listOrders',
        input: { query: { limit: 10, tenant: 'globex' } },
    });
    check('the schema accepted the input', stripped.isError, false);
    check(
        'the validator returned only `limit`',
        JSON.stringify(
            (await strippingQuery.validate({ limit: 10, tenant: 'globex' }))
                .ok === true
                ? { limit: 10 }
                : null,
        ),
        '{"limit":10}',
    );
    checkWire(
        'and the wire carries what the validator RETURNED',
        stripWire.last.url,
        `${BASE}/v1/orders?tenant=acme&limit=10`,
    );
    check(
        'the stripped key is gone and the operator’s pin survives',
        new URL(stripWire.last.url).searchParams.get('tenant'),
        'acme',
    );
    note(
        'engine.ts:444 — `out[part] = r.value`: the parsed value replaces the slot',
        'validateInput returns the input the request is built from (engine.ts:415-447), and `execute` runs on it — the same parsed-value rule `output` has had since ADR 0015',
    );
    note(
        'before #663 this section measured `?tenant=globex&limit=10` — the parsed value was discarded',
        'filed from this audit as #648; the two checks above are the regression pin on the fix',
    );

    finish(
        'C7',
        "THE MODEL IS TOLD A SLOT EXISTS AND NEVER WHAT GOES IN IT — AND A DECLARED SCHEMA NOW FILTERS ITS SLOT, WHILE AN UNDECLARED SLOT STAYS A FULL PASSTHROUGH. The tool schema is four untyped bags — `params`/`query`/`headers` typed `object`, `body` typed as anything, no `required`, no `additionalProperties: false` (while `list_stitches`, which takes nothing, IS closed) — and it is identical for every stitch, because one tool for every endpoint is what code-mode buys its constant context with. `describe_stitch` does not make up the difference: a stitch whose `params` contract is `{ id: <digits> }` is described as `\"params\": true`, so a model that guesses `{ orderId: 77 }` learns the shape only by failing. TWO HALVES ARE NOW GENUINELY GOOD: `validateInput` is the first thing `execute` does (engine.ts:1773), so a slot that breaks its contract costs the vendor zero requests — and since #663 (issue #648, filed from this audit) it RETURNS each declared slot's parsed value and the engine runs on it (`out[part] = r.value`, engine.ts:444), so a schema that strips unknown keys — the default behaviour of Zod, Valibot and ArkType alike — strips them from the request too. Measured as the regression pin: a `query` validator that returned `{ limit: 10 }` put `?tenant=acme&limit=10` on the wire — the model's `tenant=globex` gone, the operator's pinned tenant restored. THE HALF THAT REMAINS: a schema constrains ONE SLOT — `getOrderTyped` declares `params` and the model still appended `?tenant=globex&include=internal_notes` through the undeclared `query` — and nothing requires a slot to be declared. `input` now follows the same parsed-value rule `output` has always had (ADR 0015)",
    );
}

void main();
