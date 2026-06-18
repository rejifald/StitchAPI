import { BrandBackdrop } from './brand-backdrop';
import { Code, CodePanel } from './code-panel';
import { PrimaryButton, SecondaryButton } from './primitives';
import { Tagline } from './tagline';

import {
    ArrowRight,
    CloudOff,
    FileCog,
    Globe,
    Hammer,
    Package,
    Terminal,
} from 'lucide-react';

const simplicity = [
    { icon: CloudOff, label: 'No infra' },
    { icon: FileCog, label: 'No config files' },
    { icon: Hammer, label: 'No scaffolding' },
    { icon: Package, label: 'Zero deps' },
    { icon: Globe, label: 'Runs everywhere' },
];

export function Hero() {
    return (
        <section className="relative overflow-hidden border-b border-fd-border px-6 pt-20 pb-20 sm:pt-28 sm:pb-28">
            <BrandBackdrop variant="hero" />

            <div className="relative z-10 mx-auto grid w-full max-w-6xl items-center gap-14 lg:grid-cols-[1.05fr_1fr]">
                <div>
                    <span className="inline-flex items-center gap-2 rounded-full border border-stitch-border bg-stitch-soft px-3 py-1 text-xs font-medium text-stitch-strong">
                        <span className="size-1.5 rounded-full bg-stitch" />
                        Agent-native
                    </span>

                    <h1 className="mt-6 font-display text-4xl font-black leading-[1.02] tracking-[-0.035em] text-fd-foreground sm:text-6xl">
                        Turn any API into a typed,{' '}
                        <span className="text-stitch">resilient function</span>
                    </h1>

                    <p className="mt-6 max-w-xl text-lg leading-relaxed text-fd-muted-foreground">
                        Declare one endpoint — or one example — and call it like
                        a local function, with types, validation, retries, and
                        drift folded into the call. The same definition runs
                        from the CLI, an HTTP route, or as an MCP tool — and
                        humans and agents alike get a{' '}
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
                        {simplicity.map(({ icon: Icon, label }) => (
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

                <CodePanel filename="users.ts">
                    <Code>{`// Declare once — types, validation, resilience.
const getUser = stitch({
  path: 'https://api.example.com/users/{id}',
  output: User, // validator of your choice
  retry: 3,
  timeout: '5s',
  cache: '1m',
});

// Call it like a local function.
const user = await getUser({ params: { id: '42' } });
// → typed · validated · retried · cached`}</Code>
                </CodePanel>
            </div>
        </section>
    );
}
