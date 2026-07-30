# @stitchapi/json-schema

[![npm](https://img.shields.io/npm/v/@stitchapi/json-schema?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/json-schema)

Adapt a **runtime-discovered JSON Schema** — one you fetch, receive, or have registered by a
tenant, whatever delivered it — into a [Standard Schema](https://standardschema.dev) validator
that [StitchAPI](https://stitchapi.dev) (or any Standard-Schema consumer) accepts directly.

You can't generate TypeScript types for a schema that doesn't exist until runtime. You don't
type across that boundary — you validate at it.

## Install

```sh
pnpm add @stitchapi/json-schema@rc stitchapi@rc ajv
```

This package ships **no validation engine** — you bring your own. `ajv` is an optional peer (needed
only for the `{ ajv }` engine); `stitchapi` is a peer. The adapter emits a plain Standard Schema,
usable anywhere a Standard Schema is — not only with StitchAPI.

## Use

```ts
import { JsonSchema } from '@stitchapi/json-schema';
import Ajv from 'ajv';
import { validate } from 'stitchapi';

const ajv = new Ajv(); // your app's configured engine — formats, keywords, $refs, draft
// `discovered` is a JSON Schema you obtained at runtime.
const schema = JsonSchema.adapt(discovered, { ajv });

const result = await validate(schema, payload);
if (!result.ok) {
    // Structured, per-path — hand it back to the sender to correct.
    // [{ message: 'must be <= 50', path: ['limit'] }]
    return respondWithErrors(result.issues);
}
handle(result.value); // `unknown` — a runtime schema carries no static shape
```

The adapted schema is a plain Standard Schema: pass it to a stitch's `input`/`output`, to
`validate`/`compile`, or to any other Standard-Schema consumer — they all treat it identically.

`JsonSchema.adapt<T>()` takes an optional type argument. Leave it `unknown` for a
runtime-obtained schema; pass `T` only when you already know the shape at authoring time.

## Why you pass the engine

Ajv configuration is stateful and app-specific — custom keywords, formats, `$ref` resolvers, the
draft you target. A vanilla engine this package instantiated itself would **throw or silently
mis-validate** a schema that relies on your setup: "works everywhere except through the adapter."
So the engine isn't optional and isn't hidden — you pass the instance you already use, and the
schema is checked with exactly those semantics. It also keeps `ajv` out of this package's bundle
and off your dependency tree unless you actually use it.

## Bring your own engine

Not on Ajv? Pass a compiled `check` instead — a Workers-safe validator, a draft-2020-12 engine, a
shared instance. Return `valid` plus a JSON Pointer + message per failure; the issue-path mapping
stays identical.

```ts
JsonSchema.adapt(discovered, {
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
