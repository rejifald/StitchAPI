import { BrandBackdrop } from './brand-backdrop';
import { PrimaryButton } from './primitives';

import { gitConfig } from '@/lib/shared';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

export function Cta() {
    return (
        <section className="relative overflow-hidden border-b border-fd-border px-6 py-24 text-center">
            <BrandBackdrop variant="cta" />
            <div className="relative z-10 mx-auto max-w-2xl">
                <h2 className="font-display text-3xl font-extrabold tracking-[-0.02em] text-fd-foreground sm:text-4xl">
                    Replace fetch. Start with one endpoint.
                </h2>
                <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-fd-muted-foreground">
                    Declare your first stitch and call it as a typed function in
                    five minutes — then reach the same definition from the CLI,
                    HTTP, or an agent.
                </p>
                <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                    <PrimaryButton href="/docs/getting-started/quickstart">
                        Start the quickstart
                        <ArrowRight className="size-4" />
                    </PrimaryButton>
                </div>
            </div>
        </section>
    );
}

export function Footer() {
    return (
        <footer className="px-6 py-10">
            <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-4 text-sm text-fd-muted-foreground sm:flex-row">
                <span>
                    <span className="font-semibold text-fd-foreground">
                        StitchAPI
                    </span>{' '}
                    — a typed stitch replaces fetch.
                </span>
                <div className="flex items-center gap-5">
                    <Link
                        href="/docs"
                        className="transition-colors hover:text-fd-foreground"
                    >
                        Docs
                    </Link>
                    <a
                        href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
                        target="_blank"
                        rel="noreferrer"
                        className="transition-colors hover:text-fd-foreground"
                    >
                        GitHub
                    </a>
                    <Link
                        href="/docs/reference/stitch"
                        className="transition-colors hover:text-fd-foreground"
                    >
                        Reference
                    </Link>
                </div>
            </div>
        </footer>
    );
}
