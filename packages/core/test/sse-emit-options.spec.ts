// `stitchapi/sse-emit`'s frame options are a P12 shorthand over a P20-safe envelope: a bare
// function is the `data` shorthand, the object form must set at least one field, and `{}` is a
// compile error. The `AtLeastOne` narrowing forced the fold's default from a `= {}` parameter
// default to a `?? {}` after the fold, so these assert the RESOLVED value at each spelling —
// a narrowed type is not a changed runtime, and the no-argument path is the one that moved.
import { resolveDelta, resolveError } from '../src/sse-emit';

test('no argument still resolves to the empty frame (the default moved, the behaviour did not)', () => {
    expect(resolveDelta()).toEqual({});
    expect(resolveError()).toEqual({});
});

test('undefined resolves to the empty frame — an absent slot is not an error', () => {
    expect(resolveDelta(undefined)).toEqual({});
    expect(resolveError(undefined)).toEqual({});
});

test('the bare function is the `data` shorthand (P12), folded to the envelope', () => {
    const shape = (c: unknown) => String(c);
    expect(resolveDelta(shape)).toEqual({ data: shape });

    const onErr = (e: unknown) => String(e);
    expect(resolveError(onErr)).toEqual({ data: onErr });
});

test('the object form passes through by reference, extra fields intact', () => {
    const data = (c: unknown) => String(c);
    const full = { data, event: 'tick', id: (_: unknown, i: number) => `${i}` };
    expect(resolveDelta(full)).toBe(full);

    const err = { data: (e: unknown) => String(e), event: 'failed' };
    expect(resolveError(err)).toBe(err);
});

test('a single field is enough — AtLeastOne narrows the bag, it does not require all of it', () => {
    expect(resolveDelta({ event: 'tick' })).toEqual({ event: 'tick' });
    expect(resolveError({ event: 'failed' })).toEqual({ event: 'failed' });
});

test('the empty bag is rejected (compile-time, P20)', () => {
    // @ts-expect-error — `{}` sets no field: omit the slot for the default instead
    void resolveDelta({});
    // @ts-expect-error — same for the terminal error frame
    void resolveError({});
    expect(true).toBe(true);
});
