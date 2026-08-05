// C8 — assemble the safest available exposure, then run every attack C2–C7 landed at it.
//
// The measurement is a before/after over the SAME registry, the SAME vendor and the SAME JSON-RPC
// messages: each attack is replayed against the naive exposure (the registry as written) and
// against `safe-exposure.ts`, and the wire tap says which one reached the vendor.
//
// The line count is the second half of the answer, and it is small — which is the point. The
// credential boundary, the resilience chain, the transport, the discovery tools and the JSON-RPC
// layer are all the library's; what the operator has to write is the ARGUMENT policy the library
// deliberately does not have an opinion about.
//
//   pnpm exec tsx docs/scenarios/proofs/agent-holds-the-tool/c8-assembled.ts
import { bearer, env } from '../../../../packages/core/src/auth';
import { seam } from '../../../../packages/core/src/index';
import type { Stitch } from '../../../../packages/core/src/types';
import { inProcess } from './client';
import { check, checkSeq, checkWire, finish, heading, note } from './harness';
import { expose, only, readsOnly } from './safe-exposure';
import { BASE, ENV, SECRETS, Wire, installSecrets, route } from './vendor';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Executable lines between the USER CODE markers — imports, blanks and comments removed, so the
 * number is the code someone actually maintains. Same counter as `deprecation-headers/c8`.
 */
function executableLines(file: string): number {
    const src = readFileSync(join(HERE, file), 'utf8');
    const from = src.indexOf('// >>> BEGIN USER CODE');
    const to = src.indexOf('// <<< END USER CODE');
    return src
        .slice(from, to)
        .replace(/^import[\s\S]*?;$/gm, '')
        .split('\n')
        .map((l) => l.trim())
        .filter(
            (l) =>
                l !== '' &&
                !l.startsWith('//') &&
                !l.startsWith('*') &&
                !l.startsWith('/*'),
        ).length;
}

/** The registry as an operator first writes it: everything exported, nothing filtered. */
function naive(wire: Wire): Record<string, Stitch> {
    const api = seam({ baseUrl: BASE, adapter: wire.adapter() });
    return {
        listOrders: api.stitch({
            name: 'listOrders',
            path: '/v1/orders?tenant=acme',
            auth: bearer(env(ENV.bearer)),
            pick: 'data',
        }) as Stitch,
        refund: api.stitch({
            name: 'refund',
            method: 'POST',
            path: '/v1/refunds',
            auth: bearer(env(ENV.bearer)),
            pick: 'data',
        }) as Stitch,
    };
}

/** The same two endpoints, exposed safely. Three call sites, and that is the whole delta. */
function safe(wire: Wire): Record<string, Stitch> {
    const api = seam({
        baseUrl: BASE,
        adapter: readsOnly(wire.adapter()),
    });
    return expose({
        listOrders: only(
            api.stitch({
                name: 'listOrders',
                path: '/v1/orders?tenant=acme',
                auth: bearer(env(ENV.bearer)),
                pick: 'data',
            }) as Stitch,
            { query: ['limit'] },
        ),
        refund: api.stitch({
            name: 'refund',
            method: 'POST',
            path: '/v1/refunds',
            auth: bearer(env(ENV.bearer)),
            pick: 'data',
        }) as Stitch,
    }) as Record<string, Stitch>;
}

