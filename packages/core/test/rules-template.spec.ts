// Direct unit tests for projectStitchesSection (src/rules-template.ts) — the project-aware
// "what's already declared" block appended to the canonical rule by `stitch init --project`.
//
// cli-init.spec.ts exercises this only *through* the CLI, and only on the populated happy
// path (two stitches, pre-sorted by the CLI, checked via substring). Two contracts of the
// pure function itself go untested there:
//   1. the documented "empty in, empty out" branch (no stitches → no section);
//   2. the exact rendered shape — the leading blank line, the section heading, the reuse
//      instruction, and the `-   `name` — summary` list marker — plus the fact that the
//      function preserves the caller's order (the CLI sorts; the function must not).
import { RULES_BODY, projectStitchesSection } from '../src/rules-template';

describe('projectStitchesSection', () => {
    it('returns an empty string when there are no stitches', () => {
        expect(projectStitchesSection([])).toBe('');
    });

    it('renders the heading and the reuse instruction', () => {
        const out = projectStitchesSection([
            { name: 'getUser', summary: 'GET /users/{id}' },
        ]);
        expect(
            out.startsWith('\n## Stitches already declared in this project'),
        ).toBe(true);
        expect(out).toContain('Reuse these before declaring a new one');
    });

    it('renders each entry as a hanging-indent list item with name and summary', () => {
        const out = projectStitchesSection([
            { name: 'getUser', summary: 'GET /users/{id}' },
            { name: 'createPost', summary: 'POST /posts' },
        ]);
        expect(out).toContain('-   `getUser` — GET /users/{id}');
        expect(out).toContain('-   `createPost` — POST /posts');
    });

    it('preserves the caller-supplied order (does not sort)', () => {
        // 'createPost' would sort before 'getUser'; passing them reversed proves the
        // function leaves ordering to its caller (the CLI sorts before calling).
        const out = projectStitchesSection([
            { name: 'getUser', summary: 'GET /users/{id}' },
            { name: 'createPost', summary: 'POST /posts' },
        ]);
        expect(out.indexOf('getUser')).toBeLessThan(out.indexOf('createPost'));
    });
});

// `stitch init` writes RULES_BODY into users' AGENTS.md / CLAUDE.md / rule files, and
// `stitch init --check` pins it, so the shell commands it tells an agent to run are
// effectively frozen once adopters commit them. The npm name `stitch` is an unrelated
// package: a package runner given the bare name runs it whenever the project has no local
// `stitch` bin.
// The executable ships in the `stitchapi` package, so the rule must name the package
// (#861; the repo-wide guard is scripts/check-npx-bin.mjs).
describe('RULES_BODY shell invocations', () => {
    it('launch the bin through the stitchapi package', () => {
        expect(RULES_BODY).toContain('npx stitchapi run getUser --id 1');
        expect(RULES_BODY).toContain('npx stitchapi diagram');
        expect(RULES_BODY).toContain('npx stitchapi mcp');
    });

    it('never point a package runner at the bare `stitch` name', () => {
        expect(RULES_BODY).not.toMatch(
            /\b(?:npx|pnpm dlx|bunx|yarn dlx)\s+stitch(?!api)\b/,
        );
    });
});
