# @stitchapi/json-schema

[![npm](https://img.shields.io/npm/v/@stitchapi/json-schema?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/json-schema)

Turn a **runtime-discovered JSON Schema** — one you fetch, receive, or have registered by a
tenant, whatever delivered it — into a [Standard Schema](https://standardschema.dev) validator
that [StitchAPI](https://stitchapi.dev) (or any Standard-Schema consumer) accepts directly.

You can't generate TypeScript types for a schema that doesn't exist until runtime. You don't
type across that boundary — you validate at it.

## Install

```sh
pnpm add @stitchapi/json-schema@rc stitchapi@rc
```

`ajv` is the bundled default engine. `stitchapi` is an **optional** peer — the adapter emits
a plain Standard Schema, usable anywhere Zod is.

## Use

```ts
import { toValidator } from 'stitchapi';
import { jsonSchemaValidator } from '@stitchapi/json-schema';

// `discovered` is a JSON Schema you obtained at runtime.
const validator = toValidator(jsonSchemaValidator(discovered));

const result = await validator.validate(payload);
if (!result.ok) {
    // Structured, per-path — hand it back to the sender to correct.
    // [{ path: ['limit'], message: 'must be <= 50' }]
    return respondWithErrors(result.issues);
}
handle(result.value); // `unknown` — a runtime schema carries no static shape
```

`jsonSchemaValidator<T>()` takes an optional type argument. Leave it `unknown` for a
runtime-obtained schema; pass `T` only when you already know the shape at authoring time.

## Bring your own engine

The default engine is Ajv (draft-07 and up, lenient about unknown keywords/formats so
runtime-obtained schemas don't throw). Swap it — a Workers-safe validator, a draft-2020-12 engine, a shared
instance — through `check`; the issue-path mapping stays identical.

```ts
jsonSchemaValidator(discovered, {
    check: (value) => {
        const { valid, errors } = myEngine.validate(value);
        return {
            valid,
            issues: errors.map((e) => ({
                pointer: e.instanceLocation, // JSON Pointer, e.g. '/limit'
                message: e.message,
            })),
        };
    },
});
```

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md)
for local setup, the verify gate, and how to open a PR against `main`.
