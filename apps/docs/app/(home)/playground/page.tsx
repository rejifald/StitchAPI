import { PlaygroundClient } from './PlaygroundClient';
import './playground.css';

import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'Playground — StitchAPI',
    description:
        'Run StitchAPI snippets in your browser against a built-in fake API. No real network, no install.',
};

export default function PlaygroundPage() {
    return (
        <main className="stitch-playground-page">
            <div className="stitch-playground-page__inner">
                <header className="stitch-playground-page__header">
                    <h1>Playground</h1>
                    <p>
                        A complete StitchAPI snippet, running in an isolated
                        browser sandbox. Calls are served by a built-in fake API
                        — no real network, nothing to install. It loads the full
                        tour on purpose — keep what you need and delete the
                        rest. Use <code>__status</code>, <code>__stream</code>,{' '}
                        <code>__drift</code>, <code>__latencyMs</code>, or{' '}
                        <code>__flaky</code> query knobs to shape the response.
                    </p>
                </header>
                <PlaygroundClient />
            </div>
        </main>
    );
}
