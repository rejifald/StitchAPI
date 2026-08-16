// C6 — CUTOVER WITHOUT REDEPLOY. The dual-run ends when the diff goes quiet, and the point of
// running it against live traffic is that you can stop at any moment — including at 3am, from a
// flag, without shipping code.
//
// Scenario 19 measured that a `baseUrl` THUNK (`string | (() => string)`) is resolved per call, so
// it retargets between calls. The question here is whether that extends to swapping a WHOLE STITCH
// — a different path, a different input shape, a different response shape — or whether it only
// moves an origin.
//
// Four things have to change at cutover, and they are measured one at a time:
//     the ORIGIN        api.vendor.test        (v1 and v2 may or may not share it)
//     the PATH          /v1/customers/{id}  -> /v2/customers
//     the INPUT SHAPE   params.id           -> query.customer_id
//     the OUTPUT SHAPE  created (epoch)     -> created_at (ISO)
import { stitch } from '../../../../packages/core/src/stitch';
import {
    check,
    checkStr,
    countUserLines,
    finish,
    heading,
    note,
} from './harness';
import { HOST, fakeVendor } from './vendor';

import { readFileSync } from 'node:fs';

async function main(): Promise<void> {
    // -----------------------------------------------------------------------
    heading('C6 (1) — the `baseUrl` thunk: does it retarget BETWEEN calls?');
    {
        const vendor = fakeVendor({});
        // The flag a cutover would actually be driven by: read at call time, changeable at runtime.
        let cutover = false;
        const cust = stitch({
            baseUrl: () => (cutover ? `${HOST}/v2` : `${HOST}/v1`),
            path: '/customers/{id}',
            adapter: vendor.adapter,
            name: 'cust',
        });

        await cust({ params: { id: 'cus_7Q2' } });
        checkStr(
            'before the flag',
            vendor.pathOf('v1'),
            '/v1/customers/cus_7Q2',
        );
        cutover = true;
        await cust({ params: { id: 'cus_7Q2' } });
        checkStr(
            'after the flag — no redeploy, no reconstruction',
            vendor.pathOf('v2'),
            '/v2/customers/cus_7Q2',
        );
        check('the thunk is resolved per call', vendor.log.length, 2);
        note(
            'confirms scenario 19: `baseUrl` is `string | (() => string)` (types.ts:1570)',
        );
    }

    // -----------------------------------------------------------------------
    heading('C6 (2) — does it extend to the PATH? `url` is a thunk too');
    {
        // `path` is a plain `string` (types.ts:1572) — no thunk. But `url` IS
        // `string | (() => string)` (types.ts:1568) and it carries the COMPLETE endpoint, so a
        // thunk on `url` moves the path as well as the origin. Measure whether `{param}` templating
        // still applies to a thunk-supplied url.
        const vendor = fakeVendor({});
        let cutover = false;
        const cust = stitch({
            url: () =>
                cutover ? `${HOST}/v2/customers` : `${HOST}/v1/customers/{id}`,
            adapter: vendor.adapter,
            name: 'cust',
        });

        await cust({ params: { id: 'cus_7Q2' } }).catch(() => undefined);
        checkStr(
            'a `{param}` slot in a THUNK-supplied url is still interpolated',
            vendor.pathOf('v1'),
            '/v1/customers/cus_7Q2',
        );
        cutover = true;
        await cust({ query: { customer_id: 'cus_7Q2' } }).catch(
            () => undefined,
        );
        checkStr(
            'and the flag moved the whole path, not just the origin',
            vendor.pathOf('v2'),
            '/v2/customers?customer_id=cus_7Q2',
        );
        note(
            'so the thunk covers origin AND path — the capture\'s "only a base URL" reading is too narrow',
        );

        // …but the caller had to pass a DIFFERENT input shape on either side of the flag, and
        // nothing in the config did that. Prove it: pass the v1 input after the flag and watch the
        // request go out wrong rather than fail.
        vendor.reset();
        await cust({ params: { id: 'cus_7Q2' } }).catch(() => undefined);
        checkStr(
            'the v1 input against the v2 url silently drops the id',
            vendor.pathOf('v2'),
            '/v2/customers',
        );
        check(
            'nothing threw — the wrong call was simply made',
            vendor.log.length,
            1,
        );
    }

    // -----------------------------------------------------------------------
    heading('C6 (3) — the two things a thunk canNOT move');
    {
        const vendor = fakeVendor({});
        // (a) INPUT SHAPE. There is no thunk and no per-call hook that rewrites the input slots:
        //     `input` is a schema bag, `transform` reshapes the RESPONSE (types.ts:1600), and
        //     `.with()` binds a constant (C2 measured that). So the mapping is caller-side.
        //
        // (b) OUTPUT SHAPE. `output` is resolved once at construction. A schema that describes v1
        //     rejects v2's body, and a flag cannot change which schema is installed.
        let cutover = false;
        const v1Shape = (b: unknown): boolean =>
            typeof (b as { created?: unknown })?.created === 'number';
        const cust = stitch({
            baseUrl: () => (cutover ? `${HOST}/v2` : `${HOST}/v1`),
            path: '/customers/{id}',
            output: v1Shape,
            adapter: vendor.adapter,
            name: 'cust',
        });

        const before = await cust.safe({ params: { id: 'cus_7Q2' } });
        check('v1 body passes the v1 output schema', before.ok, true);
        cutover = true;
        const after = await cust.safe({ params: { id: 'cus_7Q2' } });
        check(
            'the SAME stitch, flag flipped, now fails validation on the v2 body',
            after.ok,
            false,
        );
        note(
            'the flag moved the endpoint and left the contract behind — `output` is fixed at construction',
        );
    }

    // -----------------------------------------------------------------------
    heading('C6 (4) — what a flag-driven cutover actually costs');
    {
        const vendor = fakeVendor({});
        // Because the input shape and the output contract both change, the honest cutover swaps
        // the WHOLE STITCH, not a URL. That is a selector plus a per-version input mapping — and
        // it is strictly simpler than a thunk, because each version keeps its own correct schema.
        let cutover = false;
        const v1 = stitch({
            baseUrl: HOST,
            path: '/v1/customers/{id}',
            adapter: vendor.adapter,
            name: 'cust-v1',
        });
        const v2 = stitch({
            baseUrl: HOST,
            path: '/v2/customers',
            adapter: vendor.adapter,
            name: 'cust-v2',
        });

        // >>> BEGIN USER CODE cutover
        const getCustomer = (id: string) =>
            cutover
                ? v2({ query: { customer_id: id } })
                : v1({ params: { id } });
        // <<< END USER CODE cutover

        await getCustomer('cus_7Q2');
        checkStr(
            'before the flag',
            vendor.pathOf('v1'),
            '/v1/customers/cus_7Q2',
        );
        cutover = true;
        await getCustomer('cus_7Q2');
        checkStr(
            'after the flag',
            vendor.pathOf('v2'),
            '/v2/customers?customer_id=cus_7Q2',
        );
        check(
            'one flag flip, two different stitches, no redeploy',
            vendor.log.length,
            2,
        );

        const src = readFileSync(new URL(import.meta.url), 'utf8');
        const lines = countUserLines(src, 'cutover');
        note('executable lines for the whole-stitch cutover', lines);
        check('the cutover is 4 lines or fewer', lines <= 4, true);
    }

    console.log(`
  WHAT A THUNK CAN AND CANNOT MOVE

    what changes at cutover   thunkable?  spelling                               measured
    ------------------------  ----------  -------------------------------------  ---------------------
    origin                    YES         baseUrl: () => flag ? v2 : v1          retargeted per call
    path                      YES         url: () => flag ? urlB : urlA          whole path moved, and
                                                                                 {param} still applies
    input shape               NO          —                                      wrong call made
                                                                                 silently, nothing threw
    output contract           NO          —                                      same stitch, flag on,
                                                                                 validation now fails

  So the capture's question — "does it extend to a whole stitch, or only a base URL?" — has a
  three-part answer. It extends FURTHER than a base URL (\`url\` is a thunk and carries the path),
  and still stops short of a whole stitch, because the two halves of a stitch that a v2 migration
  actually changes — how the input maps in and what contract the output is held to — are both fixed
  at construction. The working cutover is therefore not a thunk at all: it is a 4-line selector over
  two stitches, each keeping its own correct path, input mapping and schema.
`);

    finish(
        'C6',
        'PARTIAL — and the capture UNDERSTATES the thunk while overstating what it buys. A thunk moves more than the base URL: `url` is also `string | (() => string)`, it carries the complete endpoint, and `{param}` interpolation still applies to a thunk-supplied url, so one flag moved `/v1/customers/{id}` to `/v2/customers` between calls with no redeploy. But it cannot move the two things a v2 actually changes. The input mapping is caller-side (measured: after the flag, the v1 input shape against the v2 url silently produced `/v2/customers` with no id and nothing threw), and `output` is resolved once at construction (measured: the same stitch, flag flipped, went from `ok: true` to `ok: false` against a v1-shaped schema). The real cutover is a 4-line selector over two whole stitches',
    );
}

void main();
