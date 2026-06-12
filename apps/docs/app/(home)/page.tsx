import { Cta, Footer } from './components/cta';
import { Differentiator } from './components/differentiator';
import { Features } from './components/features';
import { Hero } from './components/hero';
import { Problem } from './components/problem';
import { Surfaces } from './components/surfaces';

import { appName } from '@/lib/shared';

import type { Metadata } from 'next';

const title = 'StitchAPI — a typed stitch replaces fetch';
const description =
    'StitchAPI is an agent-native runtime whose core primitive — a stitch — replaces fetch. Declare one endpoint or one example and call it as a function, CLI, HTTP route, or MCP tool.';

export const metadata: Metadata = {
    title,
    description,
    alternates: { canonical: '/' },
    openGraph: {
        type: 'website',
        url: '/',
        siteName: appName,
        title,
        description,
        images: '/og/home',
    },
    twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: '/og/home',
    },
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
