// `stitch()` infers its result type from `config.output` — the headline of this feature.
import { stitch } from '..';
import { output } from './_util';

import { expectError, expectType } from 'tsd';
import { z } from 'zod';

const userSchema = z.object({ id: z.number(), name: z.string() });
type User = z.infer<typeof userSchema>;

// 1) plain object schema → inferred result, no generic, no cast.
expectType<User>(
    output(stitch({ baseUrl: 'x', path: '/u', output: userSchema })),
);

// 2) array schema → inferred array result.
expectType<User[]>(output(stitch({ path: '/u', output: z.array(userSchema) })));

// 3) the schema's OUTPUT (post-coercion) is used, not its input — a `.transform` proves it:
//    input is `string`, output is `number`, and the stitch resolves to `number`.
const lengthSchema = z.string().transform((s) => s.length);
expectType<number>(output(stitch({ output: lengthSchema })));

// 4) an explicit generic always wins (backwards-compatible escape hatch).
expectType<number[]>(output(stitch<number[]>({ output: userSchema })));

// 5) no `output` schema → `unknown` (unchanged historical default).
expectType<unknown>(output(stitch({ path: '/ping' })));

// 6) bare path-string shorthand → `unknown`.
expectType<unknown>(output(stitch('/ping')));

// 7) a raw Zod schema flows in WITHOUT `toValidator()` / `as Validator` (the old cast is gone).
expectType<User>(output(stitch({ output: userSchema, unwrap: 'data' })));

// 8) a non-schema `output` is rejected at compile time.
expectError(stitch({ output: 123 }));
expectError(stitch({ output: 'not-a-schema' }));

// 9) the call result is a thenable that also types `.catch` and `.finally` (#133): both compile
//    without a cast, and `.catch`'s recovery value widens the resolved type. `then` keeps its
//    inherited `PromiseLike` return; catch/finally resolve to a real `Promise`.
const u = stitch({ path: '/u', output: userSchema });
expectType<PromiseLike<User>>(u().then((x) => x));
expectType<Promise<User | null>>(u().catch(() => null));
expectType<Promise<User>>(u().finally(() => undefined));
