// Real Zod, imported by path — the same convenience `stale-fixture/zod.ts` documents.
//
// C2 asks whether an `output` schema can catch a value that is the wrong number, and the answer
// depends entirely on what a REAL schema library does with `z.number().int()`, `z.bigint()` and
// `z.string()` when handed a double. A hand-rolled `{ validate }` stub would let this directory
// invent the very behaviour under test.
//
// `packages/core` already depends on Zod v4 in devDependencies; pnpm does not hoist it to the
// workspace root and `docs/` has no manifest, so the import goes by relative path. It resolves
// under `tsx`. In application code the spelling is `import { z } from 'zod'`.
export { z } from '../../../../packages/core/node_modules/zod';
