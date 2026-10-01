// `stitch serve` through `main()` with an injected registry: the CLI wiring of `--disclose` onto
// `ServeOptions.disclose` (#867). `serve` blocks until SIGINT/SIGTERM, so the test captures the
// handler the command registers on `process` and calls it, instead of raising a real signal in the
// test process.
import { main } from '../src/cli';
import type { StitchRegistry } from '../src/registry';
import { failStitch } from '../src/test-stub';

const LEAK = 'getaddrinfo ENOTFOUND payments.internal.corp';
const registry: StitchRegistry = { down: failStitch(LEAK) };

// Start `stitch serve --port 0 <flags>`, POST to the failing stitch, stop the server, and return
// what the caller saw alongside the exit code.
async function serveAndFail(
    flags: string[],
): Promise<{ code: number; status: number; body: unknown }> {
    let stop: (() => void) | undefined;
    const realOnce = process.once.bind(process);
    vi.spyOn(process, 'once').mockImplementation(((
        event: string,
        listener: (...args: unknown[]) => void,
    ) => {
        if (event === 'SIGINT') {
            stop = listener;
            return process;
        }
        return realOnce(event, listener);
    }) as typeof process.once);

    let stderr = '';
    const done = main(['serve', '--module', 'x', '--port', '0', ...flags], {
        load: () => Promise.resolve(registry),
        writeErr: (s) => {
            stderr += s;
        },
    });
    try {
        await vi.waitFor(() => {
            expect(stderr).toContain('listening on');
        });
        const base = /listening on (\S+)/.exec(stderr)?.[1];
        const res = await fetch(`${base}/stitch/down`, {
            method: 'POST',
            body: '{}',
        });
        const body: unknown = await res.json();
        stop?.();
        return { code: await done, status: res.status, body };
    } finally {
        vi.restoreAllMocks();
    }
}

describe('stitch serve --disclose', () => {
    test('by default a failure answers with the reason phrase, not the raw message', async () => {
        const out = await serveAndFail([]);
        expect(out.code).toBe(0);
        expect(out.status).toBe(502);
        expect(out.body).toEqual({ error: 'Bad Gateway' });
    });

    test('`--disclose` sends the raw message', async () => {
        const out = await serveAndFail(['--disclose']);
        expect(out.code).toBe(0);
        expect(out.status).toBe(502);
        expect(out.body).toEqual({ error: LEAK });
    });

    test('the removed `--expose` spelling does not switch disclosure on', async () => {
        const out = await serveAndFail(['--expose']);
        expect(out.body).toEqual({ error: 'Bad Gateway' });
    });
});

describe('stitch help', () => {
    test('documents `--disclose` for serve', async () => {
        let out = '';
        const code = await main(['--help'], {
            write: (s) => {
                out += s;
            },
        });
        expect(code).toBe(0);
        expect(out).toContain('stitch serve');
        expect(out).toContain('--disclose');
        expect(out).not.toContain('--expose');
    });
});
