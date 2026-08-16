// Real Zod, imported by path — the same convenience `precision-loss/zod.ts` and
// `stale-fixture/zod.ts` document.
//
// C6 asks whether an `output` schema that strips unknown keys keeps them out of the log, and the
// answer depends entirely on what a REAL schema library does with an undeclared key. A hand-rolled
// `{ validate }` stub would let this directory invent the very behaviour under test — and the
// stripping is the behaviour under test.
//
// `packages/core` already depends on Zod v4 in devDependencies; pnpm does not hoist it to the
// workspace root and `docs/` has no manifest, so the import goes by relative path. It resolves
// under `tsx`. In application code the spelling is `import { z } from 'zod'`.
export { z } from '../../../../packages/core/node_modules/zod';
