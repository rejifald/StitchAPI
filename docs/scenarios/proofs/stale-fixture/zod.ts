// Real Zod, imported by path — the same convenience `intermittent-drift/zod.ts` documents.
//
// This directory needs a real schema library for exactly one reason: C1's question is "does the
// SAME `output` schema that guards production also fail a drifted fixture", and "the same schema"
// is only a meaningful phrase if the schema is a real one. A hand-rolled `{ validate }` stub would
// let this directory invent the very behaviour under test (which key is required, what `.optional()`
// does to a removal), and C1's whole point is that those declarations decide the answer.
//
// `packages/core` already depends on Zod v4 in devDependencies; pnpm does not hoist it to the
// workspace root and `docs/` has no manifest, so the import goes by relative path. It resolves
// under `tsx` and typechecks under `packages/core`'s strict set. In application code the spelling
// is `import { z } from 'zod'`.
export { z } from '../../../../packages/core/node_modules/zod';
