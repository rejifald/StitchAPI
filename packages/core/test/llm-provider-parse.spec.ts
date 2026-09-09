// Provider parse/buildBody edge branches (src/llm.ts), called directly. llm.spec.ts drives the
// happy path (full bodies, explicit max_tokens). These pin the branches it leaves open:
//   parse     — empty/missing content|choices → text ''; multiple content blocks joined; a content
//               block with no text contributes nothing; absent usage/model/finishReason are omitted;
//               a PARTIAL usage maps only the present token field.
//   buildBody — anthropic defaults max_tokens to 1024 when unset (no temperature/system added);
//               openai omits max_tokens when unset and includes temperature when set.
import { anthropic, openai } from '../src/llm';
import type { LlmRequest } from '../src/llm';

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    ...over,
});

describe('anthropic.parse', () => {
    test('joins content blocks, skipping ones with no text', () => {
        const r = anthropic.parse({
            content: [{ text: 'a' }, {}, { text: 'b' }],
        });
        expect(r.text).toBe('ab');
        expect(r.model).toBeUndefined();
        expect(r.usage).toBeUndefined();
        expect(r.finishReason).toBeUndefined();
    });

    test('empty/missing content yields an empty string', () => {
        expect(anthropic.parse({}).text).toBe('');
    });

    test('maps a partial usage (only the present token field)', () => {
        const r = anthropic.parse({
            content: [{ text: 'x' }],
            usage: { input_tokens: 3 },
        });
        expect(r.usage).toEqual({ input: 3 });
    });
});

describe('openai.parse', () => {
    test('no choices yields an empty string and omits model/usage/finishReason', () => {
        const r = openai.parse({});
        expect(r.text).toBe('');
        expect(r.model).toBeUndefined();
        expect(r.usage).toBeUndefined();
        expect(r.finishReason).toBeUndefined();
    });

    test('maps a partial usage (only completion_tokens)', () => {
        const r = openai.parse({
            choices: [{ message: { content: 'x' } }],
            usage: { completion_tokens: 4 },
        });
        expect(r.text).toBe('x');
        expect(r.usage).toEqual({ output: 4 });
    });
});

describe('buildBody defaults', () => {
    test('anthropic defaults max_tokens to 1024 and omits temperature/system', () => {
        const body = anthropic.buildBody(req()) as {
            max_tokens?: number;
            temperature?: unknown;
            system?: unknown;
        };
        expect(body.max_tokens).toBe(1024);
        expect(body.temperature).toBeUndefined();
        expect(body.system).toBeUndefined();
    });

    test('openai omits max_tokens when unset and includes temperature when set', () => {
        const body = openai.buildBody(req({ temperature: 0.3 })) as {
            max_tokens?: number;
            temperature?: number;
            messages: { role: string }[];
        };
        expect('max_tokens' in body).toBe(false);
        expect(body.temperature).toBe(0.3);
        // no system → no system message prepended.
        expect(body.messages.every((m) => m.role !== 'system')).toBe(true);
    });
});
