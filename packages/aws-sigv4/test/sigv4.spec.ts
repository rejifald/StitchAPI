// @stitchapi/aws-sigv4 behaviour. The signer is verified against the official AWS
// `aws-sig-v4-test-suite` `get-vanilla` vector (proving the algorithm, not just
// that it runs); the strategy is driven with a fake request + context.
import { EMPTY_PAYLOAD_SHA256, awsSigV4, signRequestV4 } from '../src';

import { describe, expect, test } from 'vitest';

// The canonical AWS SigV4 example credentials (aws-sig-v4-test-suite).
const ACCESS_KEY = 'AKIDEXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

// A minimal request/context to drive the strategy's `apply`.
function fakeReq(
    over: Partial<{ url: string; method: string; body: unknown }> = {},
) {
    return {
        url: over.url ?? 'https://example.amazonaws.com/',
        method: over.method ?? 'GET',
        headers: {} as Record<string, string>,
        ...(over.body !== undefined ? { body: over.body } : {}),
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
                dateTime: '20150830T123600Z',
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
            dateTime: '20150830T123600Z',
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
});
