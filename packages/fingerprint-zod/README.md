# @stitchapi/fingerprint-zod

[![npm](https://img.shields.io/npm/v/@stitchapi/fingerprint-zod?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/fingerprint-zod)

Stable [Standard Schema](https://standardschema.dev) fingerprint strategy for
**Zod**, for StitchAPI's response-cache invalidation (ADR 0004).

It walks Zod's internal representation — `_def`/`typeName` on Zod 3, `_zod.def`/
`type` on Zod 4 — into a canonical structural descriptor hashed into an opaque,
synchronous token. The token changes iff the schema's validation/shape semantics
change. It is an **allowlist**: it abstains (returns `value: null`, so the cache
falls back to re-validate-on-hit) on anything it can't soundly capture — opaque
`.refine`/`.transform`/`.default`/custom checks.

`zod` is a **peer dependency**.

```ts
import { zodFingerprinter } from '@stitchapi/fingerprint-zod';
import { registerFingerprinter } from 'stitchapi/fingerprint';

registerFingerprinter(zodFingerprinter);
```

Compliance is proven against `verifyFingerprintContract` from `stitchapi/testing`.

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