async function main(): Promise<void> {
    installSecrets();

    heading('C8 (a) — the tenant pin (C2 d)');
    const naiveWire = new Wire(route);
    const naiveClient = await inProcess(naive(naiveWire));
    const safeWire = new Wire(route);
    const safeClient = await inProcess(safe(safeWire));

    await naiveClient.callTool('run_stitch', {
        name: 'listOrders',
        input: { query: { tenant: 'globex' } },
    });
    checkWire(
        'naive url',
        naiveWire.last.url,
        `${BASE}/v1/orders?tenant=globex`,
    );
    const safeRead = await safeClient.callTool('run_stitch', {
        name: 'listOrders',
        input: { query: { tenant: 'globex', limit: 5 } },
    });
    checkWire(
        'safe url',
        safeWire.last.url,
        `${BASE}/v1/orders?tenant=acme&limit=5`,
    );
    check('and the read still works', safeRead.isError, false);
    check(
        'the credential still reached the vendor',
        safeWire.last.headers['authorization'],
        `Bearer ${SECRETS.bearer}`,
    );

    heading('C8 (b) — the undeclared-slot passthrough (C7 d)');
    naiveWire.reset();
    safeWire.reset();
    await naiveClient.callTool('run_stitch', {
        name: 'listOrders',
        input: { query: { include: 'internal_notes' }, params: { x: 1 } },
    });
    checkWire(
        'naive url',
        naiveWire.last.url,
        `${BASE}/v1/orders?tenant=acme&include=internal_notes`,
    );
    await safeClient.callTool('run_stitch', {
        name: 'listOrders',
        input: { query: { include: 'internal_notes' }, params: { x: 1 } },
    });
    checkWire('safe url', safeWire.last.url, `${BASE}/v1/orders?tenant=acme`);

    heading('C8 (c) — the header opt-in (C2 b)');
    safeWire.reset();
    await safeClient.callTool('run_stitch', {
        name: 'listOrders',
        input: { headers: { 'x-actor': 'admin', cookie: 'SESSION=forged' } },
    });
    checkSeq('safe headers on the wire', Object.keys(safeWire.last.headers), [
        'authorization',
    ]);
    note(
        'this one was already closed by the library',
        'sanitizeAgentInput strips `headers` unless the stitch declares a headers schema — the safe exposure simply never declares one',
    );

    heading('C8 (d) — the unconfirmed write (C6)');
    naiveWire.reset();
    safeWire.reset();
    const naiveWrite = await naiveClient.callTool('run_stitch', {
        name: 'refund',
        input: { body: { amount: 999_999 } },
    });
    check('naive: the refund went through', naiveWrite.isError, false);
    check('naive: the vendor saw it', naiveWire.count, 1);
    const safeWrite = await safeClient.callTool('run_stitch', {
        name: 'refund',
        input: { body: { amount: 999_999 } },
    });
    check('safe: refused', safeWrite.isError, true);
    check(
        'safe: with a reason the model can act on',
        safeWrite.text,
        'POST is not available to an agent on this server',
    );
    check('safe: the vendor saw nothing', safeWire.count, 0);
    note(
        'refused, not confirmed',
        'there is no channel to a human from inside this process (C6 a) — a write an agent may legitimately need has to be a different server, or a different transport',
    );

    heading('C8 (e) — the configured-name bypass (C3 e)');
    const shadowApi = seam({
        baseUrl: BASE,
        adapter: new Wire(route).adapter(),
    });
    let rejected = '';
    try {
        expose({
            readOnlyOrders: shadowApi.stitch({
                name: 'listOrders',
                path: '/v1/orders',
                auth: bearer(env(ENV.bearer)),
            }) as Stitch,
        });
    } catch (e) {
        rejected = (e as Error).message;
    }
    check(
        'a renamed key is rejected at construction',
        rejected,
        'expose: "readOnlyOrders" is also reachable as "listOrders" — give the stitch the same name as its key',
    );

    heading('C8 (f) — what C1 still gives you for free');
    const transcript = safeClient.transcript.map((e) => e.raw).join('\n');
    check(
        'no credential in the safe transcript',
        transcript.includes(SECRETS.bearer),
        false,
    );
    note('bytes returned to the model', transcript.length);

    heading('C8 (g) — the line count');
    const userLines = executableLines('safe-exposure.ts');
    note('safe-exposure.ts, executable lines', userLines);
    note('seams used', 3);
    note(
        '  1. the registry object handed to createMcpServer',
        'the allow-list — `expose`',
    );
    note(
        '  2. a Proxy apply-trap over each Stitch',
        'the input filter — `only`',
    );
    note('  3. the seam `adapter`', 'the method gate — `readsOnly`');
    note('config keys that know about any of this', 0);
    check('under 50 executable lines', userLines <= 50, true);

    finish(
        'C8',
        `ACHIEVABLE, AND THE USER CODE IS ${String(userLines)} EXECUTABLE LINES ACROSS 3 SEAMS. The safe exposure closes every gap C2–C7 opened that is closable in-process, and it needed no fork and no config key: \`expose\` (the registry object handed to \`createMcpServer\`) is the allow-list, and it rejects a key whose stitch carries a different configured \`name\` — the C3 (e) bypass — at construction; \`only\` is a \`Proxy\` apply-trap that REBUILDS the input from an explicit key list before the engine sees it, which is what the C7 (e) finding forces (a validator's parsed value is discarded, so a stripping schema filters nothing); \`readsOnly\` wraps the \`Adapter\`, the last seam before the transport, and refuses a non-GET. Replayed side by side over the same vendor: the naive exposure sent \`?tenant=globex\`, \`?include=internal_notes\` and a 999,999 refund to the wire; the safe one sent \`?tenant=acme&limit=5\` and nothing else, refused the POST with a reason the model can read, and still authenticated every read with the real \`Bearer sk_live_…\`. WHAT IT CANNOT CLOSE: C6 — nothing in this process can ask a human, so an irreversible call can only be refused, never confirmed; and C4 (c) — the error channel is an unfiltered \`Error.message\`, so the only fix for a URL-borne credential is \`apiKey({ in: 'header' })\` rather than \`{ in: 'query' }\``,
    );
}

void main();
