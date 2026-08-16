// C9 — the best answer for the LLM case, run against every failure shape in this scenario, and
// compared honestly to the hand-rolled alternative.
//
// The two implementations are driven by the SAME fake provider through the SAME transport, and the
// comparison asserts their observable results are IDENTICAL on all five shapes. Then the line count
// is measured from the files themselves rather than claimed.
//
//   pnpm exec tsx docs/scenarios/proofs/mid-stream-failure/c9-assembled-solution.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Adapter } from '../../../../packages/core/src/types';
import { FakeStreamProvider } from './fake-llm-stream';
import { handRolledCompletion } from './hand-rolled';
import { check, checkSeq, finish, heading, note } from './harness';
import type { Completion } from './llm-stream';
import { completion, llmSurface } from './llm-stream';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = 'https://api.openai.example/v1/chat/completions';
const TOKENS = ['A', 'B', 'C', 'D', 'E'];
const HERE = dirname(fileURLToPath(import.meta.url));

/** The five shapes this scenario is about, each as a provider factory. */
const SHAPES = {
    complete: () => ({ tokens: TOKENS }),
    'connect 503 ×2': () => ({
        tokens: TOKENS,
        connect: { status: 503, healAfter: 2 },
    }),
    'drop after 3': () => ({
        tokens: TOKENS,
        cut: { after: 3, how: 'error' as const },
    }),
    'truncated (no [DONE])': () => ({
        tokens: TOKENS,
        cut: { after: 3, how: 'close' as const },
    }),
    'in-band error frame': () => ({ tokens: TOKENS, errorFrameAfter: 2 }),
    'connect 503 forever': () => ({
        tokens: TOKENS,
        connect: { status: 503, healAfter: 999 },
    }),
};

/**
 * Executable lines of a proof file — the comparable unit. Import statements (single- and
 * multi-line), blank lines and comment-only lines are all removed, on BOTH sides, so the number is
 * the code someone actually has to write and maintain.
 */
function executableLines(file: string): number {
    return readFileSync(join(HERE, file), 'utf8')
        .replace(/^import[\s\S]*?;$/gm, '') // whole import statements, however they wrap
        .split('\n')
        .map((l) => l.trim())
        .filter(
            (l) =>
                l !== '' &&
                !l.startsWith('//') &&
                !l.startsWith('*') &&
                !l.startsWith('/*'),
        ).length;
}

const summarize = (c: Completion): string =>
    `${c.text || '(nothing)'} | complete=${String(c.complete)} | deltas=${String(c.deltas)} | ${c.error ?? 'no error'}`;

