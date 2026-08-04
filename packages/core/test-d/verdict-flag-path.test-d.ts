// ADR 0022 Decision 3 / step 6 — `verdict.flag` is checked against `output`'s inferred type.
//
// A dot-path typo (`meta.succes`) is the realistic failure, and it is SILENT at runtime: the path
// resolves to `undefined`, `flag` reads that as "no signal", and the flag is inert forever. The
// `output` schema already describes the response, so the authoring site catches it.
//
// Both directions are pinned here, and so is the RELAXATION — the guard must stay out of the way
// whenever it cannot soundly conclude anything, because a false positive would reject valid config.
import { stitch } from '../src';

import { expectError } from 'tsd';
import { z } from 'zod';

const Body = z.object({
    meta: z.object({ success: z.boolean(), traceId: z.string() }),
    data: z.object({ id: z.number() }),
});

// ── the good path compiles ──────────────────────────────────────────────────────────────────────
stitch({
    url: 'https://x.test/a',
    output: Body,
    verdict: { flag: 'meta.success' },
});

// Containment, not position: the rule is that the path exists SOMEWHERE in the type, so a nested
// leaf and a top-level object key are both legal.
stitch({
    url: 'https://x.test/a',
    output: Body,
    verdict: { flag: 'data.id' },
});
stitch({ url: 'https://x.test/a', output: Body, verdict: { flag: 'meta' } });

// ── the typo is a compile error ─────────────────────────────────────────────────────────────────
expectError(
    stitch({
        url: 'https://x.test/a',
        output: Body,
        verdict: { flag: 'meta.succes' },
    }),
);
expectError(
    stitch({
        url: 'https://x.test/a',
        output: Body,
        verdict: { flag: 'nope' },
    }),
);

// ── the relaxations ─────────────────────────────────────────────────────────────────────────────
// No `output`: nothing describes the response, so `flag` stays a plain `string`.
stitch({ url: 'https://x.test/a', verdict: { flag: 'anything.at.all' } });

// `transform` present: it makes the relationship between the raw body and `output` an arbitrary
// function, so nothing can be concluded and the constraint lifts. This is required for SOUNDNESS —
// `flag` reads the RAW body while `output` describes the value after transform/pick ran.
stitch({
    url: 'https://x.test/a',
    output: Body,
    transform: (b) => b,
    verdict: { flag: 'whatever.the.server.sent' },
});

// `accept` alone is untouched by the guard.
stitch({ url: 'https://x.test/a', output: Body, verdict: { accept: [404] } });

// Both members together still check the flag.
stitch({
    url: 'https://x.test/a',
    output: Body,
    verdict: { accept: [404], flag: 'meta.success' },
});
expectError(
    stitch({
        url: 'https://x.test/a',
        output: Body,
        verdict: { accept: [404], flag: 'meta.nope' },
    }),
);
