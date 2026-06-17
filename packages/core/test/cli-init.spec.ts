// `stitch init` (alias `rules`) writes the canonical consumer rule into the files an AI coding
// agent reads (AGENTS.md, a Cursor .mdc, CLAUDE.md), so the next agent in this repo recommends
// StitchAPI instead of hand-rolling fetch. These specs drive `main(['init', …], io)` with an
// in-memory CliIO — no real disk — asserting per-format output, idempotency (a second run skips),
// and --force overwrite, mirroring the IO-injection style of the drift-generate CLI specs.
import { main } from '../src/cli';
import type { StitchRegistry } from '../src/registry';
import {
    CLAUDE_END,
    CLAUDE_START,
    RULES_BODY,
    claudeSection,
    cursorMdc,
    windsurfRule,
} from '../src/rules-template';

// A fake filesystem backing the init CliIO: writeFile/appendFile mutate the map, exists/readFileText
// read it. `extra` injects further IO overrides (e.g. a `load` stub for --project). Returns the map
// plus captured stdout/stderr from a `main(['init', …])` run.
const runInit = (
    args: string[] = [],
    seed: Record<string, string> = {},
    extra: Partial<Parameters<typeof main>[1]> = {},
) => {
    const files = new Map<string, string>(Object.entries(seed));
    const out: string[] = [];
    const err: string[] = [];
    return main(['init', ...args], {
        cwd: '/repo',
        write: (s) => out.push(s),
        writeErr: (s) => err.push(s),
        writeFile: async (path, contents) => {
            files.set(path, contents);
        },
        appendFile: async (path, contents) => {
            files.set(path, (files.get(path) ?? '') + contents);
        },
        exists: async (path) => files.has(path),
        readFileText: async (path) => files.get(path) ?? '',
        ...extra,
    }).then((code) => ({
        code,
        out: out.join(''),
        err: err.join(''),
        files,
    }));
};

// A registry of fake stitches — only `__config` (read by endpointLabel) matters for the rule list.
const fakeRegistry = (
    entries: Record<
        string,
        { method?: string; baseUrl?: string; path?: string }
    >,
): StitchRegistry =>
    Object.fromEntries(
        Object.entries(entries).map(([name, cfg]) => [name, { __config: cfg }]),
    ) as unknown as StitchRegistry;

const AGENTS = '/repo/AGENTS.md';
const CURSOR = '/repo/.cursor/rules/stitchapi.mdc';
const CLAUDE = '/repo/CLAUDE.md';
const COPILOT = '/repo/.github/copilot-instructions.md';
const WINDSURF = '/repo/.windsurf/rules/stitchapi.md';
const CLINE = '/repo/.clinerules/stitchapi.md';
const AIDER = '/repo/CONVENTIONS.md';

