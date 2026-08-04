// ADR 0022 Decision 4 — every built-in `interpret` composes the status verdict.
//
// This is the safety net for Decision 1, and it is written to fail LOUDLY if that reordering ever
// lands without the composition. Until `interpret` moves inside the attempt loop the engine
// guarantees these hooks never see a non-2xx, so the surfaces' own rules are correct by accident:
// graphql reads `body.errors`, finds none on an error page, and calls it a successful GraphQL
// response; download wraps the error body as the downloaded Blob; llm hands it to `provider.parse`.
//
// The hooks are driven DIRECTLY here rather than through a stitch, precisely because the engine
// currently throws first — a round-trip test would pass on the engine's guarantee and prove nothing
// about the hook. After step 3 both paths hold; these keep pinning the hook itself.
import { downloadSurface } from '../src/download';
import { llm } from '../src/llm';
import type { LlmProvider } from '../src/llm';
import { graphqlSurface, httpSurface, interpretOf } from '../src/surface';
import type { Surface } from '../src/surface';
import type {
    AdapterResponse,
    ResolvedStitchConfig,
    StatusMatch,
} from '../src/types';

const resOf = (status: number, body: unknown): AdapterResponse => ({
    status,
    headers: {},
    body,
});
const cfgOf = (accept?: StatusMatch): ResolvedStitchConfig =>
    ({ verdict: { accept } }) as ResolvedStitchConfig;

// An error page an API might actually return on a 500 — deliberately shaped so each surface's own
// rules would happily accept it: no `errors` key for graphql, a body download would wrap.
const ERROR_PAGE = { message: 'internal error' };

// The llm surface is built by a factory, so reach it through a stitch's resolved config. `parse`
// records every body it is handed, so a test can assert the stronger property: an error page must
// never reach the provider at all, not merely that the outcome came back `ok: false`.
const parsed: unknown[] = [];
const recordingProvider: LlmProvider = {
    id: 'test-provider',
    url: 'https://x.test/v1',
    buildBody: () => ({}),
    parse: (body) => {
        parsed.push(body);
        return { text: 'parsed' } as ReturnType<LlmProvider['parse']>;
    },
};
beforeEach(() => {
    parsed.length = 0;
});

const surfaceOf = (s: { __config: { kind?: unknown } }): Surface =>
    // `__rawConfig` carries the live Surface; `__config.kind` is redacted to the id string.
    (s as unknown as { __rawConfig: { kind: Surface } }).__rawConfig.kind;

describe('every built-in interpret composes the status verdict (ADR 0022 Decision 4)', () => {
    const CASES: [string, () => Surface][] = [
        ['graphql', () => graphqlSurface],
        ['download', () => downloadSurface],
        ['http', () => httpSurface],
        [
            'llm',
            () =>
                surfaceOf(
                    llm({
                        url: 'https://x.test/v1',
                        provider: recordingProvider,
                    }),
                ),
        ],
    ];

    test.each(CASES)('%s interprets a 500 as a failure', (_name, get) => {
        const outcome = interpretOf(get())(resOf(500, ERROR_PAGE), cfgOf());
        expect(outcome).toMatchObject({ ok: false, status: 500 });
    });

    // The stronger property for llm: the error page must not reach `provider.parse` at all. A
    // surface that returned `ok: false` only AFTER parsing would still have run provider code over
    // an error body — the composed verdict has to short-circuit.
    test('llm’s provider.parse never sees a non-2xx body', () => {
        const surface = surfaceOf(
            llm({ url: 'https://x.test/v1', provider: recordingProvider }),
        );
        interpretOf(surface)(resOf(500, ERROR_PAGE), cfgOf());
        expect(parsed).toEqual([]);

        interpretOf(surface)(resOf(200, { ok: 1 }), cfgOf());
        expect(parsed).toEqual([{ ok: 1 }]);
    });

    test.each(CASES)('%s still interprets a 200 as a result', (_name, get) => {
        // graphql/http return the body; download a { blob }; llm would parse. Only the VERDICT
        // is asserted here — each surface's own value is its business (Decision 2's split).
        const outcome = interpretOf(get())(
            resOf(200, { data: { ok: 1 } }),
            cfgOf(),
        );
        expect(outcome.ok).toBe(true);
    });

    // The composition must read the caller's accept rule, not just `status < 400` — otherwise
    // `verdict.accept` would silently stop working on every non-http surface once step 3 lands.
    test.each(CASES)('%s honours verdict.accept on a non-2xx', (_name, get) => {
        const outcome = interpretOf(get())(
            resOf(404, { data: null }),
            cfgOf([404]),
        );
        expect(outcome.ok).toBe(true);
    });
});

describe('the composed verdict does not swallow each surface’s own rules', () => {
    test('graphql still fails a 200 carrying errors', () => {
        const outcome = graphqlSurface.interpret!(
            resOf(200, { errors: [{ message: 'boom' }] }),
            cfgOf(),
        );
        expect(outcome).toMatchObject({
            ok: false,
            message: 'GraphQL: boom',
        });
    });

    test('graphql reports its own message, not the HTTP one, on a 200', () => {
        const outcome = graphqlSurface.interpret!(
            resOf(200, { errors: [{ message: 'a' }, {}] }),
            cfgOf(),
        );
        expect(outcome).toMatchObject({
            ok: false,
            message: 'GraphQL: a; error',
        });
    });

    // Precedence: the status verdict runs FIRST, so a 500 that also carries `errors` reports as the
    // HTTP failure. That is the honest read — the transport failed; the payload is incidental.
    test('a 500 carrying graphql errors reports the HTTP failure', () => {
        const outcome = graphqlSurface.interpret!(
            resOf(500, { errors: [{ message: 'boom' }] }),
            cfgOf(),
        );
        expect(outcome).toMatchObject({ ok: false, message: 'HTTP 500' });
    });

    test('download still yields the blob on a 200', () => {
        const outcome = downloadSurface.interpret!(resOf(200, 'BLOB'), cfgOf());
        expect(outcome).toMatchObject({ ok: true, data: { blob: 'BLOB' } });
    });
});
