// Pins docs/GAP-AUDIT.md §2.12: CLI: unparseable --since must exit 2 with a stderr message, not silently filter everything out with exit 0
import { main } from '../../src/cli';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the trace sink quiet for this suite.
process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-cli-since-${process.pid}.jsonl`,
);

/**
 * Build a tiny JSONL trace file with one record so traceCommand doesn't bail
 * with "no trace file" (exit 1) before it even gets to parse --since.
 */
function makeTraceFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stitch-trace-'));
    const file = join(dir, 'trace.jsonl');
    // One minimal done-event record.
    writeFileSync(
        file,
        JSON.stringify({
            name: 'test',
            type: 'done',
            ok: true,
            elapsed: 5,
            at: Date.now(),
        }) + '\n',
    );
    return file;
}

describe('CLI trace --since with unparseable value', () => {
    let stdoutLines: string[];
    let stderrLines: string[];
    let traceFile: string;

    beforeEach(() => {
        stdoutLines = [];
        stderrLines = [];
        traceFile = makeTraceFile();
    });

    /**
     * CONTRACT: `stitch trace --since not-a-date` must:
     *   1. exit with code 2  (not 0)
     *   2. write a message to stderr that mentions "--since"
     *
     * Guards the fix: parseDuration('not-a-date') returns undefined and the
     * command reports bad usage instead of silently filtering everything out.
     */
    test('exits 2 and writes a --since error to stderr for unparseable input', async () => {
        const exitCode = await main(
            ['trace', '--file', traceFile, '--since', 'not-a-date'],
            {
                write: (s) => stdoutLines.push(s),
                writeErr: (s) => stderrLines.push(s),
                now: () => Date.now(),
                env: { STITCH_TRACE_FILE: traceFile },
                cwd: tmpdir(),
                load: async () => ({}),
            },
        );

        // The fix must write something about --since to stderr.
        const stderrOutput = stderrLines.join('');
        expect(stderrOutput).toMatch(/--since/);

        // The fix must exit with code 2 (bad usage), not 0 (success).
        expect(exitCode).toBe(2);
    });
});