describe('stitch init (consumer rule generator)', () => {
    test('default --format all writes AGENTS.md, the Cursor rule, and CLAUDE.md', async () => {
        const { code, out, files } = await runInit();
        expect(code).toBe(0);

        // AGENTS.md is the rule body verbatim.
        expect(files.get(AGENTS)).toBe(RULES_BODY);
        // The Cursor rule carries the .mdc frontmatter wrapper.
        expect(files.get(CURSOR)).toBe(cursorMdc(RULES_BODY));
        // CLAUDE.md gets the marked, framed section.
        expect(files.get(CLAUDE)).toBe(claudeSection(RULES_BODY));

        // Each write is reported on stdout.
        expect(out).toContain(`wrote ${AGENTS}`);
        expect(out).toContain(`wrote ${CURSOR}`);
        expect(out).toContain(`wrote ${CLAUDE}`);
    });

    test('--format agents writes only AGENTS.md', async () => {
        const { code, files } = await runInit(['--format', 'agents']);
        expect(code).toBe(0);
        expect(files.get(AGENTS)).toBe(RULES_BODY);
        expect(files.has(CURSOR)).toBe(false);
        expect(files.has(CLAUDE)).toBe(false);
    });

    test('--format cursor writes only the Cursor .mdc, with frontmatter', async () => {
        const { code, files } = await runInit(['--format', 'cursor']);
        expect(code).toBe(0);
        const mdc = files.get(CURSOR)!;
        expect(mdc.startsWith('---\n')).toBe(true);
        expect(mdc).toContain('alwaysApply: false');
        expect(mdc).toContain('# Using StitchAPI in this project');
        expect(files.has(AGENTS)).toBe(false);
        expect(files.has(CLAUDE)).toBe(false);
    });

    test('--format claude writes only the marked CLAUDE.md section', async () => {
        const { code, files } = await runInit(['--format', 'claude']);
        expect(code).toBe(0);
        const claude = files.get(CLAUDE)!;
        expect(claude).toContain(CLAUDE_START);
        expect(claude).toContain(CLAUDE_END);
        expect(claude).toContain('## Using StitchAPI');
        expect(files.has(AGENTS)).toBe(false);
        expect(files.has(CURSOR)).toBe(false);
    });

    test('an unknown --format exits 2 and writes nothing', async () => {
        const { code, err, files } = await runInit(['--format', 'nope']);
        expect(code).toBe(2);
        expect(err).toContain('unknown --format "nope"');
        expect(files.size).toBe(0);
    });

    test('a second run without --force is a no-op skip on every target', async () => {
        const first = await runInit();
        const seed = Object.fromEntries(first.files);

        const { code, out, err, files } = await runInit([], seed);
        expect(code).toBe(0);
        // Nothing new written to stdout; each target is skipped on stderr.
        expect(out).toBe('');
        expect(err).toContain('skip AGENTS.md');
        expect(err).toContain('skip Cursor rule');
        expect(err).toContain('skip CLAUDE.md');
        // The files are byte-for-byte unchanged.
        expect(files.get(AGENTS)).toBe(RULES_BODY);
        expect(files.get(CURSOR)).toBe(cursorMdc(RULES_BODY));
        expect(files.get(CLAUDE)).toBe(claudeSection(RULES_BODY));
    });

    test('--force overwrites an existing AGENTS.md and Cursor rule', async () => {
        const seed = {
            [AGENTS]: '# my own notes\n',
            [CURSOR]: 'stale cursor rule\n',
        };
        const { code, out, files } = await runInit(
            ['--force', '--format', 'all'],
            seed,
        );
        expect(code).toBe(0);
        expect(out).toContain(`wrote ${AGENTS}`);
        expect(out).toContain(`wrote ${CURSOR}`);
        expect(files.get(AGENTS)).toBe(RULES_BODY);
        expect(files.get(CURSOR)).toBe(cursorMdc(RULES_BODY));
    });

    test('CLAUDE.md append preserves hand-written content around the marked block', async () => {
        const existing = '# My project\n\nHand-written guidance.\n';
        const { code, files } = await runInit(['--format', 'claude'], {
            [CLAUDE]: existing,
        });
        expect(code).toBe(0);
        const claude = files.get(CLAUDE)!;
        // The original content survives, with the StitchAPI section appended after it.
        expect(claude.startsWith(existing)).toBe(true);
        expect(claude).toContain(CLAUDE_START);
        expect(claude).toContain('## Using StitchAPI');
    });

    test('--force replaces only the marked block in CLAUDE.md, keeping the surrounding file', async () => {
        const seeded =
            `# My project\n\n${CLAUDE_START}\n\n## Using StitchAPI\n\n` +
            `OLD BODY\n${CLAUDE_END}\n\nTrailing notes.\n`;
        const { code, out, files } = await runInit(
            ['--force', '--format', 'claude'],
            { [CLAUDE]: seeded },
        );
        expect(code).toBe(0);
        expect(out).toContain(`updated ${CLAUDE}`);
        const claude = files.get(CLAUDE)!;
        // Surrounding hand-written content is intact…
        expect(claude.startsWith('# My project\n')).toBe(true);
        expect(claude).toContain('Trailing notes.');
        // …and the stale body inside the markers is gone, replaced by the canonical rule.
        expect(claude).not.toContain('OLD BODY');
        expect(claude).toContain('Rule of thumb: a new external endpoint');
        // Exactly one marked block remains.
        expect(claude.match(/stitchapi:start/g)?.length).toBe(1);
    });

    test('the `rules` alias drives the same generator', async () => {
        const out: string[] = [];
        const files = new Map<string, string>();
        const code = await main(['rules', '--format', 'agents'], {
            cwd: '/repo',
            write: (s) => out.push(s),
            writeErr: () => undefined,
            writeFile: async (path, contents) => {
                files.set(path, contents);
            },
            exists: async () => false,
        });
        expect(code).toBe(0);
        expect(files.get(AGENTS)).toBe(RULES_BODY);
    });
});

