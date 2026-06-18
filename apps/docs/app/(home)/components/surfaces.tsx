import { Section, SectionHeading } from './primitives';

import { ArrowUpRight, Bot, Code2, Server, Terminal } from 'lucide-react';
import Link from 'next/link';

const surfaces = [
    {
        icon: Code2,
        name: 'In-process function',
        href: '/docs/surfaces/function',
        snippet: "await getUser({ params: { id: '42' } })",
        body: 'Import the stitch and call it like any typed function — awaitable or streamable.',
    },
    {
        icon: Terminal,
        name: 'CLI command',
        href: '/docs/surfaces/cli',
        snippet: '$ stitch run getUser --id 42',
        body: 'Run the same definition from a shell or a script, no app boot required.',
    },
    {
        icon: Server,
        name: 'HTTP endpoint',
        href: '/docs/surfaces/http-serve',
        snippet: 'GET /get-user?id=42',
        body: 'Serve a stitch as a route — validated in, validated out, traced by default.',
    },
    {
        icon: Bot,
        name: 'MCP / agent tool',
        href: '/docs/surfaces/mcp',
        snippet: 'tool: get_user',
        body: 'Agents invoke it directly and receive a capability — never the underlying secret.',
    },
];

export function Surfaces() {
    return (
        <Section id="surfaces" className="border-b border-fd-border">
            <SectionHeading
                eyebrow="One definition, many surfaces"
                title="Define the stitch once. Reach it four ways."
                lead="The same typed unit is a function, a CLI command, an HTTP route, and an MCP tool — so humans and agents call exactly the same validated, observable thing."
            />

            <div className="mt-12 grid gap-4 sm:grid-cols-2">
                {surfaces.map(({ icon: Icon, name, href, snippet, body }) => (
                    <Link
                        key={name}
                        href={href}
                        className="group flex flex-col rounded-2xl border border-fd-border bg-fd-card p-6 transition-colors hover:border-stitch-border hover:bg-fd-accent"
                    >
                        <div className="flex items-center justify-between">
                            <span className="inline-flex size-10 items-center justify-center rounded-xl bg-stitch-soft text-stitch">
                                <Icon className="size-5" />
                            </span>
                            <ArrowUpRight className="size-5 text-fd-muted-foreground transition-colors group-hover:text-stitch" />
                        </div>
                        <h3 className="mt-5 text-lg font-semibold text-fd-foreground">
                            {name}
                        </h3>
                        <code className="mt-2 block font-mono text-sm text-stitch">
                            {snippet}
                        </code>
                        <p className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">
                            {body}
                        </p>
                    </Link>
                ))}
            </div>
        </Section>
    );
}
