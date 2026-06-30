// @stitchapi/vercel-ai — expose a stitch as a Vercel AI SDK tool.
//
// StitchAPI is agent-native through the MCP surface (`stitchapi/mcp`), the canonical
// way to hand a stitch to any agent. This is the framework-specific convenience for
// apps already on the [Vercel AI SDK](https://sdk.vercel.ai): wrap a stitch as a
// `tool()` the model can call inside `generateText` / `streamText`. The stitch runs
// as the tool's `execute`, so the model gets **typed, validated** data back — and
// the credential stays behind the boundary (capability, not credential).
//
// Structural, version-bridged: it imports nothing from `ai`, and the returned tool
// carries BOTH `parameters` (AI SDK v4) and `inputSchema` (v5) pointing at one
// schema, so it drops into either. `ai` is an OPTIONAL peer.
import type { Stitch } from 'stitchapi';

// ---------------------------------------------------------------------------
// The structural call contract
// ---------------------------------------------------------------------------

/** A callable returning an awaitable validated output. The real `Stitch` satisfies
 * it; so does a plain fake in a test. */
// The MINIMAL await-only stitch duck-type (CONTRACT.md P9): this adapter never calls `.stream()`,
// so it accepts any `(input?) => PromiseLike<T>`. The RICH canonical `StitchLike` (awaitable +
// streamable) lives in `@stitchapi/query-core`; a real stitch satisfies both.
export type StitchLike<T, Input = unknown> = (input?: Input) => PromiseLike<T>;

/** The validated output type of a stitch (or `StitchLike`). */
export type QueryOutput<S> =
    S extends Stitch<infer O, infer _I>
        ? O
        : S extends StitchLike<infer O2, infer _I2>
          ? O2
          : unknown;

/** The input type of a stitch (or `StitchLike`). */
export type QueryInput<S> =
    S extends Stitch<infer _O, infer I>
        ? I
        : S extends StitchLike<infer _O2, infer I2>
          ? I2
          : unknown;

// ---------------------------------------------------------------------------
// stitchExecute — the tool `execute`
// ---------------------------------------------------------------------------

/** The AI SDK tool-execution options (the subset this adapter reads). */
export interface ToolExecuteOptions {
    toolCallId?: string;
    abortSignal?: AbortSignal;
}

/** An AI SDK tool `execute` function: `(args, options) => Promise<result>`. */
export type ToolExecute<Args, Output> = (
    args: Args,
    options?: ToolExecuteOptions,
) => Promise<Output>;

/**
 * Build a tool `execute` that runs a stitch. By default the model's `args` ARE the
 * stitch input; pass `toInput` to map a flatter, model-friendly shape onto the
 * stitch's `{ params, query, body }`:
 *
 * ```ts
 * const execute = stitchExecute(getUser, (args: { id: string }) => ({
 *     params: { id: args.id },
 * }));
 * ```
 *
 * The resolved value is the stitch's validated output — exactly what the model
 * should see. A failure rejects, so the AI SDK's tool-error handling reports it.
 */
export function stitchExecute<
    S extends StitchLike<unknown, never>,
    Args = QueryInput<S>,
>(
    stitch: S,
    toInput?: (args: Args) => QueryInput<S>,
): ToolExecute<Args, QueryOutput<S>>;
export function stitchExecute<T, Input = unknown, Args = Input>(
    stitch: StitchLike<T, Input>,
    toInput?: (args: Args) => Input,
): ToolExecute<Args, T>;
export function stitchExecute<T>(
    stitch: StitchLike<T, unknown>,
    toInput?: (args: unknown) => unknown,
): ToolExecute<unknown, T> {
    return (args: unknown): Promise<T> =>
        Promise.resolve(stitch(toInput ? toInput(args) : args));
}

// ---------------------------------------------------------------------------
// stitchTool — the full tool object
// ---------------------------------------------------------------------------

/** A tool object compatible with the Vercel AI SDK's `tools` map, carrying both the
 * v4 (`parameters`) and v5 (`inputSchema`) schema keys. */
export interface StitchTool<Args, Output> {
    description?: string;
    /** AI SDK v4 schema key. */
    parameters: unknown;
    /** AI SDK v5 schema key (same schema). */
    inputSchema: unknown;
    execute: ToolExecute<Args, Output>;
}

export interface StitchToolOptions<Args, Input> {
    /** The tool description the model reads to decide when to call it. */
    description?: string;
    /** The schema the model fills — a Zod schema, or any AI SDK `Schema`. */
    inputSchema: unknown;
    /** Map the model's args onto the stitch input. Default: the args ARE the input. */
    toInput?: (args: Args) => Input;
}

/**
 * Wrap a stitch as a Vercel AI SDK tool. Drop it into a `tools` map:
 *
 * ```ts
 * import { generateText } from 'ai';
 * import { z } from 'zod';
 * import { stitchTool } from '@stitchapi/vercel-ai';
 *
 * const { text } = await generateText({
 *     model,
 *     prompt: 'Who is user 7?',
 *     tools: {
 *         getUser: stitchTool(getUser, {
 *             description: 'Fetch a user by id',
 *             inputSchema: z.object({ id: z.string() }),
 *             toInput: ({ id }) => ({ params: { id } }),
 *         }),
 *     },
 * });
 * ```
 *
 * Works with AI SDK v4 (reads `parameters`) and v5 (reads `inputSchema`) — the tool
 * carries both.
 */
export function stitchTool<
    S extends StitchLike<unknown, never>,
    Args = QueryInput<S>,
>(
    stitch: S,
    options: StitchToolOptions<Args, QueryInput<S>>,
): StitchTool<Args, QueryOutput<S>>;
export function stitchTool<T, Input = unknown, Args = Input>(
    stitch: StitchLike<T, Input>,
    options: StitchToolOptions<Args, Input>,
): StitchTool<Args, T>;
export function stitchTool<T>(
    stitch: StitchLike<T, unknown>,
    options: StitchToolOptions<unknown, unknown>,
): StitchTool<unknown, T> {
    // `compact` is the wrong tool here: `parameters`/`inputSchema` are required `unknown`
    // keys it would optionalize. Keep the explicit spread to omit only `description`.
    return {
        ...(options.description !== undefined
            ? { description: options.description }
            : {}),
        parameters: options.inputSchema,
        inputSchema: options.inputSchema,
        execute: stitchExecute(stitch, options.toInput),
    };
}