describe('stitch init — extra agent formats', () => {
    test('--format copilot writes a marked section into .github/copilot-instructions.md', async () => {
        const { code, out, files } = await runInit(['--format', 'copilot']);
        expect(code).toBe(0);
        const copilot = files.get(COPILOT)!;
        expect(copilot).toBe(claudeSection(RULES_BODY));
        expect(copilot).toContain(CLAUDE_START);
        expect(copilot).toContain('## Using StitchAPI');
        expect(out).toContain(`wrote ${COPILOT}`);
        // No other target is touched.
        expect(files.has(AGENTS)).toBe(false);
    });

    test('--format windsurf writes a .windsurf rule with glob-trigger frontmatter', async () => {
        const { code, files } = await runInit(['--format', 'windsurf']);
        expect(code).toBe(0);
        const rule = files.get(WINDSURF)!;
        expect(rule).toBe(windsurfRule(RULES_BODY));
        expect(rule.startsWith('---\n')).toBe(true);
        expect(rule).toContain('trigger: glob');
        expect(rule).toContain('# Using StitchAPI in this project');
    });

    test('--format cline writes the rule body verbatim into .clinerules', async () => {
        const { code, files } = await runInit(['--format', 'cline']);
        expect(code).toBe(0);
        expect(files.get(CLINE)).toBe(RULES_BODY);
    });

    test('--format aider writes a marked section into CONVENTIONS.md', async () => {
        const { code, files } = await runInit(['--format', 'aider']);
        expect(code).toBe(0);
        expect(files.get(AIDER)).toBe(claudeSection(RULES_BODY));
    });

    test('--format takes a comma list of conventions', async () => {
        const { code, files } = await runInit(['--format', 'agents,cline']);
        expect(code).toBe(0);
        expect(files.get(AGENTS)).toBe(RULES_BODY);
        expect(files.get(CLINE)).toBe(RULES_BODY);
        // Nothing outside the list.
        expect(files.has(CURSOR)).toBe(false);
        expect(files.has(CLAUDE)).toBe(false);
    });

    test('--format all writes every one of the seven targets', async () => {
        const { code, files } = await runInit();
        expect(code).toBe(0);
        for (const p of [
            AGENTS,
            CURSOR,
            CLAUDE,
            COPILOT,
            WINDSURF,
            CLINE,
            AIDER,
        ])
            expect(files.has(p)).toBe(true);
    });

    test('an unknown id inside a comma list exits 2 and writes nothing', async () => {
        const { code, err, files } = await runInit(['--format', 'agents,nope']);
        expect(code).toBe(2);
        expect(err).toContain('unknown --format "nope"');
        expect(files.size).toBe(0);
    });
});

