// The `stitchapi/llm` surface subpath (ADR 0008): a preset over the **http** surface for LLM chat
// completions. Contract-first — an {@link LlmProvider} maps a normalised request to a provider's
// HTTP body and lifts a normalised {@link LlmResult} back out — with first-party Anthropic + OpenAI
// mappings shipped as PLAIN CONFIG (no SDK dependency, the contract-not-dependency gate). BYO any
// other provider by implementing the contract.
//
// `llm` carries NO `execute` hook: an LLM call IS http, so bearer/apiKey `auth`, `retry`, and
// `throttle` all apply for free, and `llm` proves the surface model from the buffered-HTTP side.
// (Token streaming is a follow-up: it needs a `stream` hook ON this surface, since `kind` is a
// single slot the buffered llm surface already fills — the `sse`/`stream` surfaces don't compose
// onto it yet.) Bundle-frugal: reached only through the `llm` subpath; `import { stitch }` pulls in
// none of it.
import { makeStitch } from './stitch';
import type { Surface, SurfaceOutcome } from './surface';
import type { Stitch, StitchConfig, StitchInput } from './types';

/** A chat message in the normalised request. */
export interface LlmMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

/** The normalised LLM request a provider maps to its wire body. */
export interface LlmRequest {
    model: string;
    messages: LlmMessage[];
    system?: string;
    maxTokens?: number;
    temperature?: number;
}

/** The normalised result a provider lifts out of its response. `raw` keeps the provider's full body. */
export interface LlmResult {
    text: string;
    model?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    finishReason?: string;
    raw: unknown;
}

/**
 * The provider-mapping CONTRACT (ADR 0008) — the contract-not-dependency primitive for LLMs, the
 * same shape the fingerprint contract and `axiosAdapter` follow. A provider declares its endpoint +
 * non-secret headers, maps a {@link LlmRequest} to its HTTP body, and lifts an {@link LlmResult} out
 * of the response. First-party {@link anthropic} / {@link openai} implement it; BYO any other by
 * writing one. The CREDENTIAL is the stitch's `auth` (`bearer`/`apiKey`), never the provider.
 */
export interface LlmProvider {
    id: string;
    /** Completions endpoint — the default `url` when the config sets none. */
    endpoint: string;
    /** Non-secret default headers (e.g. an API version), merged UNDER the request headers. Never a credential. */
    headers?: Record<string, string>;
    /** Model used when neither the config nor the call sets one. */
    defaultModel?: string;
    /** Map the normalised request to the provider's HTTP request body. */
    buildBody: (req: LlmRequest) => unknown;
    /** Lift the normalised result out of the provider's response body. */
    parse: (body: unknown) => LlmResult;
}

/** Per-stitch llm defaults baked into the surface (the call may override via `body`). */
interface LlmDefaults {
    provider: LlmProvider;
    model?: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
}

// Assemble the normalised request: the call's `body` (`{ messages, ...overrides }`) wins over the
// llm config defaults, which win over the provider's `defaultModel`.
function toRequest(d: LlmDefaults, input: StitchInput): LlmRequest {
    const over = (input.body ?? {}) as Partial<LlmRequest>;
    const model = over.model ?? d.model ?? d.provider.defaultModel;
    if (model === undefined || model === '') {
        const e = new Error(
            'llm: a `model` is required — set it on `llm({ model })`, in the call `body`, or via the provider default.',
        );
        e.name = 'StitchConfigError';
        throw e;
    }
    const req: LlmRequest = { model, messages: over.messages ?? [] };
    const system = over.system ?? d.system;
    if (system !== undefined) req.system = system;
    const maxTokens = over.maxTokens ?? d.maxTokens;
    if (maxTokens !== undefined) req.maxTokens = maxTokens;
    const temperature = over.temperature ?? d.temperature;
    if (temperature !== undefined) req.temperature = temperature;
    return req;
}

// The llm surface for one provider + defaults: pack the request via `provider.buildBody` as a JSON
// POST (provider headers under the user's), and `interpret` lifts the result via `provider.parse`.
function llmSurface(d: LlmDefaults): Surface<StitchInput, LlmResult> {
    const { provider } = d;
    return {
        id: 'llm',
        buildRequest: (_cfg, input, base) => ({
            ...base,
            method: 'POST',
            bodyType: 'json',
            body: provider.buildBody(toRequest(d, input)),
            headers: { ...(provider.headers ?? {}), ...base.headers },
        }),
        // The engine has already thrown on a non-2xx (unless `acceptStatus`), so `parse` sees a
        // successful body. A provider's "200 with an error envelope" can be handled in its `parse`.
        interpret: (res): SurfaceOutcome<LlmResult> => ({
            ok: true,
            value: provider.parse(res.body),
        }),
    };
}

/** Config for {@link llm}: the shared {@link StitchConfig} keys plus the llm defaults. */
export type LlmConfig = Partial<StitchConfig> & {
    provider: LlmProvider;
    model?: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
};

