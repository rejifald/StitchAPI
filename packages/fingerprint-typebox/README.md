# @stitchapi/fingerprint-typebox

[![npm](https://img.shields.io/npm/v/@stitchapi/fingerprint-typebox?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/fingerprint-typebox)

Stable [Standard Schema](https://standardschema.dev) fingerprint strategy for
**TypeBox**, for StitchAPI's response-cache invalidation (ADR 0004).

A TypeBox schema _is_ a JSON Schema object, so this strategy canonical-hashes it
(recursively sorted keys; the `required` set sorted) into an opaque, synchronous
token. The token changes iff the schema's validation/shape semantics change. It is
an **allowlist**: it abstains (returns `token: null`, so the cache falls back to
re-validate-on-hit) on anything it can't soundly capture — a `Type.Transform`
codec (detected via its symbol, recursively, since it is invisible to
`JSON.stringify`) and opaque kinds (`Function`/`Constructor`/`Unsafe`/…).

> **Caveat:** TypeBox 0.34 schemas do not expose `~standard`, so the StitchAPI
> registry cannot dispatch a raw TypeBox schema to this strategy. Surface the
> schema as a Standard Schema with `~standard.vendor === 'typebox'` (a thin
> wrapper today, or a future TypeBox release) for dispatch to work. This package
> proves the fingerprint logic itself.

`@sinclair/typebox` is a **peer dependency**.

```ts
import { typeboxFingerprinter } from '@stitchapi/fingerprint-typebox';
import { registerFingerprinter } from 'stitchapi/fingerprint';

registerFingerprinter(typeboxFingerprinter);
```

Compliance is proven against `verifyFingerprintContract` from `stitchapi/testing`.

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
