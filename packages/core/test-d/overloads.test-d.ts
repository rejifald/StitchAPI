// Overload-resolution contract. Splitting stitch()/seam.stitch() into inferring object + string
// overloads must NOT regress a previously-valid call: an argument whose STATIC type is the union
// `string | Partial<StitchConfig>` matched the old single signature, so a fallback overload keeps
// it compiling (TS rejects a union value against either split overload alone — TS2769).
import { seam, stitch } from '..';
import type { Stitch, StitchConfig } from '..';
import { output } from './_util';

import { expectType } from 'tsd';
import { z } from 'zod';

const userSchema = z.object({ id: z.number() });

declare const either: string | Partial<StitchConfig>;

// 1) a union-typed argument still resolves (to unknown, exactly as before the split).
expectType<unknown>(output(stitch(either)));

// 2) the idiomatic forwarding wrapper from the review must compile.
function makeApi(cfg: string | Partial<StitchConfig>): Stitch<unknown> {
    return stitch(cfg);
}
expectType<unknown>(output(makeApi('/x')));

// 3) seam member: same union-argument contract.
const api = seam({ baseUrl: 'x' });
expectType<unknown>(output(api.stitch(either)));

// 4) graphql is a single overload, so a union of query-configs already resolves (no fallback needed).
declare const gqlEither:
    | (Partial<StitchConfig> & { query: string })
    | (Partial<StitchConfig> & { query: string; method: string });
expectType<unknown>(output(api.graphql(gqlEither)));

// 5) REGRESSION GUARD: the fallback overload must NOT shadow inference for concrete literals.
expectType<{ id: number }>(output(stitch({ output: userSchema })));
expectType<unknown>(output(stitch('/path')));
expectType<{ id: number }>(output(api.stitch({ output: userSchema })));
