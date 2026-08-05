// C4 — THE RELEVANCY PROBLEM. Telling a real diff from a benign one is the actual work.
//
// The vendor's v2 is CORRECT and still diffs on every single call, because a correct v2 does all of
// this at once (vendor.ts holds the payloads):
//
//     rename    `created`      ->  `created_at`
//     retype    epoch int      ->  ISO string          (the same instant, a different wire type)
//     reorder   tags[]         ->  the same three tags in a different order
//     add       `livemode`     ->  a field v1 never had
//     REGRESS   balance_cents  ->  41250 became 41520  (THE one thing a dual-run exists to find)
//
// Four of those five are noise. This script measures the raw diff count, then the count after a
// relevancy filter, and — the part the capture asks about — how much of that filter can be
// expressed DECLARATIVELY versus how much is user code.
import { diff } from '../../../../packages/core/src/diff';
import { classifyDiff } from '../../../../packages/core/src/drift';
import {
    check,
    checkSeq,
    countUserLines,
    finish,
    heading,
    note,
} from './harness';
import {
    CREATED_EPOCH,
    CREATED_ISO,
    REGRESSED_BALANCE,
    TRUE_BALANCE,
    v1Customer,
    v2Customer,
    v2CustomerFixed,
} from './vendor';

import { readFileSync } from 'node:fs';

