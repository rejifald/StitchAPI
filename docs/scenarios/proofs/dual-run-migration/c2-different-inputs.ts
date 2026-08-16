// C2 — DECIDING CLAIM. Can the two calls take DIFFERENT inputs?
//
// This is the claim the whole scenario turns on, because a v2 that took the same input as v1 would
// not need a dual-run — you would just change the base URL. A real v2 moves the id from the path to
// a query parameter, renames it, and reshapes the body. So the question is whether the combinator
// that LOOKS purpose-built for "run these two together" can express two different inputs.
//
// PRE-REGISTERED PREDICTION (scenario 10 / issue #643): `runMember` (pipe.ts:75-86) builds every
// member's input from the ONE group input —
//
//     const memberInput: StitchInput = { ...input, signal };
//
// — so `all`/`any` cannot express it. This script confirms or refutes that by reading the literal
// URL the fake transport received, then measures every alternative spelling and what it costs.
//
// The vendor's actual v1 -> v2 input change, which is the thing being expressed:
//     v1  GET /v1/customers/{id}            id is a PATH parameter
//     v2  GET /v2/customers?customer_id=…   id moved to a QUERY parameter, and was renamed
import { all, linked } from '../../../../packages/core/src/pipe';
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

const V1_PATH = '/v1/customers/{id}';
const V2_PATH = '/v2/customers';

function pair(vendor: ReturnType<typeof fakeVendor>) {
    return {
        v1: stitch({
            baseUrl: HOST,
            path: V1_PATH,
            adapter: vendor.adapter,
            name: 'cust-v1',
        }),
        v2: stitch({
            baseUrl: HOST,
            path: V2_PATH,
            adapter: vendor.adapter,
            name: 'cust-v2',
        }),
    };
}

