// Pins N7: a download to a hostname that does not resolve (DNS failure) REJECTS, and the caller-visible
// error does NOT leak the internal host — the `getaddrinfo ENOTFOUND <host>` string rides the transport
// cause, which the engine strips (the M2 finding), so only the generic "fetch failed" crosses the trust
// boundary. This is the download-path angle of the StitchError message-leak class.
//
// No mock server: a `.invalid` host (RFC 6761 — reserved to never resolve) makes an NXDOMAIN
// deterministic with no network dependency. The message assertion is LOOSE (a pathological/slow
// resolver could let the caller `timeout` fire first) — the invariant under test is the NO-LEAK, which
// holds either way.
import { download } from '../../src/download';

test('a download to an unresolvable host rejects without leaking the host', async () => {
    const BOGUS = 'no-such-host-9f3a2b.invalid';
    const getIt = download({
        baseUrl: `http://${BOGUS}`,
        path: '/file.bin',
        timeout: 4000, // ceiling so a slow resolver can't wedge the suite
        retry: { attempts: 1 },
    });

    const started = Date.now();
    const err = await getIt().then(
        () => {
            throw new Error('DNS-failing download unexpectedly resolved');
        },
        (e: unknown) => e,
    );
    expect(Date.now() - started).toBeLessThan(4000); // never hangs
    expect(err).toBeInstanceOf(Error);

    const msg = (err as Error).message;
    // A transport/DNS failure reduces to undici's generic text (or, worst case, the caller timeout).
    expect(msg).toMatch(/fetch failed|timeout|timed out|abort|aborted/i);
    // THE INVARIANT: the internal host and the raw resolver error never reach the caller.
    expect(msg).not.toContain(BOGUS);
    expect(msg).not.toMatch(/ENOTFOUND|getaddrinfo|EAI_AGAIN/i);
});
