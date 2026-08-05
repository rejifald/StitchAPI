// @stitchapi/aws-sigv4 behaviour. The signer is verified against the official AWS
// `aws-sig-v4-test-suite` `get-vanilla` vector (proving the algorithm, not just
// that it runs); the strategy is driven with a fake request + context.
import { EMPTY_PAYLOAD_SHA256, awsSigV4, signRequestV4 } from '../src';

import { describe, expect, test } from 'vitest';

// The canonical AWS SigV4 example credentials (aws-sig-v4-test-suite).
const ACCESS_KEY = 'AKIDEXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

// A minimal request/context to drive the strategy's `apply`. `bodyType` mirrors
// core's `AdapterRequest.bodyType`, which the engine threads onto the request the
// auth strategy signs (engine.ts) — the signer reads it to match the wire encoding.
function fakeReq(
    over: Partial<{
        url: string;
        method: string;
        body: unknown;
        bodyType: 'json' | 'form' | 'multipart';
    }> = {},
) {
    return {
        url: over.url ?? 'https://example.amazonaws.com/',
        method: over.method ?? 'GET',
        headers: {} as Record<string, string>,
        ...(over.body !== undefined ? { body: over.body } : {}),
        ...(over.bodyType !== undefined ? { bodyType: over.bodyType } : {}),
    };
}
const fakeCtx = { emit: (): void => {} };

// --- signRequestV4 — official vector ---------------------------------------

describe('signRequestV4 (AWS official vectors)', () => {
    test('get-vanilla matches the published signature exactly', async () => {
        const { signature, authorization, signedHeaders } = await signRequestV4(
            {
                method: 'GET',
                url: 'https://example.amazonaws.com/',
                headers: {
                    host: 'example.amazonaws.com',
                    'x-amz-date': '20150830T123600Z',
                },
                payloadHash: EMPTY_PAYLOAD_SHA256,
                accessKeyId: ACCESS_KEY,
                secretAccessKey: SECRET_KEY,
                region: 'us-east-1',
                service: 'service',
                amzDate: '20150830T123600Z',
            },
        );

        expect(signature).toBe(
            '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
        );
        expect(signedHeaders).toBe('host;x-amz-date');
        expect(authorization).toBe(
            'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
                'SignedHeaders=host;x-amz-date, ' +
                'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
        );
    });

    test('query parameters are sorted and percent-encoded canonically', async () => {
        // Same key, different order → identical signature (canonical query is sorted).
        const base = {
            method: 'GET',
            headers: { host: 'example.amazonaws.com' },
            payloadHash: EMPTY_PAYLOAD_SHA256,
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            region: 'us-east-1',
            service: 'service',
            amzDate: '20150830T123600Z',
        } as const;
        const a = await signRequestV4({
            ...base,
            url: 'https://example.amazonaws.com/?b=2&a=1',
        });
        const b = await signRequestV4({
            ...base,
            url: 'https://example.amazonaws.com/?a=1&b=2',
        });
        expect(a.signature).toBe(b.signature);
    });

    test('canonicalises header names (lower-case) and values (trim + collapse whitespace)', async () => {
        const base = {
            method: 'GET',
            url: 'https://example.amazonaws.com/',
            payloadHash: EMPTY_PAYLOAD_SHA256,
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            region: 'us-east-1',
            service: 'service',
            amzDate: '20150830T123600Z',
        } as const;
        // A mixed-case name and a value with leading/trailing/inner whitespace must
        // canonicalise to the already-clean form → an identical signature.
        const messy = await signRequestV4({
            ...base,
            headers: {
                host: 'example.amazonaws.com',
                'X-My-Header': '  a    b  ',
            },
        });
        const clean = await signRequestV4({
            ...base,
            headers: { host: 'example.amazonaws.com', 'x-my-header': 'a b' },
        });
        expect(messy.signedHeaders).toBe('host;x-my-header');
        expect(messy.signature).toBe(clean.signature);
    });

    test('derives the host header from the URL when it is absent', async () => {
        const base = {
            method: 'GET',
            url: 'https://example.amazonaws.com/',
            payloadHash: EMPTY_PAYLOAD_SHA256,
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            region: 'us-east-1',
            service: 'service',
            amzDate: '20150830T123600Z',
        } as const;
        const explicit = await signRequestV4({
            ...base,
            headers: { host: 'example.amazonaws.com' },
        });
        const derived = await signRequestV4({ ...base, headers: {} });
        expect(derived.signedHeaders).toBe('host');
        expect(derived.signature).toBe(explicit.signature);
    });
});

// --- awsSigV4 strategy ------------------------------------------------------

