// @generated — do not edit by hand.
// Regenerate: node docs/sandbox/runtime/gen-sandbox-modules.mjs
// Source of truth: docs/sandbox/runtime/playground-packages.mjs
//
// The curated module registry a playground snippet's `import { x } from
// '<specifier>'` resolves against (worker-entry's `__stitchImport`), beyond the
// core `stitchapi` surface which is injected name-by-name separately.
import * as m0 from "zod";
import * as m1 from "ajv";
import * as m2 from "@stitchapi/json-schema";

export const sandboxModules: Record<string, unknown> = {
    "zod": m0,
    "ajv": m1,
    "@stitchapi/json-schema": m2,
};
