import { getUsers } from './api';

import { useStitch } from '@stitchapi/react';

export default function App() {
    // useStitch runs the stitch on mount and re-renders on every transition
    // (pending → success/error). `refetch` re-runs it from scratch.
    const { data, isPending, isError, refetch } = useStitch(getUsers, {});

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
                @stitchapi/react — quick start
            </h1>
            <p style={{ color: '#475569' }}>
                One <code>stitch()</code> declaration, called through{' '}
                <code>useStitch</code>. Edit <code>src/api.ts</code> to point at
                your own API.
            </p>

            {isPending && <p>Loading…</p>}

            {isError && (
                <p>
                    Request failed.{' '}
                    <button onClick={refetch} style={{ cursor: 'pointer' }}>
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
