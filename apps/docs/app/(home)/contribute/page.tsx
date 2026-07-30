import { Eyebrow, GithubIcon } from '../components/primitives';

import {
    contributingUrl,
    issuesUrl,
    newIssueUrl,
    npmUrl,
    repoUrl,
    securityAdvisoryUrl,
    securityPolicyUrl,
} from '@/lib/shared';

import {
    ArrowRight,
    Bug,
    HeartHandshake,
    Package,
    ShieldAlert,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * The site's single answer to "how do I get this, tell you it's broken, or help?".
 *
 * Every path a visitor might want lives on one page rather than being inferred from a
 * GitHub icon in the nav: the project's feedback and contribution routes should be
 * discoverable from the website itself, not only by someone who already thought to go
 * looking in the repository.
 *
 * Deliberately no literal install command here. Install specs carry a dist-tag suffix
 * (`@rc` today, bare once 1.0.0 ships stable) and the docs site keeps those correct via
 * the remark-install-channel plugin, which only processes MDX — a hardcoded command in
 * a .tsx page would sit outside that guarantee and quietly go stale.
 */
export const metadata: Metadata = {
    title: 'Contribute',
    description:
        'How to install StitchAPI, report a bug, request a feature, disclose a security issue, and contribute code.',
    alternates: { canonical: '/contribute' },
};

const cardClass =
    'rounded-xl border border-fd-border bg-fd-card p-6 transition-colors hover:border-stitch/40';

const linkClass =
    'inline-flex items-center gap-1 font-medium text-stitch hover:text-stitch-strong';

export default function Page() {
    return (
        <main className="flex-1 px-6 py-[clamp(2rem,6vh,5rem)]">
            <div className="mx-auto w-full max-w-4xl">
                <Eyebrow>Get involved</Eyebrow>
                <h1 className="font-display mt-3 text-3xl font-black tracking-[-0.035em] text-fd-foreground lg:text-4xl">
                    Get it, report it, improve it
                </h1>
                <p className="mt-4 max-w-2xl text-lg leading-relaxed text-fd-muted-foreground">
                    StitchAPI is Apache-2.0 and developed in the open. Bug
                    reports and questions are as useful as pull requests — a
                    reproduction you can hand over is worth more than a patch
                    nobody can verify.
                </p>

                <div className="mt-10 grid gap-4 sm:grid-cols-2">
                    <section className={cardClass}>
                        <Package className="size-5 text-stitch" />
                        <h2 className="mt-3 font-semibold text-fd-foreground">
                            Get StitchAPI
                        </h2>
                        <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
                            Zero runtime dependencies, one package. The install
                            page has the current command for every package
                            manager.
                        </p>
                        <p className="mt-4 flex flex-col gap-2 text-sm">
                            <Link
                                href="/docs/getting-started/installation"
                                className={linkClass}
                            >
                                Installation
                                <ArrowRight className="size-3.5" />
                            </Link>
                            <a
                                href={npmUrl}
                                className={linkClass}
                                target="_blank"
                                rel="noreferrer"
                            >
                                View on npm
                            </a>
                        </p>
                    </section>

                    <section className={cardClass}>
                        <Bug className="size-5 text-stitch" />
                        <h2 className="mt-3 font-semibold text-fd-foreground">
                            Report a bug
                        </h2>
                        <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
                            Include the smallest definition that shows the
                            problem, the version, and the runtime — a good share
                            of bugs are runtime-specific, so &ldquo;works in
                            Node, fails in Workers&rdquo; is the useful part.
                        </p>
                        <p className="mt-4 flex flex-col gap-2 text-sm">
                            <a
                                href={newIssueUrl}
                                className={linkClass}
                                target="_blank"
                                rel="noreferrer"
                            >
                                Open an issue
                                <ArrowRight className="size-3.5" />
                            </a>
                            <a
                                href={issuesUrl}
                                className={linkClass}
                                target="_blank"
                                rel="noreferrer"
                            >
                                Search existing issues
                            </a>
                        </p>
                    </section>

                    <section className={cardClass}>
                        <HeartHandshake className="size-5 text-stitch" />
                        <h2 className="mt-3 font-semibold text-fd-foreground">
                            Contribute code
                        </h2>
                        <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
                            Pull requests target <code>main</code>. The
                            contributing guide covers the dev loop, the
                            tests-with-changes policy, and the bundle-size
                            budget — all enforced by CI, so the gate tells you
                            before a reviewer has to.
                        </p>
                        <p className="mt-4 text-sm">
                            <a
                                href={contributingUrl}
                                className={linkClass}
                                target="_blank"
                                rel="noreferrer"
                            >
                                Read CONTRIBUTING.md
                                <ArrowRight className="size-3.5" />
                            </a>
                        </p>
                    </section>

                    <section className={cardClass}>
                        <ShieldAlert className="size-5 text-stitch" />
                        <h2 className="mt-3 font-semibold text-fd-foreground">
                            Found a vulnerability?
                        </h2>
                        <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
                            Don&apos;t open a public issue — that discloses it
                            to everyone before a fix exists. Report it privately
                            and you&apos;ll get an acknowledgement within 48
                            hours.
                        </p>
                        <p className="mt-4 flex flex-col gap-2 text-sm">
                            <a
                                href={securityAdvisoryUrl}
                                className={linkClass}
                                target="_blank"
                                rel="noreferrer"
                            >
                                Report privately
                                <ArrowRight className="size-3.5" />
                            </a>
                            <a
                                href={securityPolicyUrl}
                                className={linkClass}
                                target="_blank"
                                rel="noreferrer"
                            >
                                Security policy and scope
                            </a>
                        </p>
                    </section>
                </div>

                <p className="mt-8 text-sm text-fd-muted-foreground">
                    Not sure it&apos;s a bug?{' '}
                    <Link href="/playground" className={linkClass}>
                        Reproduce it in the playground
                        <ArrowRight className="size-3.5" />
                    </Link>{' '}
                    and paste the link into the issue — it runs the real library
                    in your browser.
                </p>

                <p className="mt-10 flex items-center gap-2 text-sm text-fd-muted-foreground">
                    <GithubIcon className="size-4" />
                    Everything happens in the open at{' '}
                    <a
                        href={repoUrl}
                        className={linkClass}
                        target="_blank"
                        rel="noreferrer"
                    >
                        rejifald/StitchAPI
                    </a>
                </p>
            </div>
        </main>
    );
}
