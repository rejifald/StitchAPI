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
import { compact } from './compact';
import type { InputOf } from './infer';
import { seam as makeSeam } from './seam';
import { makeStitch } from './stitch';
import { verdictOf } from './surface';
import type { Surface, SurfaceOutcome } from './surface';
import {
    type DriftFinding,
    type NoRequestShapeOnLlm,
    type NoUnknownKeys,
    type NoUnknownNestedKeys,
    type Seam,
    type SeamOptions,
    type Stitch,
    type StitchConfig,
    type StitchInput,
    isSeam,
} from './types';

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
    /** Cap on tokens generated. A **count**, so it is a bare plural noun — CONTRACT.md P4 bans
     *  the `max` prefix there, and leaves `max` only for a magnitude ceiling. This is the HOUSE
     *  shape, so it uses house vocabulary; each provider's `buildBody` emits the vendor's own
     *  `max_tokens` (P18/P22 keep the upstream spelling at the wire, not here). */
    tokens?: number;
    temperature?: number;
}

/** The normalised result a provider lifts out of its response. `raw` keeps the provider's full body. */
export interface LlmResult {
    text: string;
    model?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    /** Why the provider stopped generating, in the PROVIDER's own vocabulary — anthropic's
     *  `stop_reason` (`end_turn`, `max_tokens`, …), openai's `finish_reason` (`stop`, `length`, …).
     *  The field name is normalised; the VALUE is not, because there is no cross-vendor standard to
     *  normalise it to. {@link LlmResult.truncated} is the one question worth answering portably. */
    finishReason?: string;
    /**
     * Did the completion stop because it hit the token cap — i.e. is `text` a PARTIAL answer?
     *
     * The surface derives this from {@link LlmResult.finishReason} so a caller never has to know
     * that anthropic spells it `max_tokens` and openai spells it `length`. Three-state on purpose:
     * `true` truncated, `false` finished on its own terms, and **absent** = unknown, because a
     * provider that lifted no `finishReason` gave no grounds for either answer. A confident `false`
     * over silence would be the same failure this field exists to fix, one level up.
     *
     * A BYO provider whose stop vocabulary is neither vendor's may set this in its own `parse`; the
     * surface defers to that rather than guessing (CONTRACT.md P21 — the seam is the provider).
     */
    truncated?: boolean;
    raw: unknown;
}

// The finish reasons that mean THE CAP STOPPED IT, across the two first-party mappings: anthropic's
// `stop_reason: 'max_tokens'` and openai's `finish_reason: 'length'`. Compared lower-cased so a BYO
// provider passing its vendor's string through verbatim is not defeated by case alone (Gemini-family
// APIs shout `MAX_TOKENS`) — a cheap widening that can only ever recognise MORE truncation.
const CAP_REASONS = new Set(['max_tokens', 'length']);

// Read truncation off the NORMALISED finish reason. `undefined` in ⇒ `undefined` out: no reason
// lifted is UNKNOWN, never "fine" (see LlmResult.truncated).
const truncatedBy = (finishReason?: string): boolean | undefined =>
    finishReason === undefined
        ? undefined
        : CAP_REASONS.has(finishReason.toLowerCase());

// The `warn` finding for a completion the cap cut short (issue #699). Non-fatal by construction —
// only `level: 'error'` fails a call — because whether a partial answer is acceptable is the
// CALLER's call, not the surface's. The surface's whole job here is to make sure the caller is in a
// position to make it, which it was not while a truncated completion resolved `ok: true` with an
// empty `findings` array on all eight observers.
//
// It reuses the `coerced` change kind rather than minting one, following `flagFinding`'s precedent:
// a new kind would widen `SoftDriftChange`, the per-kind severity map and its documented defaults
// for a diagnostic that reads the same either way. `coerced` is the honest fit of the three soft
// kinds — the value that reached you is not the value that was meant — and its default level is
// already `warn`, so kind and severity agree instead of arguing.
const truncationFinding = (reason: string | undefined): DriftFinding => ({
    level: 'warn',
    path: 'finishReason',
    change: 'coerced',
    detail:
        `the completion stopped at the token cap (\`${reason}\`), so \`text\` is a PARTIAL answer, ` +
        `not a short one. Raise \`tokens\`, or branch on \`truncated\` on the result.`,
});

