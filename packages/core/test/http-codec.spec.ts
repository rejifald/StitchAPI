// Direct tests for the shared body codec in src/http-adapter.ts. encodeRequestBody /
// decodeResponseBody are exercised only INDIRECTLY (through fetchAdapter / the axios adapter); their
// branches are pinned here head-on, the way every transport relies on them:
//   encodeRequestBody  — GET/HEAD drop a body; null → none; a string passes through verbatim (no
//                        content-type); form → urlencoded (null/undefined skipped, values String()d);
//                        multipart → FormData; an object default → JSON + application/json.
//   decodeResponseBody — arrayBuffer/blob passthrough (blob carries the content-type); responseType
//                        'text' wins over a JSON content-type; JSON is decoded via content-type
//                        (incl. `+json`) or a forced responseType 'json'; empty JSON → undefined.
import { decodeResponseBody, encodeRequestBody } from '../src/http-adapter';
import type { AdapterRequest } from '../src/types';

const req = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
    url: 'https://api.test/x',
    method: 'POST',
    headers: {},
    ...over,
});
const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;

describe('encodeRequestBody', () => {
    test('GET/HEAD never send a body', () => {
        expect(
            encodeRequestBody(req({ method: 'GET', body: { a: 1 } })).body,
        ).toBeUndefined();
        expect(
            encodeRequestBody(req({ method: 'HEAD', body: { a: 1 } })).body,
        ).toBeUndefined();
    });

    test('a null/undefined body produces none', () => {
        expect(encodeRequestBody(req({ body: null })).body).toBeUndefined();
        expect(
            encodeRequestBody(req({ body: undefined })).body,
        ).toBeUndefined();
    });

    test('a string body passes through verbatim with no content-type', () => {
        const out = encodeRequestBody(req({ body: 'raw', bodyType: 'json' }));
        expect(out.body).toBe('raw');
        expect(out.contentType).toBeUndefined();
    });

    test('a form body is urlencoded (null/undefined skipped, values stringified)', () => {
        const out = encodeRequestBody(
            req({
                body: { a: 1, b: 'x y', c: null, d: undefined },
                bodyType: 'form',
            }),
        );
        expect(out.body).toBe('a=1&b=x+y');
        expect(out.contentType).toBe('application/x-www-form-urlencoded');
    });

    test('a multipart body becomes FormData (boundary set by the transport)', () => {
        const out = encodeRequestBody(
            req({ body: { f: 'v' }, bodyType: 'multipart' }),
        );
        expect(out.body).toBeInstanceOf(FormData);
        expect(out.contentType).toBeUndefined();
    });

    test('an object body defaults to JSON', () => {
        const out = encodeRequestBody(req({ body: { a: 1 } }));
        expect(out.body).toBe('{"a":1}');
        expect(out.contentType).toBe('application/json');
    });
});

describe('decodeResponseBody', () => {
    test('arrayBuffer passes the bytes through unchanged', () => {
        const bytes = enc('anything');
        expect(
            decodeResponseBody('arrayBuffer', 'application/json', bytes),
        ).toBe(bytes);
    });

    test('blob carries the content-type', () => {
        const out = decodeResponseBody('blob', 'image/png', enc('x'));
        expect(out).toBeInstanceOf(Blob);
        expect((out as Blob).type).toBe('image/png');
    });

    test("responseType 'text' wins over a JSON content-type", () => {
        expect(
            decodeResponseBody('text', 'application/json', enc('{"a":1}')),
        ).toBe('{"a":1}');
    });

    test('JSON is decoded via content-type, including +json suffixes', () => {
        expect(
            decodeResponseBody(undefined, 'application/json', enc('{"a":1}')),
        ).toEqual({ a: 1 });
        expect(
            decodeResponseBody(
                undefined,
                'application/ld+json',
                enc('{"a":1}'),
            ),
        ).toEqual({ a: 1 });
    });

    test("responseType 'json' forces a parse for a non-JSON content-type", () => {
        expect(
            decodeResponseBody('json', 'text/plain', enc('{"a":1}')),
        ).toEqual({
            a: 1,
        });
    });

    test('an empty JSON body decodes to undefined', () => {
        expect(
            decodeResponseBody(
                undefined,
                'application/json',
                new ArrayBuffer(0),
            ),
        ).toBeUndefined();
    });

    test('a non-JSON content-type decodes to text', () => {
        expect(decodeResponseBody(undefined, 'text/plain', enc('hello'))).toBe(
            'hello',
        );
    });
});
