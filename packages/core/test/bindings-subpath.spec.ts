// `stitchapi/bindings` is the config-binding primitive (Secret + the call-time resolvers), split
// out of ./auth so a consumer can depend on a credential WITHOUT the auth strategies. Two things
// have to stay true, and neither is visible from a normal auth test:
//
//   1. the subpath is a runtime LEAF — importing it must not drag in the strategies (that is the
//      whole point of the split, and the reason @stitchapi/aws-sigv4 can stop hand-copying
//      `type Secret = string | (() => string)`);
//   2. the root re-export and the subpath are the SAME bindings, so `env()` from 'stitchapi' and
//      `env()` from 'stitchapi/bindings' are interchangeable and no drift can open up.
import * as root from '../src';
import * as bindings from '../src/bindings';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('stitchapi/bindings subpath', () => {
    test('exports the credential primitive + every call-time resolver', () => {
        expect(Object.keys(bindings).sort()).toEqual([
            'env',
            'isOptionalSecret',
            'optionalEnv',
            'resolveSecret',
            'secretFrom',
            'secretsFile',
        ]);
    });

    test('is the same binding the root re-exports (no drift between the two surfaces)', () => {
        expect(root.env).toBe(bindings.env);
        expect(root.optionalEnv).toBe(bindings.optionalEnv);
        expect(root.secretsFile).toBe(bindings.secretsFile);
        expect(root.secretFrom).toBe(bindings.secretFrom);
    });

    test('the root surface does NOT grow: consumer-only helpers stay subpath-only', () => {
        // `resolveSecret`/`isOptionalSecret` are for packages that CONSUME a Secret, not for
        // authoring config — keeping them off the root keeps the advertised surface unchanged.
        expect('resolveSecret' in root).toBe(false);
        expect('isOptionalSecret' in root).toBe(false);
    });

    test('stays a runtime leaf — it must not import the auth strategies', () => {
        const src = readFileSync(
            join(__dirname, '..', 'src', 'bindings.ts'),
            'utf8',
        );
        // A static `./auth` import here would re-fuse the two modules and silently undo the split.
        expect(src).not.toMatch(/from '\.\/auth'/);
        // Only `./util` is allowed — anything else is a new edge worth a deliberate review.
        const imports = [...src.matchAll(/from '(\.[^']*)'/g)].map((m) => m[1]);
        expect(imports).toEqual(['./util']);
    });

    test('resolveSecret reads both Secret forms; isOptionalSecret narrows on the brand', () => {
        expect(bindings.resolveSecret('literal')).toBe('literal');
        expect(bindings.resolveSecret(() => 'thunk')).toBe('thunk');

        expect(bindings.isOptionalSecret(bindings.optionalEnv('NOPE'))).toBe(
            true,
        );
        expect(bindings.isOptionalSecret(() => 'plain')).toBe(false);
        expect(bindings.isOptionalSecret('literal')).toBe(false);
    });
});
