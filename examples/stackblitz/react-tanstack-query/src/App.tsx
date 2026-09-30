import { getUsers } from './api';

import { stitchQueryOptions } from '@stitchapi/react';
import {
    QueryClient,
    QueryClientProvider,
    useQuery,
} from '@tanstack/react-query';

const queryClient = new QueryClient();

function Users() {
    // stitchQueryOptions(stitch, input) returns a plain TanStack Query options object
    // (queryKey + queryFn). TanStack Query keeps owning caching and revalidation;
    // the stitch supplies a typed, validated, streaming-first fetcher.
    const { data, isPending, isError, refetch } = useQuery(
        stitchQueryOptions(getUsers, {}),
    );

    return (
        <main
            style={{
                fontFamily: 'system-ui, sans-serif',
                maxWidth: 560,
                margin: '3rem auto',
                padding: '0 1rem',
                color: '#0f172a',
            }}
        >
            <h1 style={{ fontSize: '1.4rem' }}>
                StitchAPI as a TanStack Query queryFn
            </h1>
            <p style={{ color: '#475569' }}>
                <code>stitchQueryOptions(getUsers, {'{}'})</code> plugs the
                stitch into <code>useQuery</code>. No competing cache — TanStack
                owns it.
            </p>

            {isPending && <p>Loading…</p>}

            {isError && (
                <p>
                    Request failed.{' '}
                    <button
                        onClick={() => refetch()}
                        style={{ cursor: 'pointer' }}
                    >
                        Retry
                    </button>
                </p>
            )}

            <ul style={{ lineHeight: 1.8 }}>
                {data?.map((u) => (
                    <li key={u.id}>
                        <strong>{u.name}</strong> —{' '}
                        <span style={{ color: '#2563EB' }}>{u.email}</span>
                    </li>
                ))}
            </ul>
        </main>
    );
}

export default function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <Users />
        </QueryClientProvider>
    );
}
