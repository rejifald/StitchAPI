// @stitchapi/aws-sigv4 behaviour. The signer is verified against the official AWS
// `aws-sig-v4-test-suite` `get-vanilla` vector (proving the algorithm, not just
// that it runs); the strategy is driven with a fake request + context.
import { EMPTY_PAYLOAD_SHA256, awsSigV4, signRequestV4 } from '../src';

import { stitch } from 'stitchapi';
import { manualClock, mockAdapter } from 'stitchapi/testing';
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
// These tests assert the headers the strategy attaches, not the run's event stream,
// so `emit` discards. (`=> undefined`, not an empty body — one shared no-op keeps
// `no-empty-function` satisfied instead of baselined.)
const noEmit = (): void => undefined;
const fakeCtx = { emit: noEmit };
// The same context carrying an injected `Clock` — what the engine threads onto
// `AuthContext.clock` (types.ts), so the signer's timestamp is testable.
const ctxAt = (epochMs: number) => ({
    emit: noEmit,
    clock: manualClock(epochMs),
});

/** `'20150830T123600Z'` → epoch ms. The inverse of the signer's `amzDateOf`. */
function parseAmzDate(stamp: string): number {
    return Date.parse(
        `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
            `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
    );
}

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

// --- the injected clock (ADR 0010, issue #658 §2) ---------------------------
//
// The signing timestamp is CONTROL-FLOW time — it decides whether AWS accepts the
// request — so it rides the engine-threaded `Clock` (`AuthContext.clock`), the same
// seam that drives retry/throttle/timeout/circuit and OAuth2 token freshness. Reading
// `new Date()` instead made SigV4 untestable on a virtual clock: 600 virtual seconds
// moved the stamp 0 seconds, and a default `manualClock()` (which starts at epoch)
// produced a real-time stamp, so nothing about skew could be asserted at all.

const CLOCK_KEYS = {
    region: 'us-east-1',
    service: 's3',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
} as const;

