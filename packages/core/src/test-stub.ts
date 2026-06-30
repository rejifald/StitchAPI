// Fakes for testing code that CALLS a stitch: replace a real stitch with a stand-in that returns a
// canned value (or fails) without touching the network or the runtime. The returned object is a
// conformant {@link Stitch} — callable, with `.safe`/`.unwrap`/`.stream`/`.with`/`.cache`/
// `__config`/`__stitch` — so `isStitch()`, a registry, or a Nest `overrideProvider(useValue:…)`
// accept it. A call spy records every invocation. Browser-safe: no `node:*`.
import { compact } from './compact';
import {
    type RedactedStitchConfig,
    type SafeResult,
    type Stitch,
    StitchError,
    type StitchEvent,
    type StitchInput,
    type StitchResult,
} from './types';
import { now } from './util';

/** The call spy attached to every stub. */
export interface StubSpy {
    /** The input passed to each invocation, in order (`{}` when called with no argument). */
    readonly calls: StitchInput[];
    /** How many times the stub was invoked. */
    readonly callCount: number;
    /** Forget all recorded calls. */
    reset(): void;
}

/** Options shared by {@link stubStitch} and {@link failStitch}. */
export interface StubStitchOptions<TOut = unknown> {
    /** `name` reported on `__config` and the synthesized `start` event. Default `'stub'`. */
    name?: string;
    /** `status` reported on the synthesized `result` event. Default `200`. */
    status?: number;
    /** Extra fields merged into the stub's redacted `__config`. */
    config?: Partial<RedactedStitchConfig>;
    /** Override the events `.stream()` yields, instead of the synthesized `start`→`result`/`error`
     *  →`done` sequence. */
    events?: (input: StitchInput) => StitchEvent<TOut>[];
}

/** The stub's success value, or a function of the call input that produces it. */
export type StubImpl<TOut> =
    | TOut
    | ((input: StitchInput) => TOut | Promise<TOut>);

const toError = (e: unknown): StitchError =>
    e instanceof StitchError
        ? e
        : e instanceof Error
          ? new StitchError(e.message, { cause: e })
          : new StitchError(String(e));

const resolve = <TOut>(
    impl: StubImpl<TOut>,
    input: StitchInput,
): Promise<TOut> =>
    Promise.resolve(
        typeof impl === 'function'
            ? (impl as (i: StitchInput) => TOut | Promise<TOut>)(input)
            : impl,
    );

function defaultEvents<TOut>(
    name: string,
    status: number,
    value: TOut | undefined,
    error: StitchError | undefined,
    input: StitchInput,
): StitchEvent<TOut>[] {
    const at = now();
    const start: StitchEvent<TOut> = {
        type: 'start',
        name,
        method: 'GET',
        url: '',
        input,
        at,
    };
    if (error) {
        const err: StitchEvent<TOut> = compact({
            type: 'error',
            name: error.name,
            message: error.message,
            attempts: 1,
            at,
            status: error.status,
        });
        return [
            start,
            err,
            { type: 'done', ok: false, elapsed: 0, ms: 0, attempts: 1, at },
        ];
    }
    return [
        start,
        { type: 'result', data: value as TOut, status, attempts: 1, at },
        { type: 'done', ok: true, elapsed: 0, ms: 0, attempts: 1, at },
    ];
}

