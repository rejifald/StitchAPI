# @stitchapi/fingerprint-valibot

[![npm](https://img.shields.io/npm/v/@stitchapi/fingerprint-valibot?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/fingerprint-valibot)

Stable [Standard Schema](https://standardschema.dev) fingerprint strategy for
**Valibot**, for StitchAPI's response-cache invalidation (ADR 0004).

It walks Valibot's plain-object representation — `.type`, `.entries`, and the
`.pipe` action chain — into a canonical structural descriptor hashed into an
opaque, synchronous token. The token changes iff the schema's validation/shape
semantics change. It is an **allowlist**: it abstains (returns `token: null`, so
the cache falls back to re-validate-on-hit) on anything it can't soundly capture —
`transformation` actions, `check`/`custom`/`raw_*` actions, function-valued
requirements, and injected defaults.

`valibot` is a **peer dependency**.

```ts
import { valibotFingerprinter } from '@stitchapi/fingerprint-valibot';
import { fingerprinters } from 'stitchapi/fingerprint';

fingerprinters.register(valibotFingerprinter);
```

Compliance is proven against `verifyFingerprintContract` from `stitchapi/testing`.

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
