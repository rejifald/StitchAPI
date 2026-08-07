// A truncated completion is no longer a silent success (issue #699). The provider mappings have
// always lifted `finishReason` — anthropic's `stop_reason`, openai's `finish_reason` — and nothing
// read it, so a completion the token cap cut off resolved `ok: true` with an empty `findings` array,
// identical on every observer to a model that finished on its own terms. These pin the two halves of
// the fix: the normalised `truncated` flag on the result, and the `warn` drift finding that carries
// it into `.inspect()` / the drift event / the trace.
//
// Style follows llm.spec.ts — a capturing adapter, no network. `trace: false` keeps the findings
// assertions from writing a trace file.
import { anthropic, llm, makeLlmSurface, openai } from '../src/llm';
import type { LlmProvider, LlmResult } from '../src/llm';
import { stitch } from '../src/stitch';
import type { Adapter, AdapterResponse } from '../src/types';

const respond =
    (body: unknown): Adapter =>
    async () => ({ status: 200, headers: {}, body });

const ASK = { body: { messages: [{ role: 'user' as const, content: 'hi' }] } };

// The two vendor bodies, each carrying the finish reason that means "the cap stopped it".
const anthropicBody = (stop_reason: string) => ({
    content: [{ text: 'the first half of an ans' }],
    model: 'claude-opus-4-8',
    usage: { input_tokens: 5, output_tokens: 256 },
    stop_reason,
});
const openaiBody = (finish_reason: string) => ({
    choices: [
        { message: { content: 'the first half of an ans' }, finish_reason },
    ],
    model: 'gpt-4o',
    usage: { prompt_tokens: 5, completion_tokens: 256 },
});

describe('a completion cut off at the token cap is reported', () => {
    test('anthropic `stop_reason: max_tokens` → truncated, with a warn finding', async () => {
        const chat = llm({
            provider: anthropic,
            model: 'claude-opus-4-8',
            adapter: respond(anthropicBody('max_tokens')),
            trace: false,
        });

        // 1. On the RESULT — the normalised flag, so a caller never has to know that anthropic
        //    spells the cap `max_tokens` and openai spells it `length`.
        const out = await chat(ASK);
        expect(out.truncated).toBe(true);
        expect(out.finishReason).toBe('max_tokens'); // the vendor string survives alongside it
        expect(out.text).toBe('the first half of an ans'); // the partial answer is still served

        // 2. As a FINDING — the diagnostic channel, so it reaches `.inspect()`, the `drift` event
        //    and the trace with no extra wiring.
        const r = await chat.inspect(ASK);
        const finding = r.findings.find((f) => f.path === 'finishReason');
        expect(finding).toBeDefined();
        expect(finding!.level).toBe('warn');
        expect(finding!.detail).toMatch(/token cap/);
        // Diagnostic, never control flow: the call still succeeded.
        expect(r.error).toBeNull();
    });

    test('openai `finish_reason: length` → truncated, with a warn finding', async () => {
        const chat = llm({
            provider: openai,
            model: 'gpt-4o',
            adapter: respond(openaiBody('length')),
            trace: false,
        });

        const out = await chat(ASK);
        expect(out.truncated).toBe(true);
        expect(out.finishReason).toBe('length');

        const r = await chat.inspect(ASK);
        expect(
            r.findings.some(
                (f) => f.path === 'finishReason' && f.level === 'warn',
            ),
        ).toBe(true);
        expect(r.error).toBeNull();
    });

    // The point of the whole change: it is REPORTED, not thrown. Making it fatal is a caller-side
    // policy (see the wrapper test below), deliberately not this surface's default — flipping it
    // would be a semver-major behaviour change.
    test('truncation does NOT fail the call', async () => {
        const chat = llm({
            provider: anthropic,
            model: 'claude-opus-4-8',
            adapter: respond(anthropicBody('max_tokens')),
            trace: false,
        });
        await expect(chat(ASK)).resolves.toMatchObject({ truncated: true });
    });
});

describe('a completion that finished on its own terms reports nothing', () => {
    test('anthropic `end_turn` → truncated false, no finding', async () => {
        const chat = llm({
            provider: anthropic,
            model: 'claude-opus-4-8',
            adapter: respond(anthropicBody('end_turn')),
            trace: false,
        });

        const out = await chat(ASK);
        expect(out.truncated).toBe(false);

        const r = await chat.inspect(ASK);
        expect(r.findings).toEqual([]);
        expect(r.error).toBeNull();
    });

    test('openai `stop` → truncated false, no finding', async () => {
        const chat = llm({
            provider: openai,
            model: 'gpt-4o',
            adapter: respond(openaiBody('stop')),
            trace: false,
        });

        expect((await chat(ASK)).truncated).toBe(false);
        expect((await chat.inspect(ASK)).findings).toEqual([]);
    });

    // Three-state, and this is the third: a provider that lifted NO finish reason gave no grounds
    // for either answer, so `truncated` is absent rather than a confident `false` — which would be
    // the same "silence read as success" this change exists to remove, one level up.
    test('no finishReason at all → `truncated` is absent (unknown), not false', async () => {
        const chat = llm({
            provider: anthropic,
            model: 'claude-opus-4-8',
            adapter: respond({ content: [{ text: 'ok' }] }), // no stop_reason
            trace: false,
        });

        const out = await chat(ASK);
        expect(out.finishReason).toBeUndefined();
        expect('truncated' in out).toBe(false);
        expect((await chat.inspect(ASK)).findings).toEqual([]);
    });
});