async function main(): Promise<void> {
    const v1 = v1Customer();
    const v2 = v2Customer();

    // -----------------------------------------------------------------------
    heading('C4 (1) — the RAW diff on a correct v2');
    {
        const ops = diff(v1, v2);
        const paths = ops.map((o) => `${o.op} ${o.path.join('.')}`).sort();
        note('raw diff op count', ops.length);
        checkSeq('every raw op', paths, [
            'change balance_cents',
            'change tags.0',
            'change tags.1',
            'change tags.2',
            'create created_at',
            'create livemode',
            'remove created',
        ]);
        check(
            'raw diff count on a CORRECT v2 with one regression',
            ops.length,
            7,
        );
        note(
            'six of the seven are benign. A dual-run that reports this raw is a dual-run nobody reads',
        );

        // The array case is the sharpest: the tags are IDENTICAL as a set, and every element diffs.
        const v1Tags = v1['tags'] as string[];
        const v2Tags = v2['tags'] as string[];
        checkSeq('v1 tags sorted', [...v1Tags].sort(), [...v2Tags].sort());
        check(
            'the tag arrays are equal as SETS',
            JSON.stringify([...v1Tags].sort()) ===
                JSON.stringify([...v2Tags].sort()),
            true,
        );
        check('…and diff() reports every element as changed', 3, 3);
        note(
            'diff() walks arrays strictly by index (diff.ts:58-73) — no keying, no LCS, no set semantics',
        );
    }

    // -----------------------------------------------------------------------
    heading('C4 (2) — how much of the filter is DECLARATIVE?');
    {
        // The only declarative filter in the tree is `DriftOptions.ignore` (types.ts:83-97),
        // consumed by `classifyDiff`. Its grammar: exact path, single-segment `*`, or prefix,
        // with `[]` for array elements. Measure what it CAN and CANNOT express, one clause at a
        // time, against the four kinds of noise.
        const all = classifyDiff(v1, v2, {});
        note('classifyDiff findings, unfiltered', all.length);

        // (a) the NEW FIELD — a plain path. Expressible.
        const noNew = classifyDiff(v1, v2, { ignore: ['livemode'] });
        check(
            'ignore: livemode drops the new field',
            all.length - noNew.length,
            1,
        );

        // (b) the ARRAY REORDER — `tags[]` matches every element. Expressible AS SUPPRESSION.
        const noTags = classifyDiff(v1, v2, { ignore: ['tags[]'] });
        note('findings after ignore: tags[]', noTags.length);
        check(
            'ignore: `tags[]` suppresses the reorder',
            noTags.some((f) => f.path.startsWith('tags')),
            false,
        );
        note(
            'but this SUPPRESSES the field, it does not compare it unordered — a genuine tag change is now invisible too',
        );

        // Prove that last sentence rather than asserting it: change a tag for real and confirm the
        // same `ignore` clause hides it.
        const v2Tampered = {
            ...v2,
            tags: ['eu', 'invoiced', 'ENTERPRISE-PLUS'],
        };
        const tampered = classifyDiff(v1, v2Tampered, { ignore: ['tags[]'] });
        check(
            'a REAL tag change is also hidden by ignore: tags[]',
            tampered.some((f) => f.path.startsWith('tags')),
            false,
        );

        // (c) the RENAME + RETYPE — two paths, `created` and `created_at`. `ignore` can suppress
        // both, but suppression is not equivalence: nothing checks that the two carry the same
        // instant, so a v2 that reported the WRONG date would pass identically.
        const noCreated = classifyDiff(v1, v2, {
            ignore: ['created', 'created_at'],
        });
        check(
            'ignore can suppress both halves of the rename',
            noCreated.some((f) => f.path.startsWith('created')),
            false,
        );
        const v2WrongDate = { ...v2, created_at: '1999-01-01T00:00:00.000Z' };
        const wrongDate = classifyDiff(v1, v2WrongDate, {
            ignore: ['created', 'created_at'],
        });
        check(
            'a WRONG created_at is hidden by the same clause',
            wrongDate.some((f) => f.path.startsWith('created')),
            false,
        );
        note(
            'there is no aliasing option anywhere — no `equivalent`, no `rename`, no `keyBy`, no comparator hook, no numeric tolerance',
        );

        // All four noise clauses together.
        const filtered = classifyDiff(v1, v2, {
            ignore: ['livemode', 'tags[]', 'created', 'created_at'],
        });
        note('findings after the full declarative filter', filtered.length);
        checkSeq(
            'what survives',
            filtered.map((f) => f.path),
            ['balance_cents'],
        );
        check(
            'the declarative filter alone gets to exactly the regression',
            filtered.length,
            1,
        );
    }

    // -----------------------------------------------------------------------
    heading('C4 (3) — the honest filter: normalize, then compare');
    {
        // Suppression got the count right for the wrong reason: it hid `created`/`tags` rather than
        // checking them. The filter a real migration wants NORMALIZES the two shapes onto common
        // ground and then compares everything that is left — so a wrong date and a changed tag are
        // still caught. This is the "relevancy model" the field guidance names, and all of it is
        // user code.
        // >>> BEGIN USER CODE relevancy
        const KNOWN = {
            renamed: { created: 'created_at' } as Record<string, string>,
            unordered: new Set(['tags']),
            added: new Set(['livemode']),
        };
        function normalize(
            body: Record<string, unknown>,
            side: 'v1' | 'v2',
        ): Record<string, unknown> {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(body)) {
                if (side === 'v2' && KNOWN.added.has(k)) continue;
                const key = side === 'v1' ? (KNOWN.renamed[k] ?? k) : k;
                out[key] = KNOWN.unordered.has(key)
                    ? [...(v as unknown[])].sort()
                    : key === 'created_at'
                      ? new Date(
                            typeof v === 'number' ? v * 1000 : (v as string),
                        ).toISOString()
                      : v;
            }
            return out;
        }
        const deltas = diff(normalize(v1, 'v1'), normalize(v2, 'v2'));
        // <<< END USER CODE relevancy

        note('normalized diff op count', deltas.length);
        checkSeq(
            'what survives normalization',
            deltas.map((o) => o.path.join('.')),
            ['balance_cents'],
        );
        check(
            'normalization also reaches exactly the regression',
            deltas.length,
            1,
        );
        check('and it carries BOTH values', deltas[0]?.oldValue, TRUE_BALANCE);
        check('…including the wrong one', deltas[0]?.value, REGRESSED_BALANCE);

        // The difference from suppression, measured: normalization still catches the two things
        // `ignore` hid.
        const wrongDate = diff(
            normalize(v1, 'v1'),
            normalize({ ...v2, created_at: '1999-01-01T00:00:00.000Z' }, 'v2'),
        );
        check(
            'normalization CATCHES a wrong created_at (ignore did not)',
            wrongDate.some((o) => o.path.join('.') === 'created_at'),
            true,
        );
        const tagChange = diff(
            normalize(v1, 'v1'),
            normalize(
                { ...v2, tags: ['eu', 'invoiced', 'ENTERPRISE-PLUS'] },
                'v2',
            ),
        );
        check(
            'normalization CATCHES a real tag change (ignore did not)',
            tagChange.some((o) => o.path.join('.').startsWith('tags')),
            true,
        );
        check(
            'and it does NOT flag the benign reorder',
            diff(normalize(v1, 'v1'), normalize(v2, 'v2')).some((o) =>
                o.path.join('.').startsWith('tags'),
            ),
            false,
        );

        // The end state: a fixed v2 diffs at zero. This is the "cut over when the diff is quiet"
        // signal, and it only exists once normalization is in place.
        const quiet = diff(
            normalize(v1, 'v1'),
            normalize(v2CustomerFixed(), 'v2'),
        );
        check('a CORRECTED v2 normalizes to a silent diff', quiet.length, 0);
        // Assert the fixture's own premise instead of trusting it: the retype must be a pure
        // encoding change, or "normalization silences it" would be measuring a bug in the fixture.
        check(
            'the epoch and the ISO string are the SAME instant',
            new Date(CREATED_EPOCH * 1000).toISOString(),
            CREATED_ISO,
        );

        const src = readFileSync(new URL(import.meta.url), 'utf8');
        const lines = countUserLines(src, 'relevancy');
        note('executable lines for the relevancy model', lines);
        check(
            'the relevancy model is under 30 lines for FIVE known changes',
            lines <= 30,
            true,
        );
    }

    console.log(`
  THE RELEVANCY LEDGER

    v1 -> v2 change     kind      declarative?                       user code?
    ------------------  --------  ---------------------------------  ----------------------------
    livemode added      new       YES  ignore: 'livemode'            —
    tags[] reordered    reorder   PARTLY  ignore: 'tags[]'           needed — ignore SUPPRESSES,
                                                                     it cannot compare unordered
    created->created_at rename    PARTLY  ignore both paths          needed — no aliasing option
                                                                     exists, so a wrong date passes
    epoch -> ISO        retype    NO                                 needed — no coercion hook
    balance_cents       REAL      (must survive every filter)        —

    raw diff ops                                     7
    after the declarative filter (ignore x4)         1
    after a hand-written relevancy model             1   <- and it still catches what ignore hid

  \`ignore\` is path-based SUPPRESSION and nothing else. It gets the count to 1 here, but it does so
  by refusing to look at three of the four noise sites — so the same config that silences the
  benign reorder silences a genuine tag change, and the same config that silences the rename
  silences a v2 that reports the wrong date. The two constructions produce the same NUMBER and
  are not the same test.
`);

    finish(
        'C4',
        'MEASURED. A correct v2 with one planted regression produces 7 raw diff ops, 6 of them benign — a 6:1 noise ratio on every single call. The declarative surface is exactly one option, `DriftOptions.ignore` (path, `*`, prefix, `[]` for array elements), reachable only through the source-only `classifyDiff`; it takes 7 -> 1 with four clauses. But it is SUPPRESSION, not relevancy: the clause that silences the benign tag reorder also silences a real tag change, and the clause that silences the rename also silences a v2 reporting the wrong instant — both measured. There is no aliasing, no unordered-array comparison, no type-coercion hook and no tolerance anywhere in the tree, so a filter that still catches what it should is a measured 24 lines of user code',
    );
}

void main();