async function main(): Promise<void> {
    // -----------------------------------------------------------------------
    heading('C2 (1) — `all([v1, v2])` with ONE group input');
    {
        const vendor = fakeVendor({});
        const { v1, v2 } = pair(vendor);

        // The only input `all` accepts is the GROUP's. v1 wants `params.id`; v2 wants
        // `query.customer_id`. There is exactly one slot to put either in.
        await all([v1, v2])({ params: { id: 'cus_7Q2' } }).catch(
            () => undefined,
        );

        const v1Url = vendor.pathOf('v1');
        const v2Url = vendor.pathOf('v2');
        note('v1 received', v1Url);
        note('v2 received', v2Url);

        checkStr('v1 got the id it needed', v1Url, '/v1/customers/cus_7Q2');
        checkStr(
            'v2 got a request with NO id at all — the group input did not fit it',
            v2Url,
            '/v2/customers',
        );
        check(
            'the shadow call is therefore WRONG (it asks for every customer, not this one)',
            v2Url.includes('cus_7Q2'),
            false,
        );
    }

    // -----------------------------------------------------------------------
    heading("C2 (2) — the broadcast also LEAKS: v1's parameter names reach v2");
    {
        // The mirror-image failure. Put the id where v2 wants it and v1 breaks — but worse, a
        // query key is not silently dropped the way an unused path param is: it is APPENDED to
        // every member's URL. So the shadow sends the primary's parameter spelling to the vendor.
        const vendor = fakeVendor({});
        const { v1, v2 } = pair(vendor);
        await all([v1, v2])({
            params: { id: 'cus_7Q2' },
            query: { customer_id: 'cus_7Q2' },
        }).catch(() => undefined);

        note('v1 received', vendor.pathOf('v1'));
        note('v2 received', vendor.pathOf('v2'));
        checkStr(
            'v2 finally got its query param…',
            vendor.pathOf('v2'),
            '/v2/customers?customer_id=cus_7Q2',
        );
        checkStr(
            "…but v1 was handed v2's parameter too, and sent it to the vendor",
            vendor.pathOf('v1'),
            '/v1/customers/cus_7Q2?customer_id=cus_7Q2',
        );
        note(
            "a broadcast input is a UNION of both versions' parameters — every member sends every key",
        );
    }

    // -----------------------------------------------------------------------
    heading(
        'C2 (3) — `.with()` inside `all`: does a per-member binding survive the broadcast?',
    );
    {
        const vendor = fakeVendor({});
        const { v1, v2 } = pair(vendor);

        // `.with()` binds part of a member's input at CONSTRUCTION. `bound.__runWith` merges the
        // bound partial under the incoming input (stitch.ts:1132-1133 over `mergeInput`,
        // stitch.ts:792-813), so the binding does survive `runMember`'s broadcast.
        const group = all([v1, v2.with({ query: { customer_id: 'cus_7Q2' } })]);
        await group({ params: { id: 'cus_7Q2' } }).catch(() => undefined);

        note('v1 received', vendor.pathOf('v1'));
        note('v2 received', vendor.pathOf('v2'));
        checkStr('v1 correct', vendor.pathOf('v1'), '/v1/customers/cus_7Q2');
        checkStr(
            'v2 correct — `.with()` DID survive `runMember`',
            vendor.pathOf('v2'),
            '/v2/customers?customer_id=cus_7Q2',
        );

        // …and here is why that rescue does not hold. `.with()` binds a CONSTANT. Call the same
        // group for a DIFFERENT customer and the shadow keeps asking about the first one.
        vendor.reset();
        await group({ params: { id: 'cus_ZZZ' } }).catch(() => undefined);
        note('second call, v1 received', vendor.pathOf('v1'));
        note('second call, v2 received', vendor.pathOf('v2'));
        checkStr(
            'v1 followed the new input',
            vendor.pathOf('v1'),
            '/v1/customers/cus_ZZZ',
        );
        checkStr(
            'v2 is STILL pinned to the bound customer — it compared the wrong records',
            vendor.pathOf('v2'),
            '/v2/customers?customer_id=cus_7Q2',
        );
        check(
            'the two versions asked about the SAME customer',
            vendor.pathOf('v1').includes('cus_ZZZ') &&
                vendor.pathOf('v2').includes('cus_ZZZ'),
            false,
        );
        note(
            'a dual-run whose shadow silently compares a different record produces a diff on every call',
        );
    }

    // -----------------------------------------------------------------------
    heading('C2 (4) — the spellings that DO work, and what each costs');

    // `linked` — sequential, `run(node, input)` takes a per-call input per node (pipe.ts ScopedRun).
    {
        const vendor = fakeVendor({});
        const { v1, v2 } = pair(vendor);
        const id = 'cus_LNK';
        // >>> BEGIN USER CODE linked
        await linked(async (run) => {
            const primary = await run(v1, { params: { id } });
            const shadow = await run(v2, { query: { customer_id: id } });
            return { primary, shadow };
        });
        // <<< END USER CODE linked
        note(
            'unlike all/any/race, `linked` returns a Promise, not a Composable (pipe.ts:357-359) — it runs on the spot and cannot itself be a member',
        );
        checkStr(
            'linked: v1 correct',
            vendor.pathOf('v1'),
            '/v1/customers/cus_LNK',
        );
        checkStr(
            'linked: v2 correct',
            vendor.pathOf('v2'),
            '/v2/customers?customer_id=cus_LNK',
        );
        note(
            "linked runs the two SEQUENTIALLY — the shadow is on the caller's critical path",
        );
    }

    // Plain `Promise.all` — no combinator at all.
    {
        const vendor = fakeVendor({});
        const { v1, v2 } = pair(vendor);
        const id = 'cus_PAL';
        // >>> BEGIN USER CODE promise-all
        const [primary, shadow] = await Promise.all([
            v1({ params: { id } }),
            v2({ query: { customer_id: id } }),
        ]);
        // <<< END USER CODE promise-all
        void primary;
        void shadow;
        checkStr(
            'Promise.all: v1 correct',
            vendor.pathOf('v1'),
            '/v1/customers/cus_PAL',
        );
        checkStr(
            'Promise.all: v2 correct',
            vendor.pathOf('v2'),
            '/v2/customers?customer_id=cus_PAL',
        );
        note('Promise.all is concurrent, but still AWAITS the shadow (C1 (a))');
    }

    // The spelling that satisfies C2 *and* C1 at once: per-call input, concurrent, not awaited,
    // cannot reject. This is the one C8 assembles.
    {
        const vendor = fakeVendor({ latency: { v2: 40 } });
        const { v1, v2 } = pair(vendor);
        const id = 'cus_SAF';
        // >>> BEGIN USER CODE isolated-shadow
        const shadow = v2.safe({ query: { customer_id: id } });
        const primary = await v1({ params: { id } });
        void shadow.then((r) => {
            if (r.ok) compare(primary, r.data);
        });
        // <<< END USER CODE isolated-shadow
        await new Promise((r) => setTimeout(r, 120));
        checkStr(
            'isolated: v1 correct',
            vendor.pathOf('v1'),
            '/v1/customers/cus_SAF',
        );
        checkStr(
            'isolated: v2 correct',
            vendor.pathOf('v2'),
            '/v2/customers?customer_id=cus_SAF',
        );
        check('isolated: the comparison ran', comparisons, 1);
    }

    const src = readFileSync(new URL(import.meta.url), 'utf8');
    const lines = {
        linked: countUserLines(src, 'linked'),
        promiseAll: countUserLines(src, 'promise-all'),
        isolated: countUserLines(src, 'isolated-shadow'),
    };
    note('executable lines — `linked`', lines.linked);
    note('executable lines — plain `Promise.all`', lines.promiseAll);
    note(
        'executable lines — isolated shadow (satisfies C1 too)',
        lines.isolated,
    );
    check('the working spelling is under 6 lines', lines.isolated <= 6, true);

    console.log(`
  THE SPELLINGS, SIDE BY SIDE

    spelling                     different inputs?  concurrent?  off the critical path?  lines
    ---------------------------  -----------------  -----------  ----------------------  -----
    all([v1, v2])                NO                 yes          no                      1
    all([v1, v2.with({...})])    CONSTANT only      yes          no                      1
    linked(run => ...)           yes                no           no                      ${lines.linked}
    Promise.all([...])           yes                yes          no                      ${lines.promiseAll}
    v2.safe(...) not awaited     yes                yes          YES                     ${lines.isolated}

  The combinators are not merely inadequate here — \`all\` is actively wrong on THREE counts at
  once: it broadcasts one input (C2), it awaits the slowest member (C1 a), and it cancels the
  primary when the shadow fails (C1 c*). The working spelling uses no combinator at all.
`);

    finish(
        'C2',
        "CONFIRMED. `all`/`any` broadcast one input to every member, so the two versions cannot take different inputs through a combinator: the shadow either receives no id (`/v2/customers`) or receives the primary's parameter spelling as well. `.with()` partially rescues it — a bound partial DOES survive `runMember` — but only as a CONSTANT, so a group built once and called twice sent the shadow to the wrong customer. The working spelling is a plain un-awaited `.safe()` call",
    );
}

// A stand-in for the comparison C3/C4 build properly — here only to prove the shadow's result is
// reachable at all from the isolated spelling.
let comparisons = 0;
function compare(a: unknown, b: unknown): void {
    void a;
    void b;
    comparisons++;
}

void main();
