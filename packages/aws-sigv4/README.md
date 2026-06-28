# @stitchapi/aws-sigv4

[![npm](https://img.shields.io/npm/v/@stitchapi/aws-sigv4?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/aws-sigv4)

[AWS Signature Version 4](https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html) request signing for [StitchAPI](https://stitchapi.dev). Core's built-in auth covers bearer / apiKey / basic / cookieSession / oauth2 — this adds the one scheme they don't: **request signing**, which AWS APIs, S3-compatible stores, and many SigV4-protected endpoints require.

`awsSigV4(...)` returns an `AuthStrategy` you attach as a stitch's `auth`. It signs the **fully-built** request (method · URI · query · headers · payload hash) at call time and attaches the `Authorization` / `x-amz-*` headers — so the secret never reaches the call site or a trace.

Crypto is the platform's **Web Crypto** (`crypto.subtle`), so it runs unchanged on Node 20+, edge runtimes (Workers / Deno), and the browser; Node 18 falls back to `node:crypto`. No runtime dependencies.

## Install

```sh
pnpm add @stitchapi/aws-sigv4 stitchapi
```

`stitchapi` is the only peer dependency.

## Usage

```ts
import { awsSigV4 } from '@stitchapi/aws-sigv4';
import { env, stitch } from 'stitchapi';

const putObject = stitch({
    baseUrl: 'https://my-bucket.s3.us-east-1.amazonaws.com',
    path: '/{key}',
    method: 'PUT',
    auth: awsSigV4({
        region: 'us-east-1',
        service: 's3',
        accessKeyId: env('AWS_ACCESS_KEY_ID'),
        secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
        // sessionToken: env('AWS_SESSION_TOKEN'), // temporary credentials
    }),
});
```

Credentials are `Secret`s (a string or a call-time getter like `env(...)`), resolved per call so an agent never sees them. The signature is computed on the final request — after path templating and query building — so it always matches the bytes the transport sends.

## Payload signing

The `x-amz-content-sha256` header is set automatically:

-   **No body** → the empty-payload hash (always correct).
-   **String body** → its SHA-256 (exact bytes).
-   **Non-string body** → `UNSIGNED-PAYLOAD` (safe over HTTPS, what S3 and many services accept). Set `signBody: true` to hash `JSON.stringify(body)` instead — it must match what the transport sends.

## Low-level signer

`signRequestV4(params)` is the pure signing function the strategy wraps — exported so you can sign out of band (e.g. presigned URLs, tests). It is verified against the official AWS `aws-sig-v4-test-suite` vectors.

```ts
import { signRequestV4 } from '@stitchapi/aws-sigv4';

const { authorization, signature } = await signRequestV4({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    headers: {
        host: 'example.amazonaws.com',
        'x-amz-date': '20150830T123600Z',
    },
    payloadHash: '<hex-sha256-or-UNSIGNED-PAYLOAD>',
    accessKeyId: 'AKID…',
    secretAccessKey: '…',
    region: 'us-east-1',
    service: 'service',
    dateTime: '20150830T123600Z',
});
```

## License

Apache-2.0

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
