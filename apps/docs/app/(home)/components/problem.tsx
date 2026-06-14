import { Section, SectionHeading } from './primitives';

import { ArrowRight } from 'lucide-react';

const rows: { fetch: string; stitch: string }[] = [
    {
        fetch: 'Opaque bytes — the whole body lands in context',
        stitch: 'Frugal, model-ready results: field-select, summarize, or return a handle',
    },
    {
        fetch: 'No output contract',
        stitch: 'Schema-validated results, with a re-prompt on mismatch',
    },
    {
        fetch: 'One failure, then it gives up',
        stitch: 'Retries with backoff + jitter, Retry-After, idempotency',
    },
    {
        fetch: 'One coarse timeout',
        stitch: 'Layered total / step / chunk timeouts + AbortSignal',
    },
    {
        fetch: 'A raw byte stream',
        stitch: 'SSE framing, delta concatenation, progress tokens, resumability',
    },
    {
        fetch: 'Zero traces',
        stitch: 'gen_ai.* / mcp.* spans: tokens, cost, latency',
    },
];

export function Problem() {
    return (
        <Section id="why" className="border-b border-fd-border bg-fd-muted/30">
            <SectionHeading
                eyebrow="Why fetch is the wrong primitive"
                title="fetch was built for a browser, not a model reasoning over results"
                lead="A stitch returns an async iterable of typed events instead of Promise<bytes> — one shape that generalizes HTTP progress and pagination today, and LLM token streaming tomorrow."
            />

            <div className="mt-12 overflow-hidden rounded-2xl border border-fd-border bg-fd-card">
                <div className="grid grid-cols-1 sm:grid-cols-2">
                    <div className="border-b border-fd-border px-6 py-3 sm:border-r sm:border-b-0">
                        <span className="font-mono text-sm font-semibold text-fd-muted-foreground">
                            fetch gives the agent…
                        </span>
                    </div>
                    <div className="hidden px-6 py-3 sm:block">
                        <span className="text-sm font-semibold text-stitch">
                            …a stitch gives what the agent needs
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
