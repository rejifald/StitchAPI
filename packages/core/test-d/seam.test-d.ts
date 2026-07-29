// Seam members infer their result type exactly like top-level `stitch`.
import { seam } from '..';
import { output } from './_util';

import { expectType } from 'tsd';
import { z } from 'zod';

const userSchema = z.object({ id: z.number(), name: z.string() });
type User = z.infer<typeof userSchema>;

const api = seam({ baseUrl: 'https://x' });

// member stitch infers from `output`
expectType<User>(output(api.stitch({ path: '/u', output: userSchema })));

// bare path-string member → unknown
expectType<unknown>(output(api.stitch('/ping')));

// explicit generic overrides on a member too
expectType<number>(output(api.stitch<number>({ output: userSchema })));

// a principal-bound handle infers identically
expectType<User>(
    output(api.as('u1').stitch({ path: '/u', output: userSchema })),
);

// graphql member infers from `output`
expectType<User>(
    output(
        api.graphql({
            document: 'query { u { id name } }',
            output: userSchema,
        }),
    ),
);
