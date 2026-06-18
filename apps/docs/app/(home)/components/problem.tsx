import { Section, SectionHeading } from './primitives';

import { ArrowRight } from 'lucide-react';

const rows: { fetch: string; stitch: string }[] = [
    {
        fetch: 'Opaque bytes you parse and hope are the right shape',
        stitch: 'Schema-validated, typed results — drift caught on every call',
    },
    {
        fetch: 'A throw on the first failure, then it is on you',
        stitch: 'Retries with backoff + jitter, honoring Retry-After',
    },
    {
        fetch: 'One coarse timeout, if you remember it',
        stitch: 'Layered total / per-attempt / chunk timeouts with real aborts',
    },
    {
        fetch: 'No rate control — you meet the 429s in production',
        stitch: 'Proactive throttle: rate + concurrency caps, shared per host',
    },
    {
        fetch: 'A raw byte stream you frame and paginate yourself',
        stitch: 'SSE framing, delta concatenation, auto-pagination, resumability',
    },
    {
        fetch: 'Zero visibility into what the call did',
        stitch: 'A typed event stream + opt-in traces: latency, retries, drift',
    },
];

export function Problem() {
    return (
        <Section id="why" className="border-b border-fd-border bg-fd-muted/30">
            <SectionHeading
                eyebrow="What you'd otherwise hand-roll"
                title="fetch hands you bytes. Everything that makes it reliable, you write yourself."
                lead="A stitch folds it into the call — validation, retries, timeouts, throttling, drift, and traces — declared once and uniform across every endpoint, so you stop re-solving them per integration."
            />

            <div className="mt-12 overflow-hidden rounded-2xl border border-fd-border bg-fd-card">
                <div className="grid grid-cols-1 sm:grid-cols-2">
                    <div className="border-b border-fd-border px-6 py-3 sm:border-r sm:border-b-0">
                        <span className="font-mono text-sm font-semibold text-fd-muted-foreground">
                            Around raw fetch, you hand-roll…
                        </span>
                    </div>
                    <div className="hidden px-6 py-3 sm:block">
                        <span className="text-sm font-semibold text-stitch">
                            …a stitch declares it once
                        </span>
                    </div>
                </div>

                {rows.map((row, i) => (
                    <div
                        key={i}
                        className="grid grid-cols-1 border-t border-fd-border sm:grid-cols-2"
                    >
                        <div className="flex items-start gap-3 px-6 py-4 sm:border-r sm:border-fd-border">
                            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-fd-border" />
                            <span className="text-sm text-fd-muted-foreground">
                                {row.fetch}
                            </span>
                        </div>
                        <div className="flex items-start gap-3 bg-stitch-soft/40 px-6 py-4">
                            <ArrowRight className="mt-0.5 size-4 shrink-0 text-stitch" />
                            <span className="text-sm font-medium text-fd-foreground">
                                {row.stitch}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </Section>
    );
}
