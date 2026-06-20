// Path/server-assembly branches of toOpenApi (src/openapi.ts) that openapi.spec.ts leaves open. That
// suite is thorough on params/bodies/auth/converters, but the multi-stitch assembly rules go untested:
//   - two stitches on the SAME path with DIFFERENT methods coexist under one path item;
//   - a duplicate (same path + same method) is skipped with a warning (first wins);
//   - distinct baseUrls produce multiple (sorted) servers plus an ambiguity warning;
//   - stitches sharing a baseUrl dedupe to ONE server with no warning.
import { stitch } from '../src';
import { toOpenApi } from '../src/openapi';
import type { StitchRegistry } from '../src/registry';

describe('toOpenApi path + server assembly', () => {
    test('same path, different methods coexist under one path item', () => {
        const reg: StitchRegistry = {
            listX: stitch({ baseUrl: 'https://api.test', path: '/x' }),
            createX: stitch({
                baseUrl: 'https://api.test',
                path: '/x',
                method: 'POST',
            }),
        };
        const { document, warnings } = toOpenApi(reg);
        const item = document.paths['/x'];
        expect(item?.['get']).toBeDefined();
        expect(item?.['post']).toBeDefined();
        expect(warnings).toEqual([]);
    });

    test('a duplicate path+method is skipped with a warning (first wins)', () => {
        const reg: StitchRegistry = {
            first: stitch({ baseUrl: 'https://api.test', path: '/x' }),
            second: stitch({ baseUrl: 'https://api.test', path: '/x' }),
        };
        const { document, warnings } = toOpenApi(reg);
        expect(document.paths['/x']?.['get']?.operationId).toBe('first');
        expect(
            warnings.some(
                (w) => w.includes('second') && w.includes('duplicate'),
            ),
        ).toBe(true);
    });

    test('distinct baseUrls → multiple sorted servers + an ambiguity warning', () => {
        const reg: StitchRegistry = {
            a: stitch({ baseUrl: 'https://b.test', path: '/x' }),
            b: stitch({ baseUrl: 'https://a.test', path: '/y' }),
        };
        const { document, warnings } = toOpenApi(reg);
        expect(document.servers).toEqual([
            { url: 'https://a.test' },
            { url: 'https://b.test' },
        ]); // sorted
        expect(warnings.some((w) => w.includes('distinct servers'))).toBe(true);
    });

    test('a shared baseUrl dedupes to one server with no warning', () => {
        const reg: StitchRegistry = {
            a: stitch({ baseUrl: 'https://api.test', path: '/x' }),
            b: stitch({ baseUrl: 'https://api.test', path: '/y' }),
        };
        const { document, warnings } = toOpenApi(reg);
        expect(document.servers).toEqual([{ url: 'https://api.test' }]);
        expect(warnings.some((w) => w.includes('distinct servers'))).toBe(
            false,
        );
    });
});
