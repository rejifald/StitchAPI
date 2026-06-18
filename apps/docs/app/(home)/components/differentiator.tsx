import { Section, SectionHeading } from './primitives';

import { Boxes, ScanSearch } from 'lucide-react';

const quadrants = [
    {
        icon: ScanSearch,
        title: 'Spec-less long tail',
        body: 'Every serious competitor needs an OpenAPI spec. A stitch needs one endpoint — or one example. Author from the response you already have.',
    },
    {
        icon: Boxes,
        title: 'Heterogeneous & agent-native',
        body: 'A lightweight library where HTTP, GraphQL, shell, and LLM are symmetric, declared primitives — kind-agnostic today, composable into bigger stitches tomorrow.',
    },
];

export function Differentiator() {
    return (
        <Section id="why-stitchapi" className="border-b border-fd-border">
            <SectionHeading
                eyebrow="Two empty quadrants"
                title="Built for the two quadrants nobody else covers"
                lead="tRPC-grade ergonomics for the APIs you don’t own — declared once, called like a local function. These are the two gaps every other approach leaves open."
                align="center"
            />

            <div className="mx-auto mt-12 grid max-w-4xl gap-5 sm:grid-cols-2">
                {quadrants.map(({ icon: Icon, title, body }) => (
                    <div
                        key={title}
                        className="rounded-2xl border border-fd-border bg-fd-card p-7"
                    >
                        <span className="inline-flex size-11 items-center justify-center rounded-xl bg-stitch-soft text-stitch">
                            <Icon className="size-5" />
                        </span>
                        <h3 className="mt-5 text-xl font-semibold text-fd-foreground">
                            {title}
                        </h3>
                        <p className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">
                            {body}
                        </p>
                    </div>
                ))}
            </div>
        </Section>
    );
}
