// C3 — is there a COMPARISON primitive?
//
// A dual-run is two calls and a comparison. C1 and C2 measured the two calls. This measures whether
// the library has anything that compares one RESPONSE to another RESPONSE — as opposed to `drift()`,
// which is anchored to a SCHEMA (response vs contract).
//
// The measurement is deliberately mechanical: enumerate what the public barrel actually exports at
// runtime, read the `exports` map in package.json for the reachable subpaths, and call each
// candidate to see what its inputs really are. A claim about a public surface should be a directory
// listing, not a recollection.
import { diff } from '../../../../packages/core/src/diff';
import { classifyDiff } from '../../../../packages/core/src/drift';
import * as barrel from '../../../../packages/core/src/index';
import { drift } from '../../../../packages/core/src/stitch';
import {
    check,
    checkSeq,
    countUserLines,
    finish,
    heading,
    note,
} from './harness';
import { v1Customer, v2Customer } from './vendor';

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

async function main(): Promise<void> {
    // -----------------------------------------------------------------------
    heading(
        'C3 (1) — what the PUBLIC barrel exports, and whether any of it compares two values',
    );
    {
        const names = Object.keys(barrel).sort();
        note('public exports on `stitchapi` (the root barrel)', names.length);

        // The candidate set: anything whose NAME suggests a comparison. Naming is the only honest
        // filter here — a reader looking for "compare two responses" greps for exactly these.
        const candidates = names.filter((n) =>
            /diff|compare|equal|match|drift|ignore|normali[sz]e|canonical/i.test(
                n,
            ),
        );
        checkSeq('comparison-shaped names on the root barrel', candidates, [
            'drift',
        ]);
        note('exactly one candidate, and it is `drift`');

        // Reachable subpaths, from the package's own `exports` map.
        const pkg = require('../../../../packages/core/package.json') as {
            exports: Record<string, unknown>;
        };
        const subpaths = Object.keys(pkg.exports).sort();
        note('reachable subpaths', subpaths.join(' '));
        check('a `./diff` subpath exists', subpaths.includes('./diff'), false);
        check(
            'a `./drift` subpath exists',
            subpaths.includes('./drift'),
            false,
        );
        check(
            'a `./compare` subpath exists',
            subpaths.includes('./compare'),
            false,
        );
    }

    // -----------------------------------------------------------------------
    heading(
        'C3 (2) — `drift()` is schema-anchored: what does it actually take?',
    );
    {
        // `drift(schema, options)` does not compare anything. It TAGS a schema for the engine.
        const spec = drift(
            (v: unknown) => typeof v === 'object' && v !== null,
            {
                ignore: 'meta',
            },
        ) as unknown as Record<string, unknown>;
        checkSeq('the object `drift()` returns', Object.keys(spec).sort(), [
            '__kind',
            'options',
            'schema',
        ]);
        check('its `__kind`', spec['__kind'], 'drift');
        note(
            'input 1 is a SCHEMA, input 2 is options — there is no second VALUE parameter, so it cannot compare response vs response',
        );
        check('drift() arity', drift.length, 1);
    }

    // -----------------------------------------------------------------------
    heading(
        'C3 (3) — the primitive DOES exist; it is just not on the public surface',
    );
    {
        // `diff(before, after)` takes two arbitrary values. This is exactly the response-vs-response
        // comparator the scenario needs — and it lives at packages/core/src/diff.ts:94, reachable
        // from no subpath in the table above.
        const ops = diff(v1Customer(), v2Customer());
        note('diff(v1, v2) op count', ops.length);
        check('diff() arity — two values, no schema', diff.length, 2);
        check(
            'the returned ops carry a path and an op',
            ops.every((o) => Array.isArray(o.path) && typeof o.op === 'string'),
            true,
        );
        check(
            'it found the regression at balance_cents',
            ops.some((o) => o.path.join('.') === 'balance_cents'),
            true,
        );

        // `classifyDiff(a, b, opts)` is the other one: also two arbitrary values (drift.ts:113-117),
        // and it accepts the declarative `ignore` grammar. Also unreachable from any subpath.
        const findings = classifyDiff(v1Customer(), v2Customer(), {});
        note('classifyDiff(v1, v2) finding count', findings.length);
        check('classifyDiff() arity', classifyDiff.length, 2);
        check(
            'classifyDiff renders string paths',
            findings.every((f) => typeof f.path === 'string'),
            true,
        );
        note(
            'its LABELS are named for validation, not for a dual-run: `undeclared` = only in v1, `defaulted` = only in v2, `coerced` = differs',
        );
        note(
            'and `coerced` renders a TYPE delta ("number -> string"), never the two values — a wrong NUMBER of the right type has no values in its detail',
        );
        const balance = findings.find((f) => f.path === 'balance_cents');
        note('the regression, as classifyDiff renders it', balance?.detail);
    }

    // -----------------------------------------------------------------------
    heading('C3 (4) — the minimum hand-written comparator');
    {
        // What a consumer must write if they will not reach into `src/`. This is a full
        // structural comparator: recursive, path-carrying, and honest about the four cases
        // (missing left, missing right, kind mismatch, primitive inequality).
        // >>> BEGIN USER CODE comparator
        type Delta = { path: string; left: unknown; right: unknown };
        function compare(a: unknown, b: unknown, path = ''): Delta[] {
            if (Object.is(a, b)) return [];
            const both =
                a && b && typeof a === 'object' && typeof b === 'object';
            if (!both) return [{ path, left: a, right: b }];
            if (Array.isArray(a) !== Array.isArray(b))
                return [{ path, left: a, right: b }];
            const keys = new Set([
                ...Object.keys(a as object),
                ...Object.keys(b as object),
            ]);
            const out: Delta[] = [];
            for (const k of keys)
                out.push(
                    ...compare(
                        (a as Record<string, unknown>)[k],
                        (b as Record<string, unknown>)[k],
                        path ? `${path}.${k}` : k,
                    ),
                );
            return out;
        }
        // <<< END USER CODE comparator

        const deltas = compare(v1Customer(), v2Customer());
        note('hand-written comparator delta count', deltas.length);
        check(
            'it finds the regression',
            deltas.some((d) => d.path === 'balance_cents'),
            true,
        );
        check(
            'and unlike classifyDiff it carries BOTH VALUES, which is what a regression report needs',
            deltas.find((d) => d.path === 'balance_cents')?.right,
            41_520,
        );

        const src = readFileSync(new URL(import.meta.url), 'utf8');
        const lines = countUserLines(src, 'comparator');
        note('executable lines for the minimum comparator', lines);
        check('it fits in under 25 lines', lines <= 25, true);
    }

    console.log(`
  WHAT IS AND IS NOT REACHABLE

    symbol                      compares            reachable from
    --------------------------  ------------------  ----------------------------------------
    drift(schema, opts)         nothing (a tag)     \`stitchapi\` — PUBLIC
    classifyDiff(a, b, opts)    value vs value      packages/core/src/drift.ts — SOURCE ONLY
    diff(before, after)         value vs value      packages/core/src/diff.ts  — SOURCE ONLY

  So the answer is not "there is no comparison primitive". There are TWO, both of them exactly the
  right shape — \`diff\` takes two arbitrary values, and \`classifyDiff\` adds the declarative
  \`ignore\` grammar C4 needs — and NEITHER is exported from any of the 17 public subpaths. A
  consumer doing this today either vendors ~20 lines of comparator or reaches into \`src/\`.
`);

    finish(
        'C3',
        'PARTIAL. Nothing on the PUBLIC surface compares response vs response: the one comparison-shaped export on the root barrel is `drift()`, which takes a SCHEMA and a set of options and performs no comparison at all. But the primitive exists twice in the tree — `diff(before, after)` (diff.ts:94) and `classifyDiff(a, b, opts)` (drift.ts:113), both taking two arbitrary values — and neither is reachable from any of the 17 subpaths in the package `exports` map. The minimum hand-written replacement is a measured 23 executable lines, and it is strictly BETTER than `classifyDiff` for this use because it carries both values: `classifyDiff` renders the planted regression as the detail "number -> number", a type delta with no numbers in it',
    );
}

void main();
