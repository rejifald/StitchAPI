// `processWide` (src/process-wide.ts) shares a registry between every copy of the package in one
// process through a `Symbol.for` slot on `globalThis` (#898). A slot is a name that freezes at the
// first release shipping it, so it must be safe when what sits there is not what this copy stores:
// a stray assignment, another release's layout under the same name. Each slot below is seeded with
// a foreign shape and the code that owns it is then driven through its first use. None may throw;
// each slot is replaced by a collection of the right type and works from then on.
//
// Every case loads the owning module FRESH (`vi.resetModules`), because the slot is read when the
// module first needs it, and removes the slot afterwards so no case sees another's state.
import type { SchemaFingerprinter } from '../src/fingerprint';

const SLOTS = [
    'stitchapi.secretKeys/1',
    'stitchapi.fingerprinters/1',
    'stitchapi.hostStates/1',
    'stitchapi.seamIds/1',
    'stitchapi.otlp.warned/1',
    'stitchapi.otlp.loadWarned/1',
] as const;

const slots = globalThis as unknown as Record<symbol, unknown>;
const slot = (name: (typeof SLOTS)[number]): unknown => slots[Symbol.for(name)];

// What a foreign value could plausibly be: not a Set/Map, so the owner cannot use it as one.
const FOREIGN = [
    ['an object', () => ({})],
    ['an array', () => []],
    ['a string', () => 'x'],
    ['a number', () => 0],
    ['an object shaped like another layout', () => ({ last: 3, done: true })],
] as const;

beforeEach(() => {
    vi.resetModules();
    for (const name of SLOTS) Reflect.deleteProperty(slots, Symbol.for(name));
});

afterEach(() => {
    for (const name of SLOTS) Reflect.deleteProperty(slots, Symbol.for(name));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

function seed(name: (typeof SLOTS)[number], value: unknown): void {
    slots[Symbol.for(name)] = value;
}

describe.each(FOREIGN)('a slot holding %s', (_label, make) => {
    test('secretKeys: register and has work, and the slot becomes a Set', async () => {
        seed('stitchapi.secretKeys/1', make());
        const { secrets } = await import('../src');

        expect(() => {
            secrets.register('x-foreign-secret');
        }).not.toThrow();

        expect(secrets.has('x-foreign-secret')).toBe(true);
        expect(slot('stitchapi.secretKeys/1')).toBeInstanceOf(Set);
    });

    test('fingerprinters: register, get, list and clear work, and the slot becomes a Map', async () => {
        seed('stitchapi.fingerprinters/1', make());
        const { fingerprinters } = await import('../src/fingerprint');
        const fp: SchemaFingerprinter = {
            vendor: 'foreign-vendor',
            range: '*',
            fingerprint: () => ({ token: 't', strength: 'strong' }),
        };

        expect(() => {
            fingerprinters.register(fp);
        }).not.toThrow();

        expect(fingerprinters.get('foreign-vendor')).toBe(fp);
        expect(fingerprinters.list()).toEqual([fp]);
        fingerprinters.clear();
        expect(fingerprinters.list()).toEqual([]);
        expect(slot('stitchapi.fingerprinters/1')).toBeInstanceOf(Map);
    });

    test("hostStates: a pool:'host' throttle acquires and releases, and the slot becomes a Map", async () => {
        seed('stitchapi.hostStates/1', make());
        const { createThrottle } = await import('../src/resilience');
        const throttle = createThrottle({ rate: '1000/s', pool: 'host' });

        await expect(throttle.acquire('foreign.test')).resolves.toBeDefined();
        throttle.release('foreign.test');

        expect(slot('stitchapi.hostStates/1')).toBeInstanceOf(Map);
    });

    test('seamIds: seam() builds, and every seam gets an id of its own', async () => {
        seed('stitchapi.seamIds/1', make());
        const { seam } = await import('../src');

        expect(() => seam({})).not.toThrow();
        seam({});

        const ids = slot('stitchapi.seamIds/1');
        expect(ids).toBeInstanceOf(Set);
        expect([...(ids as Set<string>)]).toEqual(['s1', 's2']); // two seams, two ids
    });

    test('otlp.warned: a failing export still warns once and never throws', async () => {
        seed('stitchapi.otlp.warned/1', make());
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        vi.stubGlobal('fetch', () => Promise.reject(new TypeError('down')));
        const { otlp } = await import('../src/otlp');

        await expect(otlp.exporter().export([])).resolves.toBeUndefined();
        await otlp.exporter().export([]);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(slot('stitchapi.otlp.warned/1')).toBeInstanceOf(Set);
    });

    test('otlp.loadWarned: a chunk that fails to load still warns once and never throws', async () => {
        seed('stitchapi.otlp.loadWarned/1', make());
        vi.stubEnv('STITCH_EXPORT', 'otlp');
        vi.stubEnv('STITCH_TRACE_FILE', '');
        vi.doMock('../src/otlp', () => {
            throw new Error('chunk missing');
        });
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        const { stitch } = await import('../src');
        const call = stitch({
            name: 'foreign',
            url: 'http://api.example.com/x',
            adapter: () =>
                Promise.resolve({
                    status: 200,
                    headers: {},
                    body: { ok: true },
                }),
        });

        await expect(call()).resolves.toEqual({ ok: true });
        await vi.waitFor(() => {
            expect(warn).toHaveBeenCalled();
        });
        await call();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(slot('stitchapi.otlp.loadWarned/1')).toBeInstanceOf(Set);
        vi.doUnmock('../src/otlp');
    });
});

describe('a slot holding the right type is shared, not replaced', () => {
    test('two fresh copies of the module see one registry', async () => {
        const first = await import('../src');
        first.secrets.register('x-shared-secret');
        const held = slot('stitchapi.secretKeys/1');

        vi.resetModules();
        const second = await import('../src');

        expect(second).not.toBe(first); // a second copy of the module graph
        expect(second.secrets.has('x-shared-secret')).toBe(true);
        expect(slot('stitchapi.secretKeys/1')).toBe(held);
    });

    test('every slot name carries a layout number', () => {
        for (const name of SLOTS) expect(name).toMatch(/\/\d+$/);
    });
});