// Assemble a conformant Stitch around a per-call `run()` (the value, or a throw) and a matching
// event stream. Shared by stubStitch (run resolves) and failStitch (run rejects).
function assemble<TOut, TIn>(
    run: (input: StitchInput) => Promise<TOut>,
    opts: StubStitchOptions<TOut>,
): Stitch<TOut, TIn> & StubSpy {
    const name = opts.name ?? 'stub';
    const status = opts.status ?? 200;
    const calls: StitchInput[] = [];

    const stream = (
        input: StitchInput,
    ): AsyncGenerator<StitchEvent<TOut>, void> => {
        async function* gen(): AsyncGenerator<StitchEvent<TOut>, void> {
            if (opts.events) {
                for (const ev of opts.events(input)) yield ev;
                return;
            }
            let value: TOut | undefined;
            let error: StitchError | undefined;
            try {
                value = await run(input);
            } catch (e) {
                error = toError(e);
            }
            for (const ev of defaultEvents(name, status, value, error, input))
                yield ev;
        }
        return gen();
    };

    const result = (input: StitchInput): StitchResult<TOut> => {
        const settled = (): Promise<TOut> => run(input);
        return {
            then: (onF, onR) => settled().then(onF, onR),
            catch: (onR) => settled().catch(onR),
            finally: (fn) => settled().finally(fn),
            safe: () =>
                settled().then(
                    (data): SafeResult<TOut> => ({
                        ok: true,
                        data,
                        error: null,
                    }),
                    (e: unknown): SafeResult<TOut> => ({
                        ok: false,
                        data: null,
                        error: toError(e),
                    }),
                ),
            stream: () => stream(input),
        };
    };

    const stub = ((input?: StitchInput): StitchResult<TOut> => {
        const inp = input ?? {};
        calls.push(inp);
        return result(inp);
    }) as unknown as Stitch<TOut, TIn> & StubSpy;

    const record = <R>(
        input: StitchInput | undefined,
        fn: (i: StitchInput) => R,
    ): R => {
        const inp = input ?? {};
        calls.push(inp);
        return fn(inp);
    };

    stub.stream = ((input?: StitchInput) =>
        record(input, (i) => stream(i))) as Stitch<TOut, TIn>['stream'];
    stub.safe = ((input?: StitchInput) =>
        record(input, (i) =>
            run(i).then(
                (data): SafeResult<TOut> => ({ ok: true, data, error: null }),
                (e: unknown): SafeResult<TOut> => ({
                    ok: false,
                    data: null,
                    error: toError(e),
                }),
            ),
        )) as Stitch<TOut, TIn>['safe'];
    stub.unwrap = ((input?: StitchInput) =>
        record(input, (i) => run(i))) as Stitch<TOut, TIn>['unwrap'];
    stub.with = ((partial: Partial<StitchInput>) =>
        assemble<TOut, TIn>(
            (i) => run({ ...partial, ...i }),
            opts,
        )) as unknown as Stitch<TOut, TIn>['with'];
    stub.invalidate = () => Promise.resolve();
    Object.defineProperty(stub, 'cache', {
        value: {
            invalidate: () => Promise.resolve(),
            key: () => Promise.resolve(undefined),
        },
    });

    const config: RedactedStitchConfig = {
        name,
        method: 'GET',
        ...opts.config,
    };
    Object.defineProperty(stub, '__config', { value: config });
    Object.defineProperty(stub, '__stitch', { value: true });
    Object.defineProperty(stub, 'calls', { get: () => calls });
    Object.defineProperty(stub, 'callCount', { get: () => calls.length });
    stub.reset = () => {
        calls.length = 0;
    };
    return stub;
}

/**
 * A stub {@link Stitch} that resolves to `impl` (a value, or a function of the call input). The
 * call spy records every invocation. For testing a service/handler that calls a stitch without
 * hitting the network:
 *
 * ```ts
 * const getUser = stubStitch({ id: 42, name: 'Ada' });
 * await loadProfile(getUser);            // your code under test
 * expect(getUser.callCount).toBe(1);
 * expect(getUser.calls[0]).toEqual({ params: { id: 42 } });
 * ```
 */
export function stubStitch<TOut = unknown, TIn = StitchInput>(
    impl: StubImpl<TOut>,
    opts: StubStitchOptions<TOut> = {},
): Stitch<TOut, TIn> & StubSpy {
    return assemble<TOut, TIn>((input) => resolve(impl, input), opts);
}

/**
 * A stub {@link Stitch} that always fails — `await`/`.unwrap()` reject with a {@link StitchError},
 * `.safe()` resolves to `{ ok: false }`, and `.stream()` yields `start`→`error`→`done`. Pass a
 * message, an `{ status, message }` shape, or a ready {@link StitchError}.
 */
export function failStitch<TOut = unknown, TIn = StitchInput>(
    error: string | StitchError | { status?: number; message?: string },
    opts: StubStitchOptions<TOut> = {},
): Stitch<TOut, TIn> & StubSpy {
    const err =
        error instanceof StitchError
            ? error
            : typeof error === 'string'
              ? new StitchError(error)
              : new StitchError(
                    error.message ?? 'stub failure',
                    compact({ status: error.status }),
                );
    return assemble<TOut, TIn>(() => Promise.reject(err), opts);
}
