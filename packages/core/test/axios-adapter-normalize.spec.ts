// axiosAdapter normalization branches (src/axios-adapter.ts) beyond adapters.spec.ts. That suite
// always returns a Node Buffer as `data`, so only toArrayBuffer's view branch runs. These cover the
// rest of toArrayBuffer (used when a client ignores responseType or hands back raw bytes/objects)
// plus header handling:
//   - a raw ArrayBuffer passes through; a string is encoded; an already-parsed object is
//     JSON-re-encoded; null/undefined data → an empty body;
//   - a caller-supplied content-type is preserved (not overridden by the body type);
//   - per-call headers override the adapter defaults.
import { axiosAdapter } from '../src';
import type {
    AxiosLike,
    AxiosLikeConfig,
    AxiosLikeResponse,
} from '../src/axios-adapter';
import type { AdapterRequest } from '../src/types';

function recordingClient(
    respond: () => AxiosLikeResponse,
): AxiosLike & { calls: AxiosLikeConfig[] } {
    const calls: AxiosLikeConfig[] = [];
    return {
        calls,
        request(config) {
            calls.push(config);
            return Promise.resolve(respond());
        },
    };
}

const req = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
    url: 'https://api.test/x',
    method: 'GET',
    headers: {},
    ...over,
});

// Decode whatever `data` shape a client returns, under a JSON content-type.
const decodeData = async (data: unknown): Promise<unknown> => {
    const client = recordingClient(() => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data,
    }));
    return (await axiosAdapter(client)(req())).body;
};

describe('axiosAdapter toArrayBuffer normalization', () => {
    test('passes a raw ArrayBuffer through', async () => {
        const buf = new TextEncoder().encode('{"x":1}').buffer;
        expect(await decodeData(buf)).toEqual({ x: 1 });
    });

    test('encodes a string body', async () => {
        expect(await decodeData('{"x":1}')).toEqual({ x: 1 });
    });

    test('JSON-re-encodes an already-parsed object (client ignored responseType)', async () => {
        expect(await decodeData({ x: 1 })).toEqual({ x: 1 });
    });

    test('treats null data as an empty body', async () => {
        expect(await decodeData(null)).toBeUndefined();
    });
});

describe('axiosAdapter headers', () => {
    test('preserves a caller-supplied content-type', async () => {
        const client = recordingClient(() => ({
            status: 200,
            headers: {},
            data: null,
        }));
        await axiosAdapter(client)(
            req({
                method: 'POST',
                headers: { 'content-type': 'application/custom' },
                body: { a: 1 },
                bodyType: 'json',
            }),
        );
        expect(client.calls[0]?.headers?.['content-type']).toBe(
            'application/custom',
        );
    });

    test('per-call headers override the adapter defaults', async () => {
        const client = recordingClient(() => ({
            status: 200,
            headers: {},
            data: null,
        }));
        await axiosAdapter(client, {
            headers: { 'x-env': 'prod', 'x-shared': 'default' },
        })(req({ headers: { 'x-shared': 'override', 'x-req': '1' } }));
        const h = client.calls[0]?.headers;
        expect(h?.['x-env']).toBe('prod'); // default kept
        expect(h?.['x-shared']).toBe('override'); // per-call wins
        expect(h?.['x-req']).toBe('1'); // per-call added
    });
});
