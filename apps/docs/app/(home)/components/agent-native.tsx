import { Section, SectionHeading } from './primitives';

import { KeyRound, Radio, RefreshCw, Scissors } from 'lucide-react';

const inherits = [
    {
        icon: Scissors,
        title: 'Responses sized for context',
        body: 'Output comes back unwrapped, validated, and trimmed to the fields you declared — the model reads structured data, not an 8 KB raw payload. Fewer tokens, less noise.',
    },
    {
        icon: Radio,
        title: 'Streaming it can act on',
        body: 'Typed start → progress → drift → result events stream back, so an agent reacts to partial results instead of blocking on opaque bytes.',
    },
    {
        icon: RefreshCw,
        title: 'Resilience off the prompt',
        body: 'Retries with backoff, throttling, and timeouts are the runtime’s job, not the model’s — reliability never has to live in the reasoning.',
    },
    {
        icon: KeyRound,
        title: 'A capability, not a credential',
        body: 'Auth lives at the stitch. The agent invokes it and receives data, never the token behind it — safe to hand to a caller you don’t fully trust.',
    },
];

export function AgentNative() {
    return (
        <Section
            id="agent-native"
            className="border-b border-fd-border bg-fd-muted/30"
        >
            <SectionHeading
                eyebrow="Built for agents, not bolted on"
                title="When the caller is an agent, it inherits the whole runtime"
                lead="A hand-wrapped MCP tool forwards raw bytes and a stored key. The same stitch hands an agent a production runtime — and never the secret behind it."
            />

            <div className="mt-12 grid gap-4 sm:grid-cols-2">
                {inherits.map(({ icon: Icon, title, body }) => (
                    <div
                        key={title}
                        className="flex flex-col gap-3 rounded-2xl border border-fd-border bg-fd-card p-6"
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
