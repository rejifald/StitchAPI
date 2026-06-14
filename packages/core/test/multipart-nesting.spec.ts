// Nested multipart bodies (ADR 0005 Decision 6): `multipart.nesting` controls how a nested
// object/array becomes form-field names. Default `bracket` flattens to parent[child][i] keys;
// `dot` to parent.child.i; `json` rides one JSON part alongside hoisted file parts; `none` is
// the legacy top-level-only behaviour. File leaves (Blob / Uint8Array / { value, filename?,
// type? }) always become binary parts. Asserted end-to-end against the raw multipart body the
// mock server records.
import { stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

const bytes = new Uint8Array([1, 2, 3, 4]);
const rawOf = (path: string): string => String(server.calls(path)[0]?.body);

describe('multipart nesting (ADR 0005 Decision 6)', () => {
    test("'bracket' is the default: nested objects/arrays flatten to parent[child] keys", async () => {
        server.route('POST', '/upload', { body: { ok: true } });
        const upload = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/upload',
            bodyType: 'multipart',
        });

        await upload({
            body: {
                user: { name: 'Ada', roles: ['admin', 'dev'] },
                file: { value: bytes, filename: 'a.bin' },
            },
        });

        const raw = rawOf('/upload');
        expect(raw).toContain('name="user[name]"');
        expect(raw).toContain('Ada');
        expect(raw).toContain('name="user[roles][0]"');
        expect(raw).toContain('name="user[roles][1]"');
        expect(raw).toContain('admin');
        expect(raw).toContain('dev');
        // file leaf stays a binary part at its flattened key
        expect(raw).toContain('name="file"');
        expect(raw).toContain('filename="a.bin"');
        // the broken legacy shape must NOT appear
        expect(raw).not.toContain('[object Object]');
    });

    test("'dot' nesting uses parent.child keys", async () => {
        server.route('POST', '/u', { body: { ok: true } });
        const upload = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/u',
            bodyType: 'multipart',
            multipart: { nesting: 'dot' },
        });

        await upload({ body: { user: { name: 'Ada', roles: ['x'] } } });

        const raw = rawOf('/u');
        expect(raw).toContain('name="user.name"');
        expect(raw).toContain('name="user.roles.0"');
        expect(raw).not.toContain('user[name]');
    });

    test("'json': non-file data is one JSON part; file leaves hoist to path-keyed parts", async () => {
        server.route('POST', '/u', { body: { ok: true } });
        const upload = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/u',
            bodyType: 'multipart',
            multipart: { nesting: 'json' },
        });

        await upload({
            body: {
                meta: { a: 1 },
                file: { value: bytes, filename: 'a.bin' },
                post: { image: bytes },
            },
        });

        const raw = rawOf('/u');
        // one JSON part carries the non-file data, files stripped out of it
        expect(raw).toContain('name="payload"');
        expect(raw).toContain('"meta":{"a":1}');
        // top-level file leaf hoisted to its own part
        expect(raw).toContain('name="file"');
        expect(raw).toContain('filename="a.bin"');
        // nested file leaf hoisted with its bracket path as the key
        expect(raw).toContain('name="post[image]"');
    });

    test("'none' preserves the legacy top-level-only behaviour", async () => {
        server.route('POST', '/u', { body: { ok: true } });
        const upload = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/u',
            bodyType: 'multipart',
            multipart: { nesting: 'none' },
        });

        await upload({ body: { user: { name: 'Ada' }, category: 'movies' } });

        const raw = rawOf('/u');
        expect(raw).toContain('name="category"');
        expect(raw).toContain('movies');
        // a nested object is NOT flattened — it stringifies to [object Object]
        expect(raw).toContain('name="user"');
        expect(raw).toContain('[object Object]');
        expect(raw).not.toContain('user[name]');
    });

    test('a flat body is unchanged under the new default', async () => {
        server.route('POST', '/u', { body: { ok: true } });
        const upload = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/u',
            bodyType: 'multipart',
        });

        await upload({
            body: {
                category: 'movies',
                file: {
                    value: bytes,
                    filename: 'a.bin',
                    type: 'application/octet-stream',
                },
            },
        });

        const raw = rawOf('/u');
        expect(raw).toContain('name="category"');
        expect(raw).toContain('movies');
        expect(raw).toContain('name="file"');
        expect(raw).toContain('filename="a.bin"');
    });

    // contract-not-dependency gate: the capability is a plain config key (not a closure), so a
    // stitch's declaration still serialises losslessly to JSON.
    test('contract gate: multipart.nesting round-trips through __config as JSON', () => {
        const upload = stitch({
            method: 'POST',
            baseUrl: 'https://example.test',
            path: '/u',
            bodyType: 'multipart',
            multipart: { nesting: 'dot' },
        });

        const json = JSON.parse(JSON.stringify(upload.__config)) as {
            bodyType?: string;
            multipart?: { nesting?: string };
        };
        expect(json.bodyType).toBe('multipart');
        expect(json.multipart).toEqual({ nesting: 'dot' });
    });
});
