import { Section, SectionHeading } from './primitives';

import { DemoMedia } from '@/components/demo-media';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

/**
 * The demo band — the "solution reveal" right after Problem: the pains
 * the table just enumerated, shown handled in one 20-second loop. The
 * media is the generated marquee cut (docs/media, theme- and DPR-aware
 * via DemoMedia); it links to /demo, where the full ten-chapter loop
 * renders live from the same scene the assets are captured from.
 */
export function Demo() {
    return (
        <Section id="demo" className="border-b border-fd-border">
            <SectionHeading
                eyebrow="See it run"
                title="Twenty seconds, four guarantees"
                lead="A reply streams in token by token, the output is validated with drift logged, a 502 recovers on its own, and an agent calls the same stitch as a tool."
            />
            <Link
                href="/demo"
                className="group mt-10 block"
                aria-label="Watch the full demo"
            >
                <DemoMedia className="transition-opacity group-hover:opacity-95" />
            </Link>
            <p className="mt-4 text-sm text-fd-muted-foreground">
                <Link
                    href="/demo"
                    className="inline-flex items-center gap-1 font-medium text-stitch hover:text-stitch-strong"
                >
                    Watch the full ten-feature tour — rendered live by this site
                    <ArrowRight className="size-3.5" />
                </Link>
            </p>
        </Section>
    );
}