async function main(): Promise<void> {
    heading(
        'C9 — the assembled answer, on every shape, against the hand-rolled twin',
    );

    const stitched: string[] = [];
    const rolled: string[] = [];
    const opensStitched: number[] = [];
    const opensRolled: number[] = [];

    for (const make of Object.values(SHAPES)) {
        // The StitchAPI answer.
        {
            const clock = manualClock();
            const api = new FakeStreamProvider({ clock, ...make() });
            const chat = stitch({
                url: URL,
                kind: llmSurface(api.adapter()),
                clock,
            });
            const p = completion(chat, {});
            await clock.advance(3_600_000);
            stitched.push(summarize(await p));
            opensStitched.push(api.opens.length);
        }
        // The hand-rolled twin, same transport, same fake.
        {
            const clock = manualClock();
            const api = new FakeStreamProvider({ clock, ...make() });
            const transport: Adapter = api.adapter();
            rolled.push(
                summarize(
                    await handRolledCompletion(transport, {
                        url: URL,
                        method: 'POST',
                        headers: {},
                    }),
                ),
            );
            opensRolled.push(api.opens.length);
        }
    }

    // ── (a) what the assembled answer produces on each shape ─────────────────────────────────
    for (const [i, name] of Object.keys(SHAPES).entries())
        note(`(a) ${name}`, stitched[i] ?? '');

    checkSeq(
        '(a) transport opens per shape',
        opensStitched,
        [1, 3, 1, 1, 1, 4],
    );
    check(
        '(a) the complete answer, delivered exactly once',
        stitched[0],
        'ABCDE | complete=true | deltas=6 | no error',
    );
    check(
        '(a) a healed connect: replayed at the connect phase only',
        stitched[1],
        'ABCDE | complete=true | deltas=6 | no error',
    );
    check(
        '(a) a mid-body drop: PARTIAL KEPT, failure named',
        stitched[2],
        'ABC | complete=false | deltas=3 | socket reset by peer',
    );
    check(
        '(a) a truncated stream: caught, partial kept',
        stitched[3],
        'ABC | complete=false | deltas=3 | stream truncated: no `[DONE]` sentinel',
    );
    check(
        '(a) an in-band error frame: a real failure, partial kept, bad frame withheld',
        stitched[4],
        'AB | complete=false | deltas=2 | provider error frame: upstream provider overloaded',
    );
    check(
        '(a) a dead server: fails after 4 connect attempts, no silent success',
        stitched[5],
        '(nothing) | complete=false | deltas=0 | HTTP 503',
    );

    // ── (b) the hand-rolled twin agrees, shape for shape ─────────────────────────────────────
    checkSeq('(b) hand-rolled results', rolled, stitched);
    checkSeq('(b) hand-rolled transport opens', opensRolled, opensStitched);
    note(
        '(b) → the wire behaviour is identical',
        'so the comparison is purely "what do the extra lines buy?"',
    );

    // ── (c) the line count, measured from the files ──────────────────────────────────────────
    {
        const mine = executableLines('llm-stream.ts');
        const theirs = executableLines('hand-rolled.ts');
        note(
            '(c) `llm-stream.ts` (the StitchAPI answer)',
            `${String(mine)} executable lines`,
        );
        note(
            '(c) `hand-rolled.ts` (no StitchAPI)',
            `${String(theirs)} executable lines`,
        );
        check('(c) is the StitchAPI version shorter?', mine < theirs, true);
        note(
            '(c) the parser is why',
            'a hand-rolled client brings its own `text/event-stream` parser; `sseSurface.stream` is reused here',
        );
    }

    // ── (d) what the extra machinery actually buys, measured ─────────────────────────────────
    // Not line count: the stitch is inside the engine, so it gets the spine. Measured on the
    // drop shape — the run emits a full event trace with a traceId, and `throttle`/`auth`/`headers`
    // /`timeout` are all still config rather than more hand-rolled code.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 3, how: 'error' },
        });
        const chat = stitch({
            name: 'chat',
            url: URL,
            kind: llmSurface(api.adapter()),
            clock,
        });
        const types: string[] = [];
        const ids = new Set<string>();
        const drain = (async () => {
            for await (const ev of chat.stream({})) {
                types.push(ev.type);
                const t = (ev as { traceId?: string }).traceId;
                if (t !== undefined) ids.add(t);
            }
        })();
        await clock.advance(3_600_000);
        await drain;
        checkSeq('(d) event spine of the assembled answer', types, [
            'start',
            'progress',
            'delta',
            'delta',
            'delta',
            'error',
            'done',
        ]);
        check('(d) one traceId across the run', ids.size, 1);
        note(
            '(d) → and none of `auth`/`headers`/`throttle`/`timeout`/`trace` cost a line here',
            'they are config on the same stitch; the hand-rolled twin would grow for each',
        );
    }

    // ── (e) the one-line hazard that used to un-do all of it, now pinned harmless ────────────
    // Adding `sse: { reconnect: true }` to the assembled stitch used to re-break it: the engine's
    // reconnect loop sits above every surface hook, and it replayed the completed stream 4×
    // (issue #640). Since #647 a completed body is never reopened and an id-less drop has nothing
    // to resume from, so the flag is inert here and the assembled answer survives it unchanged.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({ clock, tokens: TOKENS });
        const chat = stitch({
            url: URL,
            kind: llmSurface(api.adapter()),
            clock,
            sse: { reconnect: true },
        });
        const p = completion(chat, {});
        await clock.advance(3_600_000);
        const c = await p;
        check('(e) with `reconnect: true` → opens', api.opens.length, 1);
        check('(e) with `reconnect: true` → text', c.text, 'ABCDE');
        note(
            '(e) → the flag buys nothing on an id-less stream, and costs nothing',
            'before #647 this exact fixture measured 4 opens and `ABCDEABCDEABCDEABCDE`',
        );
    }

    finish(
        'C9',
        `ASSEMBLED AND RUN. ${String(executableLines('llm-stream.ts'))} executable lines of user code (\`llm-stream.ts\`) across TWO seams — \`Surface.execute\` for connect-only retry, and the surface's \`stream\` hook for the \`[DONE]\` requirement plus in-band error frames — with the consumer draining \`.stream()\` so the partial is never lost. Measured across all six shapes: a complete answer delivered ONCE (\`ABCDE\`, 6 deltas, 1 open); a healed connect replayed at the connect phase only (3 opens, \`ABCDE\` once); a mid-body drop keeping \`ABC\` with \`socket reset by peer\`; a truncation caught as \`stream truncated: no [DONE] sentinel\` with \`ABC\` kept; an in-band error frame as \`provider error frame: upstream provider overloaded\` with \`AB\` kept and the bad frame withheld; and a dead server failing after 4 connect attempts rather than resolving empty. The hand-rolled twin (${String(executableLines('hand-rolled.ts'))} executable lines, its own SSE parser included) produces byte-identical results on every shape and the same open counts — so the extra machinery is not buying behaviour, it is buying the spine: one \`start\`/\`delta\`×N/\`error\`/\`done\` trace under one traceId, and \`auth\`/\`headers\`/\`throttle\`/\`timeout\` staying config instead of growing the hand-rolled file. The caveat that used to be load-bearing is retired: adding \`sse: { reconnect: true }\` to this same stitch measured 1 open and \`ABCDE\` — since #647 a completed or id-less body is never reopened, so the flag no longer un-does the assembled answer; it is merely useless here`,
    );
}

void main();
