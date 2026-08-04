// stitchapi/llm — the contract-first llm preset (ADR 0008 Stage B). A capturing adapter (no
// network) proves each first-party provider maps the normalised request onto its wire body and
// lifts the normalised result back out; `llm` is plain HTTP (no execute hook), so it rides the
// ordinary engine path.
import type { Adapter, AdapterRequest } from '../src';
import { anthropic, llm, openai } from '../src/llm';
import type { LlmProvider } from '../src/llm';
import { seam } from '../src/seam';

function captureAdapter(response: unknown): {
    adapter: Adapter;
    calls: AdapterRequest[];
} {
    const calls: AdapterRequest[] = [];
    return {
        calls,
        adapter: async (req) => {
            calls.push(req);
            return { status: 200, headers: {}, body: response };
        },
    };
}

test('anthropic: builds the Messages API body (system out of messages) and parses the result', async () => {
    const { adapter, calls } = captureAdapter({
        content: [{ text: 'hello' }],
        model: 'claude-opus-4-8',
        usage: { input_tokens: 5, output_tokens: 2 },
        stop_reason: 'end_turn',
    });
    const chat = llm({
        provider: anthropic,
        model: 'claude-opus-4-8',
        tokens: 256,
        adapter,
    });

    const out = await chat({
        body: {
            system: 'be brief',
            messages: [{ role: 'user', content: 'hi' }],
        },
    });

    const body = calls[0]!.body as {
        model: string;
        max_tokens: number;
        system?: string;
        messages: unknown[];
    };
    expect(body.model).toBe('claude-opus-4-8');
    expect(body.max_tokens).toBe(256);
    expect(body.system).toBe('be brief'); // top-level param, NOT a message
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages'); // provider default url

    expect(out).toMatchObject({
        text: 'hello',
        model: 'claude-opus-4-8',
        usage: { inputTokens: 5, outputTokens: 2 },
        finishReason: 'end_turn',
    });
});