/**
 * `llm({ provider, ... })` — a chat-completion stitch resolving to an {@link LlmResult}. The
 * provider (and `model`/`system`/`maxTokens`/`temperature` defaults) bind to the surface; the call
 * passes `{ body: { messages: [...] } }` (and may override the defaults). The endpoint defaults to
 * the provider's. Bring the credential as the stitch's `auth` (`bearer(env(...))` for OpenAI,
 * `apiKey({ name: 'x-api-key', ... })` for Anthropic).
 *
 * @example
 * ```ts
 * import { llm, anthropic } from 'stitchapi/llm';
 * import { apiKey, env } from 'stitchapi';
 *
 * const chat = llm({
 *     provider: anthropic,
 *     model: 'claude-opus-4-8',
 *     auth: apiKey({ name: 'x-api-key', value: env('ANTHROPIC_API_KEY') }),
 * });
 * const { text } = await chat({ body: { messages: [{ role: 'user', content: 'hi' }] } });
 * ```
 */
export function llm(config: LlmConfig): Stitch<LlmResult> {
    const { provider, model, system, maxTokens, temperature, ...rest } = config;
    const defaults: LlmDefaults = { provider };
    if (model !== undefined) defaults.model = model;
    if (system !== undefined) defaults.system = system;
    if (maxTokens !== undefined) defaults.maxTokens = maxTokens;
    if (temperature !== undefined) defaults.temperature = temperature;
    const endpointless = rest.url === undefined && rest.path === undefined;
    return makeStitch<LlmResult>({
        ...rest,
        kind: llmSurface(defaults),
        ...(endpointless ? { url: provider.endpoint } : {}),
    });
}

// ---- first-party provider mappings (plain config — no SDK dependency) ------

/**
 * Anthropic Messages API (`/v1/messages`). System prompts ride the top-level `system` param (not a
 * message), `max_tokens` is required (default 1024). Auth is the user's `apiKey({ name: 'x-api-key',
 * … })`; this only sets the non-secret `anthropic-version`. Defaults to the current `claude-opus-4-8`.
 */
export const anthropic: LlmProvider = {
    id: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    headers: { 'anthropic-version': '2023-06-01' },
    defaultModel: 'claude-opus-4-8',
    buildBody: (req) => {
        // Anthropic's `system` is a TOP-LEVEL param, not a message. Fold any system-role
        // messages into it (after an explicit `req.system`) so a system prompt passed as a
        // message — the natural shape for callers coming from the chat SDKs — is relocated to
        // where the API wants it rather than silently dropped.
        const system = [
            ...(req.system !== undefined ? [req.system] : []),
            ...req.messages
                .filter((m) => m.role === 'system')
                .map((m) => m.content),
        ].join('\n\n');
        return {
            model: req.model,
            max_tokens: req.maxTokens ?? 1024,
            messages: req.messages
                .filter((m) => m.role !== 'system')
                .map((m) => ({ role: m.role, content: m.content })),
            ...(system !== '' ? { system } : {}),
            ...(req.temperature !== undefined
                ? { temperature: req.temperature }
                : {}),
        };
    },
    parse: (body) => {
        const b = body as {
            content?: { text?: string }[];
            model?: string;
            usage?: { input_tokens?: number; output_tokens?: number };
            stop_reason?: string;
        };
        const result: LlmResult = {
            text: (b.content ?? []).map((c) => c.text ?? '').join(''),
            raw: body,
        };
        if (b.model !== undefined) result.model = b.model;
        if (b.usage)
            result.usage = {
                ...(b.usage.input_tokens !== undefined
                    ? { inputTokens: b.usage.input_tokens }
                    : {}),
                ...(b.usage.output_tokens !== undefined
                    ? { outputTokens: b.usage.output_tokens }
                    : {}),
            };
        if (b.stop_reason) result.finishReason = b.stop_reason;
        return result;
    },
};

/**
 * OpenAI Chat Completions (`/v1/chat/completions`). A system prompt is prepended as a `system`
 * message. Auth is the user's `bearer(env('OPENAI_API_KEY'))`. Defaults to `gpt-4o`.
 */
export const openai: LlmProvider = {
    id: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
    buildBody: (req) => ({
        model: req.model,
        messages: [
            ...(req.system !== undefined
                ? [{ role: 'system', content: req.system }]
                : []),
            ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined
            ? { temperature: req.temperature }
            : {}),
    }),
    parse: (body) => {
        const b = body as {
            choices?: {
                message?: { content?: string };
                finish_reason?: string;
            }[];
            model?: string;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const result: LlmResult = {
            text: b.choices?.[0]?.message?.content ?? '',
            raw: body,
        };
        if (b.model !== undefined) result.model = b.model;
        if (b.usage)
            result.usage = {
                ...(b.usage.prompt_tokens !== undefined
                    ? { inputTokens: b.usage.prompt_tokens }
                    : {}),
                ...(b.usage.completion_tokens !== undefined
                    ? { outputTokens: b.usage.completion_tokens }
                    : {}),
            };
        const fr = b.choices?.[0]?.finish_reason;
        if (fr) result.finishReason = fr;
        return result;
    },
};
