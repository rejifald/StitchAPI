import { PlaygroundClient } from './PlaygroundClient';
import './playground.css';

import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'Playground — StitchAPI',
    description:
        'Run StitchAPI snippets in your browser against a built-in fake API. No real network, no install.',
};

const INITIAL_CODE = `// Edit and run — this executes in a sandboxed Web Worker.
// Requests never hit the real network: they're served by an in-browser
// StitchAPI simulator. Try /users, /users/2, /status/500, /drift?__drift=1,
// or /stream?__stream=sse on the demo.stitchapi.dev host.
const getUser = stitch('https://demo.stitchapi.dev/users/2');
const user = await getUser();
console.log(user);
return user.data;
`;

export default function PlaygroundPage() {
    return (
        <main className="stitch-playground-page">
            <div className="stitch-playground-page__inner">
                <header className="stitch-playground-page__header">
                    <h1>Playground</h1>
                    <p>
                        Write a StitchAPI snippet and run it in an isolated
                        browser sandbox. Calls are served by a built-in fake API
                        — no real network, nothing to install. Use{' '}
                        <code>__status</code>, <code>__stream</code>,{' '}
                        <code>__drift</code>, <code>__latencyMs</code>, or{' '}
                        <code>__flaky</code> query knobs to shape the response.
                    </p>
                </header>
                <PlaygroundClient initialCode={INITIAL_CODE} />
            </div>
        </main>
    );
}
