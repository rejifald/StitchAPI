// The same five rules with NO StitchAPI in them, so C9's line-count comparison is honest and its
// behaviour comparison is exact. It drives the same fake server through the same `fetch`-shaped
// entry point the StitchAPI side reaches through `fetchAdapter({ fetch })`, so neither side gets a
// shortcut on the transport.
//
// The rules, identical to `revalidate.ts`:
//   1. replay the stored validator as `If-None-Match`
//   2. a 304 is answered with the stored body
//   3. a 200 with an ETag stores `{ etag, body }`; a 200 without one FORGETS the key
//   4. the key folds in the credential
//   5. a 304 with no stored body (an orphan validator) refetches unconditionally
//
// …plus the bounded store, so the feature sets match line for line and the count difference is not
// this file quietly leaving something out.
//
// What is NOT free here, and is what the extra lines on the StitchAPI side buy: request assembly,
// JSON decoding, the non-2xx check, and the auth header — all of which a real hand-rolled client
// genuinely has to write, so all of which are counted.

export interface HandRolledEntry {
    etag: string;
    body: unknown;
}

export interface HandRolledStats {
    revalidated: number;
    stored: number;
    orphans: number;
    unvalidatable: number;
    size: number;
}

export interface HandRolledClient {
    get(url: string): Promise<unknown>;
    readonly stats: HandRolledStats;
}

export function handRolledClient(
    fetchImpl: typeof fetch,
    token?: string,
    entries = 500,
): HandRolledClient {
    const store = new Map<string, HandRolledEntry>();
    const stats: HandRolledStats = {
        revalidated: 0,
        stored: 0,
        orphans: 0,
        unvalidatable: 0,
        size: 0,
    };

    const send = async (url: string, etag?: string): Promise<Response> => {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
        if (etag !== undefined) headers['if-none-match'] = etag;
        return fetchImpl(url, { method: 'GET', headers });
    };

    const learn = async (key: string, res: Response): Promise<unknown> => {
        const text = await res.text();
        const body: unknown = text === '' ? undefined : JSON.parse(text);
        const etag = res.headers.get('etag');
        if (etag === null) {
            stats.unvalidatable++;
            store.delete(key);
        } else {
            if (store.has(key)) store.delete(key);
            store.set(key, { etag, body });
            stats.stored++;
            while (store.size > entries) {
                const oldest = store.keys().next().value;
                if (oldest === undefined) break;
                store.delete(oldest);
            }
        }
        stats.size = store.size;
        return body;
    };

    return {
        stats,
        async get(url) {
            const key = `GET ${url} ${token ?? ''}`;
            const entry = store.get(key);
            const res = await send(url, entry?.etag);
            if (res.status === 304) {
                if (entry) {
                    stats.revalidated++;
                    return entry.body;
                }
                stats.orphans++;
                store.delete(key);
                stats.size = store.size;
                const fresh = await send(url);
                if (fresh.status !== 200)
                    throw new Error(`HTTP ${String(fresh.status)}`);
                return learn(key, fresh);
            }
            if (res.status !== 200)
                throw new Error(`HTTP ${String(res.status)}`);
            return learn(key, res);
        },
    };
}