/**
 * The provider-mapping CONTRACT (ADR 0008) — the contract-not-dependency primitive for LLMs, the
 * same shape the fingerprint contract and `axiosAdapter` follow. A provider declares its url +
 * non-secret headers, maps a {@link LlmRequest} to its HTTP body, and lifts an {@link LlmResult} out
 * of the response. First-party {@link anthropic} / {@link openai} implement it; BYO any other by
 * writing one. The CREDENTIAL is the stitch's `auth` (`bearer`/`apiKey`), never the provider.
 */
export interface LlmProvider {
    id: string;
    /** Completions URL — the default `url` when the config sets none. */
    url: string;
    /** Non-secret default headers (e.g. an API version), merged UNDER the request headers. Never a credential. */
    headers?: Record<string, string>;
    /** Model used when neither the config nor the call sets one. */
    defaultModel?: string;
    /** Map the normalised request to the provider's HTTP request body. */
    buildBody: (req: LlmRequest) => unknown;
    /** Lift the normalised result out of the provider's response body. */
    parse: (body: unknown) => LlmResult;
}

/** Per-stitch llm defaults baked into the surface (the call may override via `body`). Exported
 *  alongside {@link makeLlmSurface}, whose argument it is — a public factory taking a private
 *  parameter type is not actually constructible by a consumer. */
export interface LlmDefaults {
    provider: LlmProvider;
    model?: string;
    system?: string;
    tokens?: number;
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
    const tokens = over.tokens ?? d.tokens;
    if (tokens !== undefined) req.tokens = tokens;
    const temperature = over.temperature ?? d.temperature;
    if (temperature !== undefined) req.temperature = temperature;
    return req;
}

/**
 * The llm surface identity (ADR 0005 Decision 11: only the `id` round-trips). The live surface is
 * built per stitch — it closes over the provider + defaults ({@link makeLlmSurface}) — so this
 * exported identity is the redaction/inspection anchor: an llm stitch exposes `kind: 'llm'` on
 * `__config`, round-tripping as JSON.
 */
export const llmSurface: Surface = { id: 'llm' };

/**
 * The live llm surface for one provider + defaults: pack the request via `provider.buildBody` as a
 * JSON POST (provider headers under the user's), and `interpret` lifts the result via
 * `provider.parse`.
 *
 * EXPORTED (issue #699) because {@link llmSurface} — the identity — has nothing to wrap: it is a
 * bare `{ id: 'llm' }`, so a caller who wanted to layer behaviour over the real llm surface had no
 * object to layer it over and no way to build one, since this factory closes over the provider and
 * defaults that `llm(config)` assembles internally. Wrapping a surface is the documented way to
 * extend one (CONTRACT.md P21 — `Surface` is the seam), and that door was shut on this surface
 * alone. With the factory public, composing over `interpret`/`buildRequest` is ordinary code:
 *
 * ```ts
 * import { makeLlmSurface, anthropic } from 'stitchapi/llm';
 * import { stitch } from 'stitchapi';
 *
 * const base = makeLlmSurface({ provider: anthropic, model: 'claude-opus-4-8' });
 * const strict = {
 *     ...base,
 *     interpret: (res, cfg) => {
 *         const out = base.interpret!(res, cfg);
 *         return out.ok && out.data.truncated
 *             ? { ok: false as const, message: 'llm: truncated at the token cap' }
 *             : out;
 *     },
 * };
 * ```
 *
 * That example is deliberate: making truncation FATAL is a caller-side policy this surface does not
 * impose, and exporting the factory is what makes it a five-line wrapper instead of a fork.
 */