describe('the provider is the extension seam (CONTRACT.md P21)', () => {
    // A BYO provider whose stop vocabulary is neither vendor's decides for itself in `parse`, and
    // the surface defers rather than overwriting it with a guess from an unfamiliar string.
    const byo = (parse: LlmProvider['parse']): LlmProvider => ({
        id: 'byo',
        url: 'https://byo.test/v1/complete',
        defaultModel: 'byo-1',
        buildBody: openai.buildBody,
        parse,
    });

    test("a provider's own `truncated: true` wins over an unrecognised finishReason", async () => {
        const chat = llm({
            provider: byo((body): LlmResult => ({
                text: 'cut',
                finishReason: 'BUDGET_EXHAUSTED', // in neither shipped vocabulary
                truncated: true, // ...so the provider says so itself
                raw: body,
            })),
            adapter: respond({}),
            trace: false,
        });

        const out = await chat(ASK);
        expect(out.truncated).toBe(true);
        expect(
            (await chat.inspect(ASK)).findings.some(
                (f) => f.path === 'finishReason',
            ),
        ).toBe(true);
    });

    test("a provider's own `truncated: false` wins over a cap-looking finishReason", async () => {
        const chat = llm({
            provider: byo((body): LlmResult => ({
                text: 'done',
                finishReason: 'length', // looks like openai's cap...
                truncated: false, // ...but on THIS API it means something else
                raw: body,
            })),
            adapter: respond({}),
            trace: false,
        });

        expect((await chat(ASK)).truncated).toBe(false);
        expect((await chat.inspect(ASK)).findings).toEqual([]);
    });

    // A BYO provider that only lifts a finishReason still gets the signal free, as long as it
    // passes one of the two shipped spellings through. Case is not load-bearing (Gemini-family
    // APIs shout `MAX_TOKENS`).
    test('a BYO provider gets truncation free from a shipped spelling, case-insensitively', async () => {
        const chat = llm({
            provider: byo((body): LlmResult => ({
                text: 'cut',
                finishReason: 'MAX_TOKENS',
                raw: body,
            })),
            adapter: respond({}),
            trace: false,
        });

        expect((await chat(ASK)).truncated).toBe(true);
    });
});

// `makeLlmSurface` was the unblocker (issue #699 §3): the exported `llmSurface` is a bare
// `{ id: 'llm' }` identity with nothing to wrap, and the real factory — which closes over the
// provider and defaults — had no `export`, so a caller could not implement any of this themselves.
// This pins that it is importable, that it builds a working surface, and that wrapping it is
// ordinary code: the "make truncation fatal" policy this surface deliberately does NOT adopt is a
// few lines on the caller's side.
describe('makeLlmSurface is exported and wrappable', () => {
    test('is importable and builds a live surface with the llm identity', () => {
        expect(typeof makeLlmSurface).toBe('function');
        const surface = makeLlmSurface({
            provider: anthropic,
            model: 'claude-opus-4-8',
        });
        expect(surface.id).toBe('llm');
        expect(typeof surface.buildRequest).toBe('function');
        expect(typeof surface.interpret).toBe('function');
    });

    test('drives a stitch through the generic `kind` slot', async () => {
        const surface = makeLlmSurface({
            provider: anthropic,
            model: 'claude-opus-4-8',
        });
        const chat = stitch<LlmResult>({
            kind: surface,
            url: anthropic.url,
            adapter: respond(anthropicBody('end_turn')),
            trace: false,
        });

        const out = await chat(ASK);
        expect(out.text).toBe('the first half of an ans');
        expect(out.truncated).toBe(false);
    });

    test('a wrapper can make truncation FATAL — the opt-in this PR leaves to the caller', async () => {
        const base = makeLlmSurface({
            provider: anthropic,
            model: 'claude-opus-4-8',
        });
        const strict = {
            ...base,
            interpret: (
                res: AdapterResponse,
                cfg: Parameters<NonNullable<typeof base.interpret>>[1],
            ) => {
                const out = base.interpret!(res, cfg);
                return out.ok && out.data.truncated
                    ? {
                          ok: false as const,
                          message: 'llm: truncated at the token cap',
                      }
                    : out;
            },
        };
        const chat = stitch<LlmResult>({
            kind: strict,
            url: anthropic.url,
            adapter: respond(anthropicBody('max_tokens')),
            trace: false,
        });

        await expect(chat(ASK)).rejects.toThrow(/truncated/);
    });
});
