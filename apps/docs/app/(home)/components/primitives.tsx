import { cn } from '@/lib/cn';

import Link from 'next/link';
import type { ReactNode } from 'react';

export function Section({
    id,
    className,
    children,
}: {
    id?: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <section id={id} className={cn('px-6 py-20 sm:py-24', className)}>
            <div className="mx-auto w-full max-w-5xl">{children}</div>
        </section>
    );
}

export function Eyebrow({ children }: { children: ReactNode }) {
    return (
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-stitch">
            {children}
        </span>
    );
}

export function SectionHeading({
    eyebrow,
    title,
    lead,
    align = 'left',
}: {
    eyebrow?: ReactNode;
    title: ReactNode;
    lead?: ReactNode;
    align?: 'left' | 'center';
}) {
    return (
        <div
            className={cn(
                'max-w-2xl',
                align === 'center' && 'mx-auto text-center',
            )}
        >
            {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
            <h2 className="mt-3 font-display text-3xl font-extrabold tracking-[-0.02em] text-fd-foreground sm:text-4xl">
                {title}
            </h2>
            {lead ? (
                <p className="mt-4 text-lg leading-relaxed text-fd-muted-foreground">
                    {lead}
                </p>
            ) : null}
        </div>
    );
}

export function GithubIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            className={cn('size-4', className)}
        >
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
        </svg>
    );
}

export function NpmIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            className={cn('size-4', className)}
        >
            <path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" />
        </svg>
    );
}

const buttonBase =
    'inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-colors';

export function PrimaryButton({
    href,
    children,
    className,
}: {
    href: string;
    children: ReactNode;
    className?: string;
}) {
    return (
        <Link
            href={href}
            className={cn(
                buttonBase,
                'bg-stitch text-white shadow-sm hover:bg-stitch-strong dark:text-fd-background',
                className,
            )}
        >
            {children}
        </Link>
    );
}

export function SecondaryButton({
    href,
    children,
    className,
    external,
}: {
    href: string;
    children: ReactNode;
    className?: string;
    external?: boolean;
}) {
    return (
        <Link
            href={href}
            {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
            className={cn(
                buttonBase,
                'border border-fd-border bg-fd-card text-fd-foreground hover:bg-fd-accent',
                className,
            )}
        >
            {children}
        </Link>
    );
}