describe('awsSigV4 strategy', () => {
    test('attaches Authorization + x-amz-* headers; empty body → empty-payload hash', async () => {
        const strategy = awsSigV4({
            region: 'us-east-1',
            service: 'execute-api',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: () => SECRET_KEY, // resolved at call time
        });
        const req = fakeReq();
        await strategy.apply(req, fakeCtx as never);

        expect(req.headers['host']).toBe('example.amazonaws.com');
        expect(req.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
        expect(req.headers['x-amz-content-sha256']).toBe(EMPTY_PAYLOAD_SHA256);
        expect(req.headers['authorization']).toMatch(
            /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/execute-api\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
        );
    });

    test('a string body is hashed into x-amz-content-sha256', async () => {
        const strategy = awsSigV4({
            region: 'us-east-1',
            service: 's3',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
        });
        const req = fakeReq({ method: 'PUT', body: 'hello' });
        await strategy.apply(req, fakeCtx as never);
        // SHA-256('hello')
        expect(req.headers['x-amz-content-sha256']).toBe(
            '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        );
    });

    test('a non-string body defaults to UNSIGNED-PAYLOAD', async () => {
        const strategy = awsSigV4({
            region: 'us-east-1',
            service: 'dynamodb',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
        });
        const req = fakeReq({ method: 'POST', body: { TableName: 'x' } });
        await strategy.apply(req, fakeCtx as never);
        expect(req.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    });

    test('a session token adds x-amz-security-token and signs it', async () => {
        const strategy = awsSigV4({
            region: 'us-east-1',
            service: 's3',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            sessionToken: 'tmp-token',
        });
        const req = fakeReq();
        await strategy.apply(req, fakeCtx as never);
        expect(req.headers['x-amz-security-token']).toBe('tmp-token');
        expect(req.headers['authorization']).toContain(
            'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
        );
    });

    test('signBody:false forces UNSIGNED-PAYLOAD even for a string body', async () => {
        const strategy = awsSigV4({
            region: 'us-east-1',
            service: 's3',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            signBody: false,
        });
        const req = fakeReq({ method: 'PUT', body: 'hello' });
        await strategy.apply(req, fakeCtx as never);
        expect(req.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    });

    test('signBody:true hashes an object body as JSON, matching the equivalent string body', async () => {
        const obj = awsSigV4({
            region: 'us-east-1',
            service: 'dynamodb',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            signBody: true,
        });
        const reqObj = fakeReq({ method: 'POST', body: { TableName: 'x' } });
        await obj.apply(reqObj, fakeCtx as never);

        // The default (no signBody) hashes a string body verbatim; for the same JSON
        // text, signBody:true on the object must produce the identical content hash.
        const str = awsSigV4({
            region: 'us-east-1',
            service: 'dynamodb',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
        });
        const reqStr = fakeReq({
            method: 'POST',
            body: JSON.stringify({ TableName: 'x' }),
        });
        await str.apply(reqStr, fakeCtx as never);

        expect(reqObj.headers['x-amz-content-sha256']).toMatch(
            /^[0-9a-f]{64}$/,
        );
        expect(reqObj.headers['x-amz-content-sha256']).toBe(
            reqStr.headers['x-amz-content-sha256'],
        );
    });

    // Regression (SignatureDoesNotMatch): with `bodyType: 'form'` the transport sends
    // `application/x-www-form-urlencoded` bytes (URLSearchParams), NOT JSON. signBody:true
    // must hash those exact wire bytes — hashing JSON.stringify(body) signs bytes that are
    // never sent, so AWS returns 403. Assert parity with the equivalent string body.
    test('signBody:true on a form body signs the URL-encoded wire bytes, not JSON', async () => {
        const body = { Action: 'SendMessage', MessageBody: 'two words' };
        // What core's transport actually sends: 'Action=SendMessage&MessageBody=two+words'.
        const wire = new URLSearchParams(body).toString();

        const form = awsSigV4({
            region: 'us-east-1',
            service: 'sqs',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            signBody: true,
        });
        const reqForm = fakeReq({ method: 'POST', body, bodyType: 'form' });
        await form.apply(reqForm, fakeCtx as never);

        // A string body is hashed verbatim; the form path must hash the SAME wire bytes.
        const str = awsSigV4({
            region: 'us-east-1',
            service: 'sqs',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
        });
        const reqStr = fakeReq({ method: 'POST', body: wire });
        await str.apply(reqStr, fakeCtx as never);

        expect(reqForm.headers['x-amz-content-sha256']).toBe(
            reqStr.headers['x-amz-content-sha256'],
        );

        // …and it must NOT be the (buggy) JSON hash the transport never sends.
        const jsonStrategy = awsSigV4({
            region: 'us-east-1',
            service: 'sqs',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
        });
        const reqJson = fakeReq({ method: 'POST', body: JSON.stringify(body) });
        await jsonStrategy.apply(reqJson, fakeCtx as never);
        expect(reqForm.headers['x-amz-content-sha256']).not.toBe(
            reqJson.headers['x-amz-content-sha256'],
        );
    });

    // Regression (SignatureDoesNotMatch): a multipart body is sent as FormData with a
    // transport-generated boundary, so its exact bytes are unknowable at sign time — the
    // payload cannot be signed. signBody:true must refuse loudly rather than emit a hash
    // (JSON of the body) that is guaranteed not to match.
    test('signBody:true on a multipart body throws (boundary is transport-generated)', async () => {
        const strategy = awsSigV4({
            region: 'us-east-1',
            service: 's3',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            signBody: true,
        });
        const req = fakeReq({
            method: 'POST',
            body: { file: 'x' },
            bodyType: 'multipart',
        });
        await expect(strategy.apply(req, fakeCtx as never)).rejects.toThrow(
            /multipart/i,
        );
    });

    // Regression (403 SignatureDoesNotMatch — the S3 headline case): a request carrying a
    // custom `x-amz-*` header (e.g. `x-amz-acl`, routine for S3 PutObject) must have that
    // header SIGNED. AWS requires host + every `x-amz-*` header to be in SignedHeaders; a
    // request that sends `x-amz-acl` on the wire but omits it from the signature is rejected.
    // The strategy must fold the request's own headers into the signed set.
    test("signs the request's own x-amz-* headers (SignedHeaders includes x-amz-acl)", async () => {
        const strategy = awsSigV4({
            region: 'us-east-1',
            service: 's3',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
        });
        const req = fakeReq({ method: 'PUT', body: 'data' });
        req.headers['x-amz-acl'] = 'public-read';
        await strategy.apply(req, fakeCtx as never);

        // The header the request carries must appear in SignedHeaders, in canonical
        // (sorted) position — proof it's inside the signed canonical request, not just
        // sent unsigned on the wire (which is what triggers 403 SignatureDoesNotMatch).
        expect(req.headers['authorization']).toContain(
            'SignedHeaders=host;x-amz-acl;x-amz-content-sha256;x-amz-date',
        );
    });

    // Same header-coverage proof, but pinned to a fixed clock via the low-level signer so we
    // can assert the signature actually CHANGES when the x-amz-acl value changes — the real
    // guarantee that the header is inside the signed canonical request, not just listed.
    test('the signature covers the x-amz-acl value (differs when the value differs)', async () => {
        const base = {
            method: 'PUT',
            url: 'https://my-bucket.s3.amazonaws.com/key',
            payloadHash: EMPTY_PAYLOAD_SHA256,
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            region: 'us-east-1',
            service: 's3',
            amzDate: '20150830T123600Z',
        } as const;
        const aclPublic = await signRequestV4({
            ...base,
            headers: {
                host: 'my-bucket.s3.amazonaws.com',
                'x-amz-acl': 'public-read',
                'x-amz-date': '20150830T123600Z',
                'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
            },
        });
        const aclPrivate = await signRequestV4({
            ...base,
            headers: {
                host: 'my-bucket.s3.amazonaws.com',
                'x-amz-acl': 'private',
                'x-amz-date': '20150830T123600Z',
                'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
            },
        });
        expect(aclPublic.signedHeaders).toContain('x-amz-acl');
        expect(aclPublic.signature).not.toBe(aclPrivate.signature);
    });

    // Regression (403 SignatureDoesNotMatch): the transport drops the body for GET/HEAD
    // (encodeRequestBody short-circuits to no body), so a GET/HEAD stitch that carries a
    // `body` must still sign the EMPTY-payload hash — signing sha256(body) signs bytes the
    // transport never sends. Force the empty-payload hash for GET/HEAD regardless of body.
    test('GET with a body still signs the empty-payload hash (transport sends no body)', async () => {
        const strategy = awsSigV4({
            region: 'us-east-1',
            service: 's3',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
        });
        const req = fakeReq({ method: 'GET', body: 'hello' });
        await strategy.apply(req, fakeCtx as never);
        // NOT sha256('hello') = 2cf24dba… — the transport sends nothing for GET.
        expect(req.headers['x-amz-content-sha256']).toBe(EMPTY_PAYLOAD_SHA256);
    });

    test('HEAD with a body still signs the empty-payload hash', async () => {
        const strategy = awsSigV4({
            region: 'us-east-1',
            service: 's3',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            signBody: true, // even with signBody:true, GET/HEAD carry no wire body
        });
        const req = fakeReq({ method: 'HEAD', body: 'hello' });
        await strategy.apply(req, fakeCtx as never);
        expect(req.headers['x-amz-content-sha256']).toBe(EMPTY_PAYLOAD_SHA256);
    });

    // The default (no signBody) is unchanged for form/multipart: UNSIGNED-PAYLOAD, no throw.
    test('form/multipart bodies without signBody stay UNSIGNED-PAYLOAD', async () => {
        const strategy = awsSigV4({
            region: 'us-east-1',
            service: 's3',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
        });
        const reqForm = fakeReq({
            method: 'POST',
            body: { a: 1 },
            bodyType: 'form',
        });
        await strategy.apply(reqForm, fakeCtx as never);
        expect(reqForm.headers['x-amz-content-sha256']).toBe(
            'UNSIGNED-PAYLOAD',
        );

        const reqMultipart = fakeReq({
            method: 'POST',
            body: { file: 'x' },
            bodyType: 'multipart',
        });
        await strategy.apply(reqMultipart, fakeCtx as never);
        expect(reqMultipart.headers['x-amz-content-sha256']).toBe(
            'UNSIGNED-PAYLOAD',
        );
    });
});
