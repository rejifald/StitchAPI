// Real Zod, imported by path, and the one piece of ugliness in this directory.
//
// Every OTHER scenario in this section hand-rolled its `output` validators as plain
// `{ validate }` objects, because `stitchapi` has zero runtime dependencies and nothing under
// `docs/` has a `package.json`. This scenario cannot do that honestly: the entire question C3 asks
// — "what does the caller ACTUALLY RECEIVE when `transaction_id` stops being a number" — is
// answered by the **schema library's coercion rules**, not by StitchAPI. `drift()` only reports the
// difference between the raw body and whatever the validator returned. Hand-rolling the coercion
// would mean inventing the very behaviour under test.
//
// So these scripts use the real Zod v4 that `packages/core` already depends on
// (`packages/core/package.json` devDependencies: `"zod": "^4.4.3"`), reached by relative path
// because pnpm does not hoist it to the workspace root and `docs/` has no manifest of its own.
// It resolves under `tsx` and typechecks under `packages/core`'s strict set; it is a proof-script
// convenience, not a pattern to copy into application code, where `import { z } from 'zod'` is the
// spelling.
export { z } from '../../../../packages/core/node_modules/zod';