describe('awsSigV4 (the injected clock)', () => {
    test('the x-amz-date stamp moves with virtual time, not wall-clock time', async () => {
        const strategy = awsSigV4(CLOCK_KEYS);
        const start = Date.UTC(2015, 7, 30, 12, 36, 0);

        const first = fakeReq();
        await strategy.apply(first, ctxAt(start) as never);
        expect(first.headers['x-amz-date']).toBe('20150830T123600Z');

        // The issue's measurement: 600 virtual seconds must move the stamp 600 seconds.
        const later = fakeReq();
        await strategy.apply(later, ctxAt(start + 600_000) as never);
        expect(later.headers['x-amz-date']).toBe('20150830T124600Z');

        expect(
            parseAmzDate(later.headers['x-amz-date'] as string) -
                parseAmzDate(first.headers['x-amz-date'] as string),
        ).toBe(600_000);
    });

    test('a default manualClock() signs at the epoch it actually reads', async () => {
        // `manualClock()` starts at 0. The stamp must say so — that apparent ~20,670-day
        // skew is the clock the test chose, and being able to SEE it is the point.
        const strategy = awsSigV4(CLOCK_KEYS);
        const req = fakeReq();
        await strategy.apply(req, ctxAt(0) as never);
        expect(req.headers['x-amz-date']).toBe('19700101T000000Z');
    });

    test('the signature itself changes with the clock (the stamp is inside it)', async () => {
        // Not just the header: the timestamp and its derived credential scope are part of
        // the string-to-sign, so a different virtual instant must yield a different
        // signature — otherwise the stamp is cosmetic.
        const strategy = awsSigV4(CLOCK_KEYS);
        const a = fakeReq();
        const b = fakeReq();
        await strategy.apply(
            a,
            ctxAt(Date.UTC(2015, 7, 30, 12, 36, 0)) as never,
        );
        await strategy.apply(
            b,
            ctxAt(Date.UTC(2015, 7, 31, 12, 36, 0)) as never,
        );

        expect(a.headers['authorization']).not.toBe(b.headers['authorization']);
        // A day later ⇒ a different credential scope date, too.
        expect(a.headers['authorization']).toContain('/20150830/us-east-1/s3/');
        expect(b.headers['authorization']).toContain('/20150831/us-east-1/s3/');
    });

    // The wire behaviour must not change. With no clock on the context — a hand-built
    // AuthContext, or any caller on the system clock — the signature must be exactly
    // what it is today. Proven without a race: sign once on the wall clock, read back
    // the instant it stamped, then re-sign the identical request on a clock pinned to
    // that instant. Byte-identical output ⇒ this is a testability fix, not a wire fix.
    test('no injected clock ⇒ byte-identical to the wall-clock signature', async () => {
        const strategy = awsSigV4(CLOCK_KEYS);

        const before = Date.now();
        const wall = fakeReq({ method: 'PUT', body: 'payload' });
        await strategy.apply(wall, fakeCtx as never);
        const after = Date.now();

        // It really is wall-clock time (the stamp truncates to the second, so it can
        // sit up to 999 ms behind the reading taken just before `apply`).
        const stamped = parseAmzDate(wall.headers['x-amz-date'] as string);
        expect(stamped).toBeGreaterThanOrEqual(before - 1000);
        expect(stamped).toBeLessThanOrEqual(after);

        const pinned = fakeReq({ method: 'PUT', body: 'payload' });
        await strategy.apply(pinned, ctxAt(stamped) as never);

        expect(pinned.headers['x-amz-date']).toBe(wall.headers['x-amz-date']);
        expect(pinned.headers['x-amz-content-sha256']).toBe(
            wall.headers['x-amz-content-sha256'],
        );
        expect(pinned.headers['authorization']).toBe(
            wall.headers['authorization'],
        );
    });

    // A golden signature, pinned to a fixed instant: proof the on-the-wire bytes for a
    // known clock reading are what they have always been. If the timestamp path ever
    // changes shape (precision, format, scope derivation), this literal fails.
    //
    // The literal is not "whatever the code emits" — it was cross-checked against an
    // independent SigV4 implementation that reproduces the official `get-vanilla`
    // vector above. Same request and instant as that vector, plus the
    // `x-amz-content-sha256` header the strategy attaches (hence a different signature).
    test('a pinned clock reproduces the exact Authorization header', async () => {
        const strategy = awsSigV4({
            region: 'us-east-1',
            service: 'service',
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
        });
        const req = fakeReq({ url: 'https://example.amazonaws.com/' });
        await strategy.apply(
            req,
            ctxAt(Date.UTC(2015, 7, 30, 12, 36, 0)) as never,
        );

        expect(req.headers['x-amz-date']).toBe('20150830T123600Z');
        expect(req.headers['authorization']).toBe(
            'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
                'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
                'Signature=726c5c4879a6b4ccbbd3b24edbd6b8826d34f87450fbbf4e85546fc7ba9c1642',
        );
    });

    // End-to-end through the public API: the engine threads the stitch's `clock` onto
    // `AuthContext`, so a `manualClock()` on the stitch drives the signature the
    // transport actually receives. This is the seam the issue asked for.
    test('a stitch clock drives the signed request the transport receives', async () => {
        const clock = manualClock(Date.UTC(2015, 7, 30, 12, 36, 0));
        const api = mockAdapter({
            match: '/objects',
            respond: { body: { ok: true } },
        });
        const call = stitch({
            baseUrl: 'https://my-bucket.s3.us-east-1.amazonaws.com',
            path: '/objects',
            adapter: api,
            clock,
            auth: awsSigV4(CLOCK_KEYS),
        });

        await call();
        expect(api.lastRequest()?.headers['x-amz-date']).toBe(
            '20150830T123600Z',
        );

        await clock.advance(600_000); // ten virtual minutes
        await call();
        expect(api.lastRequest()?.headers['x-amz-date']).toBe(
            '20150830T124600Z',
        );
    });
});
