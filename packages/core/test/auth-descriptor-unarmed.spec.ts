// ADR 0020 edge case. The strategy factories are kept OUT of the lean `import { stitch }` bundle by
// arming the descriptor resolver only when a secret resolver (`env`/`secretsFile`/`secretFrom`) runs
// — which a real descriptor's credential (`token: env('…')`) always does. A descriptor that resolves
// NO secret through them (a literal-string secret) AND whose module imports no other auth symbol can
// therefore reach `stitch()` with the resolver unarmed; it MUST fail loudly at construction with an
// actionable fix, never silently.
//
// This lives in its own file so vitest's per-file module isolation guarantees an UNARMED resolver:
// nothing here (and no earlier test in this registry) has called a secret resolver.
import { stitch } from '../src';

test('a literal-secret descriptor with no auth import throws a helpful construction error', () => {
    expect(() =>
        stitch({
            url: 'https://api.example.com/me',
            auth: { strategy: 'bearer', token: 'sk-literal' },
        }),
    ).toThrow(/declarative .auth. needs the resolver loaded/i);
});