// `method` and the body encoding are the surface's, not the caller's — `NoRequestShapeOnLlm` makes
// authoring `method` or `wire.body` a compile error so the override is never silent. `headers` and
// `wire.response` are NOT overridden (base headers win over the provider's; the response decoding
// is untouched), so they stay live knobs.
//
// The flat `bodyType: 'json'` below is the `AdapterRequest` spelling, one layer under the authoring
// config: that transport contract keeps the flat wire-format fields (CONTRACT.md P22), and the
// engine converts `wire` into them when it builds the request.
export function makeLlmSurface(
    d: LlmDefaults,
): Surface<StitchInput, LlmResult> {
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
        // A 500 is a failure BEFORE it is a completion (ADR 0022 Decision 4) — the composed verdict
        // is what keeps `parse` seeing a successful body now that the engine no longer guarantees a
        // non-2xx never reaches here. A provider's "200 with an error envelope" is still `parse`'s
        // to handle.
        //
        // A completion that hit the token cap is then REPORTED, not thrown (issue #699). The
        // provider mappings already lifted `finishReason`; until now nothing read it, so the one
        // response shape a caller most needs to notice — "your answer is cut off" — arrived as
        // `ok: true` with `findings: []`, indistinguishable from a model that simply finished. It
        // resolves as a success because it IS one at every layer this surface owns (the transport
        // succeeded, the body is well-formed, `text` holds real tokens); whether a partial answer
        // is usable is the caller's question, and `truncated` + the `warn` finding are what let it
        // be asked. Failing the call instead would be a policy — see {@link makeLlmSurface} for the
        // wrapper that adopts it.
        interpret: (res, cfg): SurfaceOutcome<LlmResult> => {
            const failure = verdictOf(res, cfg);
            if (failure) return failure;
            const parsed = provider.parse(res.body);
            // The provider's own answer wins: a BYO provider that already decided this in `parse`
            // knows its vendor's stop vocabulary better than a two-entry set does.
            const truncated =
                parsed.truncated ?? truncatedBy(parsed.finishReason);
            // Unknown stays ABSENT rather than being written as `false` — `compact`'s discipline,
            // and the reason `truncated` is three-state at all.
            const data =
                truncated === undefined ? parsed : { ...parsed, truncated };
            return truncated === true
                ? {
                      ok: true,
                      data,
                      findings: [truncationFinding(parsed.finishReason)],
                  }
                : { ok: true, data };
        },
    };
}

/** Config for {@link llm}: the shared {@link StitchConfig} keys (minus `kind` — the surface owns
 *  it) plus the llm defaults. */
export type LlmOptions = Partial<Omit<StitchConfig, 'kind'>> & {
    provider: LlmProvider;
    model?: string;
    system?: string;
    /** Default cap on tokens generated; a call's `body` may override it. See
     *  {@link LlmRequest.tokens} for why the house name is not the wire's `max_tokens`. */
    tokens?: number;
    temperature?: number;
};

// Split an LlmOptions into the surface-bound defaults and the plain stitch config carrying the
// live surface — shared by the standalone stitch and the seam binder.
function llmConfig(config: LlmOptions): Partial<StitchConfig> {
    const { provider, model, system, tokens, temperature, ...rest } = config;
    const defaults: LlmDefaults = { provider };
    if (model !== undefined) defaults.model = model;
    if (system !== undefined) defaults.system = system;
    if (tokens !== undefined) defaults.tokens = tokens;
    if (temperature !== undefined) defaults.temperature = temperature;
    const urlless = rest.url === undefined && rest.path === undefined;
    return {
        ...rest,
        kind: makeLlmSurface(defaults),
        ...(urlless ? { url: provider.url } : {}),
    };
}

/**
 * `llm({ provider, ... })` — a chat-completion stitch resolving to an {@link LlmResult}. The
 * provider (and `model`/`system`/`tokens`/`temperature` defaults) bind to the surface; the call
 * passes `{ body: { messages: [...] } }` (and may override the defaults). The `url` defaults to
 * the provider's. Bring the credential as the stitch's `auth` (`bearer(env(...))` for OpenAI,
 * `apiKey({ name: 'x-api-key', ... })` for Anthropic).
 *
 * @example
 * ```ts
 * import { llm, anthropic } from 'stitchapi/llm';
 * import { apiKey, env } from 'stitchapi/auth';
 *
 * const chat = llm({
 *     provider: anthropic,
 *     model: 'claude-opus-4-8',
 *     auth: apiKey({ name: 'x-api-key', secret: env('ANTHROPIC_API_KEY') }),
 * });
 * const { text } = await chat({ body: { messages: [{ role: 'user', content: 'hi' }] } });
 * ```
 */
