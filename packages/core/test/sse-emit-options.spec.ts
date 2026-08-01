// `stitchapi/sse-emit`'s frame options are a P12 shorthand over a P20-safe envelope: a bare
// function is the `data` shorthand, the object form must set at least one field, and `{}` is a
// compile error. The `AtLeastOne` narrowing forced the fold's default from a `= {}` parameter
// default to a `?? {}` after the fold, so these assert the RESOLVED value at each spelling —
// a narrowed type is not a changed runtime, and the no-argument path is the one that moved.
import {
    deltaEvent,
    deltaFrame,
    resolveDelta,
    resolveError,
} from '../src/sse-emit';

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

// The two capabilities lifted out of @stitchapi/nest into the shared envelope (P16), so all six
// hosts gained them. Asserted on core's own frame builder, because that is what the raw-writer
// hosts (express/fastify/elysia/next) go through — and `deltaEvent` is what the structured
// emitters (hono's writeSSE, nest's MessageEvent) call instead.
describe('delta frames: index + function-form event', () => {
    test('data receives the zero-based frame index', () => {
        const delta = { data: (c: unknown, i: number) => `${String(c)}#${i}` };
        expect(deltaFrame('a', 0, delta)).toContain('data: a#0');
        expect(deltaFrame('b', 1, delta)).toContain('data: b#1');
    });

    test('a one-argument shaper still works — widening the signature broke nothing', () => {
        const delta = { data: (c: unknown) => String(c).toUpperCase() };
        expect(deltaFrame('a', 7, delta)).toContain('data: A');
    });

    test('event may be a function of the chunk, naming each frame', () => {
        const delta = {
            event: (c: unknown) => (c as { kind: string }).kind,
            data: (c: unknown) => (c as { text: string }).text,
        };
        expect(deltaFrame({ kind: 'token', text: 'a' }, 0, delta)).toContain(
            'event: token',
        );
        expect(deltaFrame({ kind: 'usage', text: 'b' }, 1, delta)).toContain(
            'event: usage',
        );
    });

    test('a fixed event string still labels every frame', () => {
        expect(deltaFrame('a', 0, { event: 'tick' })).toContain('event: tick');
    });

    test('deltaEvent resolves both forms and passes undefined through', () => {
        expect(deltaEvent('a', 0, {})).toBeUndefined();
        expect(deltaEvent('a', 0, { event: 'tick' })).toBe('tick');
        expect(deltaEvent('a', 3, { event: (_c, i) => `f${i}` })).toBe('f3');
    });
});
