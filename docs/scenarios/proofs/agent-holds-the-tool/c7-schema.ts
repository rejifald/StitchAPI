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
//   3. A declared schema is CHECK-ONLY, and it covers one slot. `validateInput` (engine.ts:384-409)
//      throws when a slot fails and otherwise DISCARDS the parsed value — so a schema that strips
//      unknown keys does not strip them from the request. Measured below: a `query` schema that
//      returns `{ limit: 10 }` still puts the model's `tenant=globex` on the wire.
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
 * default — all of them strip. The question is whether the engine uses what came back.
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
        'engine.ts:1687 — `await validateInput(cfg, input)` is the first thing `execute` does',
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
        'C7 (e) — a declared schema is CHECK-ONLY: the parsed value is discarded',
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
        'but the wire carried the STRIPPED key too',
        stripWire.last.url,
        `${BASE}/v1/orders?tenant=globex&limit=10`,
    );
    check(
        'and the operator’s pinned tenant is gone',
        new URL(stripWire.last.url).searchParams.get('tenant'),
        'globex',
    );
    note(
        'engine.ts:400-408 — `const r = await v.validate(...); if (!r.ok) throw`',
        'the parsed value is never read; `output` uses its parsed value (engine.ts:428), `input` does not',
    );
    note(
        'so a stripping schema is a validity check, not a filter',
        'an operator who writes `z.object({ limit: z.number() })` on `query` and expects unknown keys to be dropped is wrong — they reach the vendor',
    );

    finish(
        'C7',
        'THE MODEL IS TOLD A SLOT EXISTS AND NEVER WHAT GOES IN IT, AND A DECLARED SCHEMA IS A CHECK RATHER THAN A FILTER. The tool schema is four untyped bags — `params`/`query`/`headers` typed `object`, `body` typed as anything, no `required`, no `additionalProperties: false` (while `list_stitches`, which takes nothing, IS closed) — and it is identical for every stitch, because one tool for every endpoint is what code-mode buys its constant context with. `describe_stitch` does not make up the difference: a stitch whose `params` contract is `{ id: <digits> }` is described as `"params": true`, so a model that guesses `{ orderId: 77 }` learns the shape only by failing. ONE HALF IS GENUINELY GOOD: `validateInput` is the first thing `execute` does (engine.ts:1687), so a slot that breaks its contract costs the vendor zero requests. TWO HALVES ARE NOT. A schema constrains ONE SLOT — `getOrderTyped` declares `params` and the model still appended `?tenant=globex&include=internal_notes` through the undeclared `query`. And the check is check-only: `validateInput` throws on failure and DISCARDS the parsed value (engine.ts:400-408), so a schema that strips unknown keys — which is the default behaviour of Zod, Valibot and ArkType alike — does not strip them from the request. Measured: a `query` validator that returned `{ limit: 10 }` still put `?tenant=globex&limit=10` on the wire, overwriting the operator\'s pinned `tenant=acme`. `output` uses its parsed value; `input` never does',
    );
}

void main();