const llmStitch = <const C extends LlmOptions = LlmOptions>(
    // The live (overriding) surface is built by construction here, so the guard applies
    // unconditionally — no `kind`-keyed sibling, because the exported `llmSurface` is only the
    // identity and carries no `buildRequest`, so `method` IS live on `stitch({ kind: llmSurface })`.
    config: C &
        NoUnknownKeys<C, LlmOptions, 'LlmOptions'> &
        NoUnknownNestedKeys<C> &
        NoRequestShapeOnLlm,
): Stitch<LlmResult, InputOf<C>> =>
    // The `as` retypes the loose `makeStitch` result to the declared `InputOf<C>` call-arg type —
    // the same retype `download`/`sse`/`stream` need for the same reason (`InputOf` reads
    // `extends`-fragment schemas since #76, so it is not a clean supertype of `StitchInput` under an
    // unresolved `C`). Sound: the runtime stitch is byte-identical.
    makeStitch<LlmResult>(llmConfig(config)) as unknown as Stitch<
        LlmResult,
        InputOf<C>
    >;

/** llm members bound to a seam. `stitch(config)` creates an llm member of `seam`; `seam` is the
 *  underlying handle for lifecycle/principal (`.as`/`.flush`/`.close`). */
export interface LlmSeamApi {
    readonly stitch: <const C extends LlmOptions = LlmOptions>(
        config: C &
            NoUnknownKeys<C, LlmOptions, 'LlmOptions'> &
            NoUnknownNestedKeys<C> &
            NoRequestShapeOnLlm,
    ) => Stitch<LlmResult, InputOf<C>>;
    readonly seam: Seam;
}

// Bind llm members to a seam through the seam's surface-agnostic `stitch({ kind })` (ADR 0005
// Decision 3) — no per-surface seam method; one shared runtime / principal boundary.
function bindSeam(s: Seam): LlmSeamApi {
    // Implemented loose and `as`-cast to the declared member type — the `download.ts` idiom. A
    // generic impl whose parameter carries `NoUnknownKeys<C, …>` cannot be checked against a member
    // of that same shape: TypeScript instantiates the impl's `C` with the target's whole
    // intersection, so the two `InputOf<C>` return types stop matching.
    const stitch = ((config: LlmOptions) =>
        s.stitch<LlmResult>(llmConfig(config))) as LlmSeamApi['stitch'];
    return { stitch, seam: s };
}

/**
 * The llm surface's authoring helper — callable for the terse form (`llm(config)`) plus:
 * - `llm.stitch(config)` — a standalone llm stitch (alias of the callable).
 * - `llm.bind(existingSeam)` — bind llm members to an existing seam.
 * - `llm.bind(options)` — a new seam whose members default to llm.
 * - `llm.surface` — the llm {@link Surface} identity.
 */
export const llm = Object.assign(llmStitch, {
    surface: llmSurface,
    stitch: llmStitch,
    bind: (arg: Seam | SeamOptions): LlmSeamApi =>
        bindSeam(isSeam(arg) ? arg : makeSeam(arg)),
});

// ---- first-party provider mappings (plain config — no SDK dependency) ------

/**
 * Anthropic Messages API (`/v1/messages`). System prompts ride the top-level `system` param (not a
 * message), `max_tokens` is required (default 1024). Auth is the user's `apiKey({ name: 'x-api-key',
 * … })`; this only sets the non-secret `anthropic-version`. Defaults to the current `claude-opus-4-8`.
 */
export const anthropic: LlmProvider = {
    id: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
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
        return compact({
            model: req.model,
            max_tokens: req.tokens ?? 1024,
            messages: req.messages
                .filter((m) => m.role !== 'system')
                .map((m) => ({ role: m.role, content: m.content })),
            ...(system !== '' ? { system } : {}),
            temperature: req.temperature,
        });
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
            result.usage = compact({
                inputTokens: b.usage.input_tokens,
                outputTokens: b.usage.output_tokens,
            });
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
    url: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
    buildBody: (req) =>
        compact({
            model: req.model,
            messages: [
                ...(req.system !== undefined
                    ? [{ role: 'system', content: req.system }]
                    : []),
                ...req.messages.map((m) => ({
                    role: m.role,
                    content: m.content,
                })),
            ],
            max_tokens: req.tokens,
            temperature: req.temperature,
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
            result.usage = compact({
                inputTokens: b.usage.prompt_tokens,
                outputTokens: b.usage.completion_tokens,
            });
        const fr = b.choices?.[0]?.finish_reason;
        if (fr) result.finishReason = fr;
        return result;
    },
};
