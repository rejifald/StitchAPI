# @stitchapi/fingerprint-effect

[![npm](https://img.shields.io/npm/v/@stitchapi/fingerprint-effect?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/fingerprint-effect)

Stable [Standard Schema](https://standardschema.dev) fingerprint strategy for
**Effect Schema**, for StitchAPI's response-cache invalidation (ADR 0004).

It walks Effect's `.ast` into a canonical structural descriptor hashed into an
opaque, synchronous token. The token changes iff the schema's validation/shape
semantics change. It is an **allowlist**: it abstains (returns `token: null`, so
the cache falls back to re-validate-on-hit) on anything it can't soundly capture —
`Transformation`, `Refinement`, `Suspend`, and `Declaration` AST nodes.

A raw Effect schema is **not** a Standard Schema, so pass the wrapper that
`Schema.standardSchemaV1(...)` produces (it carries both `~standard` and the
underlying `.ast`):

```ts
import { effectFingerprinter } from '@stitchapi/fingerprint-effect';
import * as S from 'effect/Schema';
import { registerFingerprinter } from 'stitchapi/fingerprint';

registerFingerprinter(effectFingerprinter);

const output = S.standardSchemaV1(S.Struct({ id: S.Number }));
```

`effect` is a **peer dependency**. Compliance is proven against
`verifyFingerprintContract` from `stitchapi/testing`.

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
