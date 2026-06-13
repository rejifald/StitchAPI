import { Section, SectionHeading } from './primitives';

import {
    Activity,
    FileText,
    GitCompareArrows,
    KeyRound,
    Radio,
    RefreshCw,
    ShieldCheck,
    Timer,
    Workflow,
} from 'lucide-react';

const features = [
    {
        icon: GitCompareArrows,
        title: 'Runtime drift detection',
        body: 'Every response is validated against its contract, so a vendor silently renaming a field surfaces immediately — not hours later as a downstream undefined.',
    },
    {
        icon: ShieldCheck,
        title: 'Validation, then re-prompt',
        body: 'Schemas guard params, query, body, and output. On a mismatch the stitch can re-prompt instead of handing garbage back to a model.',
    },
    {
        icon: RefreshCw,
        title: 'Reliability built in',
        body: 'Retries with backoff + jitter, Retry-After, idempotency keys, throttling, and circuit breaking — declared per stitch, not bolted on.',
    },
    {
        icon: Timer,
        title: 'Layered timeouts',
        body: 'Total, step, and chunk timeouts plus AbortSignal, so a slow upstream never quietly hangs your call.',
    },
    {
        icon: Radio,
        title: 'The event stream is the spine',
        body: 'start → progress → drift → result → done. Streaming output, observability, and drift all read the same stream a stitch emits.',
    },
    {
        icon: KeyRound,
        title: 'Capability, not credential',
        body: 'Auth lives at the stitch. Callers — including agents — get data without ever seeing the secret behind it.',
    },
    {
        icon: Workflow,
        title: 'Compose, don’t configure',
        body: 'baseUrl, auth, retry, throttle, and hooks are named, shareable values you compose with .with() and extends — no central config object.',
    },
    {
        icon: Activity,
        title: 'Observable by default',
        body: 'gen_ai.* and mcp.* spans carry tokens, cost, and latency, turning the agent-native layer into your integration-health layer.',
    },
    {
        icon: FileText,
        title: 'More than JSON',
        body: 'responseType reads HTML, text, or binary; a transform reshapes whatever comes back — scrape a page to typed data or pipe it through your own Markdown converter — before validation and drift see it. The runtime stays converter-agnostic, so you pay no bytes for a format you don’t use.',
    },
];

export function Features() {
    return (
        <Section
            id="features"
            className="border-b border-fd-border bg-fd-muted/30"
        >
            <SectionHeading
                eyebrow="What you get at the call site"
                title="Everything fetch left to you — declared, defaulted, and observable"
                lead="Progressive disclosure: stitch('https://…') just works, and every capability reveals its knobs only when you reach for them."
            />

            <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-fd-border bg-fd-border sm:grid-cols-2 lg:grid-cols-2">
                {features.map(({ icon: Icon, title, body }, index) => (
                    <div
                        key={title}
                        className={`flex flex-col gap-3 bg-fd-card p-6${
                            features.length % 2 === 1 &&
                            index === features.length - 1
                                ? ' sm:col-span-2'
                                : ''
                        }`}
                    >
                        <span className="inline-flex size-10 items-center justify-center rounded-xl bg-stitch-soft text-stitch">
                            <Icon className="size-5" />
                        </span>
                        <h3 className="text-base font-semibold text-fd-foreground">
                            {title}
                        </h3>
                        <p className="text-sm leading-relaxed text-fd-muted-foreground">
                            {body}
                        </p>
                    </div>
                ))}
            </div>
        </Section>
    );
}