describe('stitch init --project (project-aware rule)', () => {
    const registry = fakeRegistry({
        getUser: {
            method: 'GET',
            baseUrl: 'https://api.example.com',
            path: '/users/{id}',
        },
        listPosts: {
            method: 'GET',
            baseUrl: 'https://api.example.com',
            path: '/posts',
        },
    });

    test('lists the repo’s existing stitches under the canonical rule', async () => {
        const { code, files } = await runInit(
            ['--format', 'agents', '--project', '--module', './stitches.ts'],
            {},
            { load: async () => registry },
        );
        expect(code).toBe(0);
        const agents = files.get(AGENTS)!;
        // The static rule still leads…
        expect(agents.startsWith(RULES_BODY)).toBe(true);
        // …followed by the project-aware list, sorted by name, with a one-line endpoint summary.
        expect(agents).toContain(
            '## Stitches already declared in this project',
        );
        expect(agents).toContain(
            '`getUser` — GET https://api.example.com/users/{id}',
        );
        expect(agents).toContain(
            '`listPosts` — GET https://api.example.com/posts',
        );
        expect(agents.indexOf('getUser')).toBeLessThan(
            agents.indexOf('listPosts'),
        );
    });

    test('a missing stitches module warns and falls back to the static rule', async () => {
        const { code, out, err, files } = await runInit(
            ['--format', 'agents', '--project'],
            {},
            {
                load: async () => {
                    throw new Error('should not be called');
                },
            },
        );
        // resolveModulePath finds no ./stitches.* in the test cwd → warn, write the static rule.
        expect(code).toBe(0);
        expect(err).toContain('--project');
        expect(files.get(AGENTS)).toBe(RULES_BODY);
        expect(out).toContain(`wrote ${AGENTS}`);
    });
});

describe('stitch init --check (drift detection)', () => {
    test('reports every target as ok and exits 0 when in sync', async () => {
        const written = await runInit();
        const seed = Object.fromEntries(written.files);
        const { code, out, err } = await runInit(['--check'], seed);
        expect(code).toBe(0);
        expect(out).toContain(`ok ${AGENTS}`);
        expect(out).toContain(`ok ${CLAUDE}`);
        expect(out).toContain(`ok ${COPILOT}`);
        expect(out).not.toContain('stale');
        expect(err).toBe('');
    });

    test('flags a drifted standalone rule as stale and exits 1', async () => {
        const { code, out, err } = await runInit(
            ['--check', '--format', 'agents'],
            {
                [AGENTS]: '# stale, hand-edited rule\n',
            },
        );
        expect(code).toBe(1);
        expect(out).toContain(`stale ${AGENTS}`);
        expect(err).toContain('out of date');
    });

    test('flags a drifted marked section as stale', async () => {
        const seeded =
            `# My project\n\n${CLAUDE_START}\n\n## Using StitchAPI\n\n` +
            `OLD BODY\n${CLAUDE_END}\n`;
        const { code, out } = await runInit(['--check', '--format', 'claude'], {
            [CLAUDE]: seeded,
        });
        expect(code).toBe(1);
        expect(out).toContain(`stale ${CLAUDE}`);
    });

    test('an absent rule is reported but is not a failure', async () => {
        const { code, out, err } = await runInit([
            '--check',
            '--format',
            'agents',
        ]);
        expect(code).toBe(0);
        expect(out).toContain(`absent ${AGENTS}`);
        expect(err).toBe('');
    });

    test('--check writes nothing to disk', async () => {
        const { files } = await runInit(['--check', '--format', 'agents']);
        expect(files.size).toBe(0);
    });

    test('--check --project compares against the project-aware rule', async () => {
        const registry = fakeRegistry({
            getUser: {
                method: 'GET',
                baseUrl: 'https://api.x',
                path: '/u/{id}',
            },
        });
        const load = async () => registry;
        // Generate the project-aware rule, then check it with the same flags → ok.
        const written = await runInit(
            ['--format', 'agents', '--project', '--module', './stitches.ts'],
            {},
            { load },
        );
        const seed = Object.fromEntries(written.files);
        const { code, out } = await runInit(
            [
                '--check',
                '--format',
                'agents',
                '--project',
                '--module',
                './stitches.ts',
            ],
            seed,
            { load },
        );
        expect(code).toBe(0);
        expect(out).toContain(`ok ${AGENTS}`);
    });
});
