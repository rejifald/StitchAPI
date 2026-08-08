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
            wire: { body: 'multipart' },
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
            wire: { body: 'multipart', multipart: { nesting: 'dot' } },
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
            wire: { body: 'multipart', multipart: { nesting: 'json' } },
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
            wire: { body: 'multipart', multipart: { nesting: 'none' } },
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
            wire: { body: 'multipart' },
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

    // A plain domain object that merely carries a `value` key (e.g. money `{ value, currency }`) is
    // NOT a file part. The old `isFileLeaf` treated ANY `{ value }` object as a file, so it encoded
    // `value` as a tiny Blob and silently DROPPED the siblings; it must recurse as a nested object.
    test('a { value, ... } object without binary/filename is a nested object, not a file (siblings survive)', async () => {
        server.route('POST', '/u', { body: { ok: true } });
        const upload = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/u',
            wire: { body: 'multipart' },
        });

        await upload({ body: { amount: { value: 100, currency: 'USD' } } });

        const raw = rawOf('/u');
        // Both fields survive as normal string parts…
        expect(raw).toContain('name="amount[value]"');
        expect(raw).toContain('100');
        expect(raw).toContain('name="amount[currency]"');
        expect(raw).toContain('USD');
        // …and `amount` is NOT a file part (the old bug encoded it as a 3-byte Blob, losing currency).
        expect(raw).not.toContain('name="amount"');
        expect(raw).not.toContain('filename=');
    });

    // #701 §2: the same silent-sibling-loss bug, reached through `type` instead of `value`.
    // `type` is a modifier on a file part (it sets the part's content type), never the thing that
    // MAKES one — it is far too common a domain key (`{ value, type: 'refund' }`) to discriminate on.
    test('a { value, type } domain object is a nested object, not a file (every sibling survives)', async () => {
        server.route('POST', '/u', { body: { ok: true } });
        const upload = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/u',
            wire: { body: 'multipart' },
        });

        await upload({
            body: { refund: { value: 100, type: 'refund', currency: 'USD' } },
        });

        const raw = rawOf('/u');
        // All three fields survive as normal string parts…
        expect(raw).toContain('name="refund[value]"');
        expect(raw).toContain('100');
        expect(raw).toContain('name="refund[type]"');
        expect(raw).toContain('refund');
        expect(raw).toContain('name="refund[currency]"');
        expect(raw).toContain('USD');
        // …and `refund` is NOT a file part (the bug encoded it as a 3-byte Blob typed `refund`,
        // losing `type` and `currency` outright, and the call still returned 200).
        expect(raw).not.toContain('name="refund"\r\n');
        expect(raw).not.toContain('filename=');
    });

    test('a binary wrapper carrying only a `type` (no filename) is still a file part', async () => {
        server.route('POST', '/u', { body: { ok: true } });
        const upload = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/u',
            wire: { body: 'multipart' },
        });

        await upload({
            body: { doc: { value: bytes, type: 'application/x-custom' } },
        });

        const raw = rawOf('/u');
        expect(raw).toContain('name="doc"');
        // the `type` still reaches the wire as the part's content type…
        expect(raw).toContain('application/x-custom');
        // …and it did NOT recurse into value/type string fields
        expect(raw).not.toContain('doc[value]');
        expect(raw).not.toContain('doc[type]');
    });

    test("'json' nesting: an explicit { value, filename } still hoists to a file part", async () => {
        server.route('POST', '/u', { body: { ok: true } });
        const upload = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/u',
            wire: { body: 'multipart', multipart: { nesting: 'json' } },
        });

        await upload({
            body: {
                amount: { value: 100, type: 'refund' },
                note: { value: 'hello', filename: 'n.txt' },
            },
        });

        const raw = rawOf('/u');
        // the filename arm survives the narrowing — still hoisted out of the JSON part
        expect(raw).toContain('name="note"');
        expect(raw).toContain('filename="n.txt"');
        // the domain object rides inside the JSON part, both keys intact
        expect(raw).toContain('name="payload"');
        expect(raw).toContain('"amount":{"value":100,"type":"refund"}');
    });

    test('a real { value: <Uint8Array>, filename } wrapper is still a file part', async () => {
        server.route('POST', '/u', { body: { ok: true } });
        const upload = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/u',
            wire: { body: 'multipart' },
        });

        await upload({ body: { doc: { value: bytes, filename: 'a.bin' } } });

        const raw = rawOf('/u');
        expect(raw).toContain('name="doc"');
        expect(raw).toContain('filename="a.bin"');
        // it did NOT recurse into value/filename string fields
        expect(raw).not.toContain('doc[value]');
        expect(raw).not.toContain('doc[filename]');
    });

    test('an explicit { value: "text", filename } is a named file part even with a string body', async () => {
        server.route('POST', '/u', { body: { ok: true } });
        const upload = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/u',
            wire: { body: 'multipart' },
        });

        await upload({ body: { note: { value: 'hello', filename: 'n.txt' } } });

        const raw = rawOf('/u');
        expect(raw).toContain('name="note"');
        expect(raw).toContain('filename="n.txt"');
        expect(raw).toContain('hello');
        expect(raw).not.toContain('note[value]');
    });

    // contract-not-dependency gate: the capability is a plain config key (not a closure), so a
    // stitch's declaration still serialises losslessly to JSON.
    test('contract gate: multipart.nesting round-trips through __config as JSON', () => {
        const upload = stitch({
            method: 'POST',
            baseUrl: 'https://example.test',
            path: '/u',
            wire: { body: 'multipart', multipart: { nesting: 'dot' } },
        });

        const json = JSON.parse(JSON.stringify(upload.__config)) as {
            wire?: { body?: string; multipart?: { nesting?: string } };
        };
        // The whole `wire` envelope is plain JSON — it survives the round-trip intact, with
        // `multipart` in its normalised object form (the P12 scalar never reaches `__config`).
        expect(json.wire).toEqual({
            body: 'multipart',
            multipart: { nesting: 'dot' },
        });
    });
});
