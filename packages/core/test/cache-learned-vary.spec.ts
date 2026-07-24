// The "learned Vary" path of createCache (src/cache.ts): honouring a RESPONSE `Vary` header. The
// cache specs cover config-driven `explicitVary` and the end-to-end engine flow, but not the
// response-driven branch the controller implements in open().get()/.set():
//   - `Vary: *` is never stored (uncacheable);
//   - a `Vary: <header>` response keys the entry by that request header — same value → hit, a
//     different value → miss (a distinct learned-vary entry), even though both share the base key.
import { memoryStore } from '../src';
import { createCache } from '../src/cache';
import type { RequestDescriptor } from '../src/cache';

const desc = (headers?: Record<string, string>): RequestDescriptor => ({
    method: 'GET',
    url: 'https://api.test/x',
    ...(headers ? { headers } : {}),
});

describe('createCache learned Vary (response-driven)', () => {
    test('a Vary: * response is never stored', async () => {
        const store = memoryStore();
        const cache = createCache({ config: { ttl: 0 }, store, stitchId: 's' });
        const d = desc();
        const baseKey = cache.keyOf(d, {});
        if (baseKey === undefined) throw new Error('expected a derived key');
        await (await cache.open(baseKey, d)).set('VALUE', 200, '*');
        expect(await (await cache.open(baseKey, d)).get()).toBeNull();
    });

    test('a Vary response header keys the entry by that request header', async () => {
        const store = memoryStore();
        const cache = createCache({ config: { ttl: 0 }, store, stitchId: 's' });
        const en = desc({ 'accept-language': 'en' });
        const de = desc({ 'accept-language': 'de' });
        const baseKey = cache.keyOf(en, {});
        if (baseKey === undefined) throw new Error('expected a derived key');
        // Without an explicit vary allowlist, accept-language is NOT in the base key.
        expect(cache.keyOf(de, {})).toBe(baseKey);

        await (await cache.open(baseKey, en)).set('EN', 200, 'accept-language');

        // same accept-language → hit
        expect((await (await cache.open(baseKey, en)).get())?.data).toBe('EN');
        // different accept-language → miss (a separate learned-vary entry)
        expect(await (await cache.open(baseKey, de)).get()).toBeNull();
    });
});
