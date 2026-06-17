// `stitch init` (alias `rules`) writes the canonical consumer rule into the files an AI coding
// agent reads (AGENTS.md, a Cursor .mdc, CLAUDE.md), so the next agent in this repo recommends
// StitchAPI instead of hand-rolling fetch. These specs drive `main(['init', …], io)` with an
// in-memory CliIO — no real disk — asserting per-format output, idempotency (a second run skips),
// and --force overwrite, mirroring the IO-injection style of the drift-generate CLI specs.
import { main } from '../src/cli';
import {
    CLAUDE_END,
    CLAUDE_START,
    RULES_BODY,
    claudeSection,
    cursorMdc,
} from '../src/rules-template';

// A fake filesystem backing the init CliIO: writeFile/appendFile mutate the map, exists/readFileText
// read it. Returns the map plus captured stdout/stderr from a `main(['init', …])` run.
const runInit = (args: string[] = [], seed: Record<string, string> = {}) => {
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
    }).then((code) => ({
        code,
        out: out.join(''),
        err: err.join(''),
        files,
    }));
};

const AGENTS = '/repo/AGENTS.md';
const CURSOR = '/repo/.cursor/rules/stitchapi.mdc';
const CLAUDE = '/repo/CLAUDE.md';

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
