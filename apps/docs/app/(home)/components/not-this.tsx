import { Section, SectionHeading } from './primitives';

import { X } from 'lucide-react';

const nots: { title: string; body: string }[] = [
    {
        title: 'Not an HTTP client or fetch replacement',
        body: 'fetch and axios are the substrate underneath — bring your own adapter. A stitch sits above the transport and turns an endpoint into a function; it never reimplements the call.',
    },
    {
        title: 'Not a code generator',
        body: "There's no SDK to commit, diff, and regenerate. The declaration is the runtime, validated live on every call — so it can't fall out of date with the API.",
    },
    {
        title: 'Not spec-first',
        body: 'No OpenAPI document required. A URL and one example response is enough — so it reaches the internal and undocumented long tail codegen never covers.',
    },
    {
        title: 'Not a server to deploy',
        body: "Nothing to run or operate, and you don't own both ends. It's a zero-dependency library you import — for the APIs you don't control.",
    },
    {
        title: 'Not a workflow engine or iPaaS',
        body: 'No orchestration, queues, or visual builder. Composition is plain TypeScript; the stitch is the boundary and nothing more.',
    },
    {
        title: 'No config files or hidden inheritance',
        body: 'Nothing ambient or global a stitch silently reads — everything that shapes a call is composed in explicitly. Read one stitch and you know exactly what it does.',
    },
];

export function NotThis() {
    return (
        <Section
            id="not-this"
            className="border-b border-fd-border bg-fd-muted/30"
        >
            <SectionHeading
                eyebrow="Scope"
                title="What StitchAPI is not"
                lead="Knowing what a tool refuses to be is how you trust what it is. StitchAPI holds a hard line on scope."
                align="center"
            />

            <div className="mx-auto mt-12 grid max-w-5xl gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {nots.map(({ title, body }) => (
                    <div
                        key={title}
                        className="rounded-2xl border border-fd-border bg-fd-card p-6"
                    >
                        <span className="inline-flex size-9 items-center justify-center rounded-lg bg-fd-muted text-fd-muted-foreground">
                            <X className="size-5" />
                        </span>
                        <h3 className="mt-4 text-base font-semibold text-fd-foreground">
                            {title}
                        </h3>
                        <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
                            {body}
                        </p>
                    </div>
                ))}
            </div>

            <p className="mx-auto mt-10 max-w-3xl text-center text-base font-medium text-fd-foreground">
                No server, no codegen, no config files, no implicit inheritance
                —{' '}
                <span className="text-stitch">only explicit composition.</span>
            </p>
        </Section>
    );
}
