// P20 (No empty-object config) on the surface binders. `sse.bind` / `stream.bind` / `graphql.bind`
// / `llm.bind` take `Seam | AtLeastOne<SeamConfig>`, so the opaque `bind({})` is a COMPILE error.
//
// It used to be `Seam | SeamConfig`, and `{}` is a perfectly good `SeamConfig`: it failed `isSeam`,
// fell through to `seam({})`, and silently built a whole second runtime — its own store, vault,
// trace sink, throttle bucket and lifecycle — behind the most opaque spelling available. Two
// binders written that way in one process are two runtimes that share nothing, which is the exact
// trap P20 exists to close.
//
// The all-defaults case keeps an unambiguous spelling that says what it does: `bind(seam())`.
//
// The `@ts-expect-error` assertions are enforced by `check:types` (an unused directive would
// itself fail), not at runtime — the closure below is never invoked. The runtime tests beside them
// pin the two arms that DO typecheck: an existing seam is reused, a real config builds a new one.
import { graphql } from '../src/graphql';
import { llm } from '../src/llm';
import { seam } from '../src/seam';
import { sse } from '../src/sse';
import { stream } from '../src/stream';
import { isSeam } from '../src/types';

test('the opaque `bind({})` is rejected on every surface binder (P20)', () => {
    const rejected = () => [
        // @ts-expect-error — `sse.bind({})` is rejected; use `sse.bind(seam())` for the defaults.
        sse.bind({}),
        // @ts-expect-error — `stream.bind({})` is rejected; use `stream.bind(seam())`.
        stream.bind({}),
        // @ts-expect-error — `graphql.bind({})` is rejected; use `graphql.bind(seam())`.
        graphql.bind({}),
        // @ts-expect-error — `llm.bind({})` is rejected; use `llm.bind(seam())`.
        llm.bind({}),
    ];
    expect(typeof rejected).toBe('function');
});

test('`bind(seam())` is the all-defaults spelling — and binds THAT seam, not a new one', () => {
    const api = seam();
    expect(sse.bind(api).seam).toBe(api);
    expect(stream.bind(api).seam).toBe(api);
    expect(graphql.bind(api).seam).toBe(api);
    expect(llm.bind(api).seam).toBe(api);
});

test('a ≥1-field config still builds a new seam', () => {
    const accepted = [
        sse.bind({ baseUrl: 'https://x' }),
        stream.bind({ baseUrl: 'https://x' }),
        graphql.bind({ baseUrl: 'https://x' }),
        llm.bind({ baseUrl: 'https://x' }),
    ];
    for (const bound of accepted) expect(isSeam(bound.seam)).toBe(true);
});
