# @stitchapi/fingerprint-arktype

[![npm](https://img.shields.io/npm/v/@stitchapi/fingerprint-arktype?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/fingerprint-arktype)

Stable [Standard Schema](https://standardschema.dev) fingerprint strategy for
**ArkType**, for StitchAPI's response-cache invalidation (ADR 0004).

It reads ArkType's canonical `t.json` representation and hashes a canonicalised
form into an opaque, synchronous token. The token changes iff the schema's
validation/shape semantics change. It is an **allowlist**: it abstains (returns
`token: null`, so the cache falls back to re-validate-on-hit) on anything it can't
soundly capture — morphs (`.pipe`) and narrows (`.narrow`), which ArkType emits as
opaque, non-deterministic `$ark.fn<n>` references, and property defaults.

`arktype` is a **peer dependency**.

```ts
import { arktypeFingerprinter } from '@stitchapi/fingerprint-arktype';
import { registerFingerprinter } from 'stitchapi/fingerprint';

registerFingerprinter(arktypeFingerprinter);
```

Compliance is proven against `conformance.fingerprint` from `stitchapi/testing`.

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
