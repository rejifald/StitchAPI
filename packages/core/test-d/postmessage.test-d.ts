// Type-level tests for the `postmessage` surface (ADR 0009): `request` infers its call argument
// from `opts.input` and its result from `opts.output`; `events` infers the collected PAYLOAD array
// from `opts.output`; `emit` resolves to `void`. We assert on the UNWRAPPED result via `output(...)`
// and on the call-ARGUMENT via `CallArg` (the `Stitch<…>`-bound / `expectType<Stitch<…>>` recursive-
// `with` quirk, same as the core inference tests in input-inference.test-d.ts).
import { channel } from '../src/postmessage';
import type { MessageTransport } from '../src/postmessage';
import { type CallArg, output } from './_util';

import { expectAssignable, expectError, expectType } from 'tsd';
import { z } from 'zod';

// The awaited result of a stitch call, asserted directly off `ReturnType` — `output(...)` from
// `_util` carries an `S extends Stitch<unknown>` bound that (per its own note) rejects a stitch with
// a REQUIRED first arg (the recursive-`with` contravariance), so a required-`body` request/emit
// can't use it. `Awaited<ReturnType<S>>` unwraps `StitchResult<T>` to `T` with no such bound.
type Result<S extends (...args: never[]) => { then: unknown }> = Awaited<
    ReturnType<S>
>;

// A throwaway transport just to mint a channel for the type assertions (never executed).
const transport = null as unknown as MessageTransport;
const ch = channel(transport, { allowedOrigins: ['https://x.test'] });

// 1) request: result inferred from `opts.output`, call argument from `opts.input`.
const sum = ch.request({
    type: 'sum',
    input: { body: z.object({ a: z.number(), b: z.number() }) },
    output: z.object({ total: z.number() }),
});
expectType<{ total: number }>(null as unknown as Result<typeof sum>); // result tracks opts.output
expectType<{ a: number; b: number }>(
    null as unknown as CallArg<typeof sum>['body'], // call arg tracks opts.input.body
);
expectError(sum({ body: { a: 1 } })); // missing `b`
expectError(sum({ body: { a: 1, b: 'two' } })); // `b` must be a number

// 2) request with NO output schema → result is unknown (no contract pinned); arg stays optional.
const bare = ch.request({ type: 'ping' });
expectType<unknown>(output(bare));

// 3) emit: result is void; call argument inferred from `opts.input`.
const log = ch.emit({
    type: 'log',
    input: { body: z.object({ msg: z.string() }) },
});
expectType<void>(null as unknown as Result<typeof log>);
expectType<{ msg: string }>(null as unknown as CallArg<typeof log>['body']);
expectError(log({ body: { msg: 123 } })); // msg must be a string

// 4) events: result is the COLLECTED PAYLOAD ARRAY, typed from `opts.output`.
const ticks = ch.events({
    type: 'tick',
    output: z.object({ n: z.number() }),
});
expectType<{ n: number }[]>(output(ticks)); // await ⇒ payload[] (no required arg → output() is fine)

// 5) events with NO output schema → unknown[] (the loose collected array).
const loose = ch.events({ type: 'evt' });
expectType<unknown[]>(output(loose));

// 6) a no-input request keeps a fully-OPTIONAL call argument (backward-compatible with StitchInput).
const noInput = ch.request({ type: 'noop' });
expectAssignable<CallArg<typeof noInput>>(undefined);
