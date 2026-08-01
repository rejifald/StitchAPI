import { BrandBackdrop } from './brand-backdrop';
import { CodePanel } from './code-panel';
import { PrimaryButton, SecondaryButton } from './primitives';
import { Reel } from './reel';

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

// The headline runs two drum reels on two stacked lines: the API KIND it
// stitches (4 items → `reel-spin-4`) and the QUALITY the resulting function
// gains (6 items → `reel-spin-6`). Each reel is the LAST token on its line, so
// the fixed-width window's slack falls at the (invisible) line end rather than
// opening a gap mid-phrase. Both are left-aligned (see global.css `.reel__item`);
// the kinds are noun phrases (no trailing "API" to gap against) and the quality
// is a predicate adjective, so the article never hits a vowel-initial word.
const API_KINDS = ['REST endpoint', 'GraphQL query', 'SSE stream', 'LLM call'];

const HERO_QUALITIES = [
    'typed',
    'validated',
    'resilient',
    'observable',
    'streamable',
    'composable',
];

export function Hero() {
    return (
        /* Vertical rhythm scales with the viewport height (clamped vh) rather
           than fixed breakpoints, so the hero stays compact on short laptops
           (no dead space up top, code panel not cropped) and breathes on tall
           displays — without being tuned to any one screen size. */
        <section className="relative overflow-hidden border-b border-fd-border px-6 pt-[clamp(2rem,6vh,6rem)] pb-[clamp(2.5rem,7vh,7rem)]">
            <BrandBackdrop variant="hero" />

            <div className="relative z-10 mx-auto w-full max-w-6xl">
                <span className="inline-flex items-center gap-2 rounded-full border border-stitch-border bg-stitch-soft px-3 py-1 text-xs font-medium text-stitch-strong">
                    <span className="size-1.5 rounded-full bg-stitch" />
                    Agent-native runtime
                </span>

                {/* Full-width headline. Each reel line is far wider than a grid
                    column, so the H1 spans the whole row above the two-column
                    body to stay at two lines. The large size kicks in only at
                    lg, where the full width has room; below that it steps down
                    so the line still fits without wrapping to a third row. */}
                <h1 className="mt-6 max-w-5xl font-display text-4xl font-black leading-[1.2] tracking-[-0.035em] text-fd-foreground lg:text-6xl">
                    {/* Animated headline — decorative; the static line below
                        carries a11y/SEO and the reduced-motion fallback. */}
                    <span aria-hidden="true" className="motion-reduce:hidden">
                        <span className="block">
                            Turn any{' '}
                            <Reel items={API_KINDS} className="text-stitch" />
                        </span>
                        <span className="block">
                            into a function that’s{' '}
                            <Reel
                                items={HERO_QUALITIES}
                                className="text-stitch"
                            />
                        </span>
                    </span>
                    {/* Read by screen readers always; shown when motion is reduced. */}
                    <span className="sr-only motion-reduce:not-sr-only">
                        Turn any REST, GraphQL, SSE, or LLM API into a typed,{' '}
                        <span className="text-stitch">resilient</span> function.
                    </span>
                </h1>

                <div className="mt-[clamp(1.25rem,4vh,3rem)] grid items-center gap-14 lg:grid-cols-[1.05fr_1fr]">
                    <div>
                        <p className="max-w-xl text-lg leading-relaxed text-fd-muted-foreground">
                            Declare an external API once; call it like a
                            function, the network out of sight. That same
                            definition is a tool an AI agent can call — and it
                            inherits the whole runtime: retries, streaming, and
                            responses trimmed to the fields that matter, so they
                            spend far fewer tokens — never the credential, only{' '}
                            <span className="font-medium text-fd-foreground">
                                the capability
                            </span>
                            .
                        </p>

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

                    <CodePanel
                        filename="users.ts"
                        code={`// [!code fold:start]
import { stitch } from 'stitchapi';
import { z } from 'zod';

const User = z.object({ id: z.string(), name: z.string() });

// [!code fold:end]
// Declare once — types, validation, resilience.
const getUser = stitch({
  path: 'https://api.example.com/users/{id}',
  output: User, // validator of your choice
  retry: 3,
  timeout: '5s',
  cache: '1m',
});

// Call it like a local function.
const user = await getUser({ params: { id: '42' } });
// → typed · validated · retried · cached`}
                    />
                </div>
            </div>
        </section>
    );
}