test('openai: builds the Chat Completions body (system prepended) and parses the result', async () => {
    const { adapter, calls } = captureAdapter({
        choices: [{ message: { content: 'hey' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    const chat = llm({ provider: openai, adapter }); // no model → provider default

    const out = await chat({
        body: {
            system: 'be brief',
            messages: [{ role: 'user', content: 'hi' }],
        },
    });

    const body = calls[0]!.body as { model: string; messages: unknown[] };
    expect(body.model).toBe('gpt-4o'); // provider.defaultModel
    expect(body.messages).toEqual([
        { role: 'system', content: 'be brief' }, // prepended as a message
        { role: 'user', content: 'hi' },
    ]);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');

    expect(out).toMatchObject({
        text: 'hey',
        usage: { inputTokens: 7, outputTokens: 3 },
        finishReason: 'stop',
    });
});

test('llm requires a model (none on config, call, or provider default) — fail closed', async () => {
    const { adapter } = captureAdapter({});
    const bare: LlmProvider = {
        id: 'bare',
        url: 'https://example.test/v1',
        buildBody: anthropic.buildBody,
        parse: anthropic.parse,
    };
    const chat = llm({ provider: bare, adapter });

    await expect(chat({ body: { messages: [] } })).rejects.toThrow(/model/);
});

test('anthropic folds a system-role MESSAGE into the top-level `system` (never dropped)', async () => {
    const { adapter, calls } = captureAdapter({ content: [{ text: 'ok' }] });
    const chat = llm({
        provider: anthropic,
        model: 'claude-opus-4-8',
        adapter,
    });

    await chat({
        body: {
            system: 'first',
            messages: [
                { role: 'system', content: 'second' },
                { role: 'user', content: 'hi' },
            ],
        },
    });

    const body = calls[0]!.body as {
        system?: string;
        messages: { role: string; content: string }[];
    };
    // The explicit `system` AND the system-role message both survive — concatenated into the
    // top-level param (Anthropic's shape), in order — rather than the message being silently lost.
    expect(body.system).toBe('first\n\nsecond');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
});

test('llm honours an explicit url over the provider default', async () => {
    const { adapter, calls } = captureAdapter({ content: [{ text: 'x' }] });
    const chat = llm({
        provider: anthropic,
        model: 'claude-opus-4-8',
        url: 'https://gateway.internal/llm',
        adapter,
    });

    await chat({ body: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(calls[0]!.url).toBe('https://gateway.internal/llm');
});

// The binder is implemented loose and `as`-cast to `LlmSeamApi['stitch']` (the `download.ts` idiom,
// needed once the member carries `NoUnknownKeys<C, …>`), so its declared type cannot vouch for the
// runtime wiring — the cast is exactly what the compiler stops checking. This pins that a bound
// member still resolves through the seam's baseUrl and reaches the provider mapping.
test('llm.bind(existingSeam).stitch(...) creates an llm member of that seam', async () => {
    const { adapter, calls } = captureAdapter({ content: [{ text: 'bound' }] });
    const api = seam({ baseUrl: 'https://gateway.internal', adapter });
    const chat = llm.bind(api).stitch({
        provider: anthropic,
        model: 'claude-opus-4-8',
        path: '/llm',
    });

    const { text } = await chat({
        body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(text).toBe('bound');
    expect(calls[0]!.url).toBe('https://gateway.internal/llm');
});

test('a per-call `tokens` override reaches the wire as the vendor `max_tokens` (openai)', async () => {
    // The house name is `tokens` (P4: a count cap is a bare plural noun); the vendor spelling
    // lives only in `buildBody`. This pins BOTH ends of that mapping on the openai path — the
    // anthropic one is covered above — and proves the call-level override still wins over the
    // surface default after the rename.
    const { adapter, calls } = captureAdapter({
        choices: [{ message: { content: 'ok' } }],
        model: 'gpt-4o',
    });
    const chat = llm({
        provider: openai,
        model: 'gpt-4o',
        tokens: 16,
        adapter,
    });

    await chat({
        body: { messages: [{ role: 'user', content: 'hi' }], tokens: 512 },
    });

    const body = calls[0]!.body as { max_tokens?: number };
    expect(body.max_tokens).toBe(512);
});

test('the old `maxTokens` spelling is gone (compile-time, P4)', () => {
    // @ts-expect-error — renamed to `tokens`; no alias (pre-GA hard break, D5)
    void llm({ provider: openai, model: 'gpt-4o', maxTokens: 16 });
    expect(true).toBe(true);
});

test('the surface owns method + wire.body (compile-time, ADR 0005 D1)', () => {
    // @ts-expect-error — `buildRequest` always POSTs; `method` is dead config
    void llm({ provider: openai, model: 'gpt-4o', method: 'PUT' });
    void llm({
        provider: openai,
        model: 'gpt-4o',
        // The directive sits against the property, not the call: the guard rejects the nested
        // `wire.body` slot, so that is the line TypeScript reports.
        // @ts-expect-error — the provider builds a JSON body; `wire.body` is dead config
        wire: { body: 'multipart' },
    });
    // The guard closes one member of the envelope, not the envelope: `wire.response` is untouched
    // by `buildRequest` and stays a live knob, so this must NOT be an error.
    void llm({ provider: openai, model: 'gpt-4o', wire: { response: 'text' } });
    expect(true).toBe(true);
});

// The guards above are compile-time only: a config rebuilt at runtime (a deserialised `__config`,
// plain JS) can still carry either field, so the override has to stay deterministic. The response
// decoding rides along as the control — `buildRequest` does NOT touch it, so it must survive
// untouched, which is why it is not guarded.
//
// The dead config is authored as `wire.body`; the assertions read the FLAT `bodyType` /
// `responseType`, because `AdapterRequest` keeps the transport spelling and the engine converts on
// the way down (CONTRACT.md P22).
test('forces POST + json over whatever a runtime config carries; the response decoding survives', async () => {
    const { adapter, calls } = captureAdapter({
        choices: [{ message: { content: 'hi' } }],
    });
    const rebuilt = {
        provider: openai,
        model: 'gpt-4o',
        adapter,
        method: 'PUT',
        wire: { body: 'form', response: 'text' },
    } as unknown as Parameters<typeof llm>[0];

    await llm(rebuilt)({
        body: { messages: [{ role: 'user', content: 'x' }] },
    });

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.bodyType).toBe('json');
    expect(calls[0]!.responseType).toBe('text');
});
