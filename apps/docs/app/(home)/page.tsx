import { Cta, Footer } from './components/cta';
import { Differentiator } from './components/differentiator';
import { Features } from './components/features';
import { Hero } from './components/hero';
import { Problem } from './components/problem';
import { Surfaces } from './components/surfaces';

import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'StitchAPI — a typed stitch replaces fetch',
    description:
        'StitchAPI is an agent-native runtime whose core primitive — a stitch — replaces fetch. Declare one endpoint or one example and call it as a function, CLI, HTTP route, or MCP tool.',
};

export default function HomePage() {
    return (
        <main className="flex flex-1 flex-col">
            <Hero />
            <Problem />
            <Surfaces />
            <Features />
            <Differentiator />
            <Cta />
            <Footer />
        </main>
    );
}
