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
                {/* The title/intro lived here; the context now lives in the
                    snippet's own comments. Keep an accessible page heading
                    (visually hidden) so the document still has an h1. */}
                <h1 className="sr-only">Playground</h1>
                <PlaygroundClient />
            </div>
        </main>
    );
}
