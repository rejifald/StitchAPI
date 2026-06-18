import { BrandBackdrop } from './brand-backdrop';
import { Code, CodePanel } from './code-panel';
import { PrimaryButton, SecondaryButton } from './primitives';
import { Tagline } from './tagline';

import { ArrowRight, Bot, Code2, Server, Terminal } from 'lucide-react';

const surfaces = [
    { icon: Code2, label: 'Function' },
    { icon: Terminal, label: 'CLI' },
    { icon: Server, label: 'HTTP' },
    { icon: Bot, label: 'MCP tool' },
];

export function Hero() {
    return (
        <section className="relative overflow-hidden border-b border-fd-border px-6 pt-20 pb-20 sm:pt-28 sm:pb-28">
            <BrandBackdrop variant="hero" />

            <div className="relative z-10 mx-auto grid w-full max-w-6xl items-center gap-14 lg:grid-cols-[1.05fr_1fr]">
                <div>
                    <span className="inline-flex items-center gap-2 rounded-full border border-stitch-border bg-stitch-soft px-3 py-1 text-xs font-medium text-stitch-strong">
                        <span className="size-1.5 rounded-full bg-stitch" />
                        Agent-native API runtime
                    </span>

                    <h1 className="mt-6 font-display text-4xl font-black leading-[1.02] tracking-[-0.035em] text-fd-foreground sm:text-6xl">
                        A typed <span className="text-stitch">stitch</span>{' '}
                        replaces{' '}
                        <code className="rounded-lg bg-fd-muted px-2 py-0.5 align-middle font-mono text-[0.7em] text-fd-muted-foreground">
                            fetch
                        </code>
                    </h1>

                    <p className="mt-6 max-w-xl text-lg leading-relaxed text-fd-muted-foreground">
                        StitchAPI turns one endpoint — or one example — into a
                        declarative, validated, observable unit of work. Define
                        it once; call it as a function, a CLI, an HTTP route, or
                        an MCP tool. Humans and agents get a{' '}
                        <span className="font-medium text-fd-foreground">
                            capability, not a credential
                        </span>
                        .
                    </p>

                    <Tagline />

                    <div className="mt-9 flex flex-wrap items-center gap-3">
                        <PrimaryButton href="/docs">
                            Read the docs
                            <ArrowRight className="size-4" />
                        </PrimaryButton>
                        <SecondaryButton href="/playground">
                            <Terminal className="size-4 text-stitch" />
                            Try the playground
                        </SecondaryButton>
                    </div>

                    <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
                        <span className="text-xs font-medium uppercase tracking-wider text-fd-muted-foreground">
                            One definition →
                        </span>
                        {surfaces.map(({ icon: Icon, label }) => (
                            <span
                                key={label}
                                className="inline-flex items-center gap-1.5 text-sm font-medium text-fd-foreground"
                            >
                                <Icon className="size-4 text-stitch" />
                                {label}
                            </span>
                        ))}
                    </div>
                </div>

                <CodePanel filename="websites.ts">
                    <Code>{`// Declare once — types, validation, retries, drift.
const listWebsites = stitch({
  path: '/api/websites',
  output: Website.array(),   // response contract → drift
  auth: session,             // capability, not a secret
  retry: { attempts: 3, on: [429, 503] },
});

// Call it — awaitable and streamable.
const sites = await listWebsites();

for await (const ev of listWebsites.stream()) {
  // start → progress → drift → result → done
}`}</Code>
                </CodePanel>
            </div>
        </section>
    );
}
