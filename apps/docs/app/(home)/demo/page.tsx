import { Eyebrow } from '../components/primitives';
import { DemoScene } from './scene';

import { ArrowRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * The demo — one chapter per core feature, rendered live by the site
 * itself (see scene.tsx). This page is also the capture fixture for the
 * committed demo media: `pnpm gen:media` (scripts/gen-demo.mjs) opens it
 * with `?capture=1` — full-viewport stage, frame-stepped via
 * `window.__seek(t)` — so the README/launch assets can never drift from
 * what this page shows. For visitors the same stage renders in-flow,
 * scaled to the page column, inside the regular site layout.
 */
export const metadata: Metadata = {
    title: 'Demo',
    description:
        'Every core StitchAPI feature in one loop — streaming, validation and drift, resilience, caching, auth, observability, composition, and an agent tool call — rendered live from real API usage.',
    alternates: { canonical: '/demo' },
};

export default function Page() {
    return (
        <main className="flex-1 px-6 py-[clamp(2rem,6vh,5rem)]">
            <div className="mx-auto w-full max-w-6xl">
                <Eyebrow>Live demo</Eyebrow>
                <h1 className="font-display mt-3 text-3xl font-black tracking-[-0.035em] text-fd-foreground lg:text-4xl">
                    Every core feature, one loop
                </h1>
                <p className="mt-4 max-w-2xl text-lg leading-relaxed text-fd-muted-foreground">
                    Ten chapters, one per feature — each a real snippet on the
                    left and its live result on the right. This isn&apos;t a
                    video: the site renders it, and the README assets are
                    captured from this very page, so the demo can&apos;t drift
                    from the API.
                </p>

                <div className="mt-10">
                    <DemoScene />
                </div>

                <p className="mt-6 text-sm text-fd-muted-foreground">
                    Want your own hands on it?{' '}
                    <Link
                        href="/playground"
                        className="inline-flex items-center gap-1 font-medium text-stitch hover:text-stitch-strong"
                    >
                        Try the playground
                        <ArrowRight className="size-3.5" />
                    </Link>
                </p>
            </div>
        </main>
    );
}
