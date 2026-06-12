import type { Validator } from '../../src/validator';

/**
 * `StitchConfig.output` (and the `input` schemas) are typed as `Validator`, but at
 * runtime stitch() coerces any Zod or Standard Schema through `toValidator()` — see
 * `normalizeOutput` in src/stitch.ts. The tests pass raw schemas on purpose: that
 * Zod-first ergonomics is exactly what's under test.
 *
 * This is a type-only assertion (the runtime value is returned unchanged), so the raw
 * schema still flows through the real coercion path — unlike `toValidator(schema)`,
 * which would pre-coerce and skip the behaviour the tests mean to exercise.
 */
export const asValidator = (schema: unknown): Validator => schema as Validator;
