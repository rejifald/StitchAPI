'use client';

import { BrandBackdrop } from '@/app/(home)/components/brand-backdrop';
import { CodePanel } from '@/app/(home)/components/code-panel';
import { Logo } from '@/components/logo';
import { cn } from '@/lib/cn';

import { Check, Church, Coffee, Sunset } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * The hero streaming-demo scene (`docs/media/streaming-demo.{mp4,gif}`),
 * rebuilt on the site's own components and tokens: CodePanel, Logo,
 * BrandBackdrop, the Signal palette, and the site type stacks.
 *
 * Everything animated is a pure function of time: `render(t)` mutates
 * inline styles only, and `scripts/gen-streaming-demo.mjs` frame-steps it
 * via `window.__seek(t)` — no timers, no randomness, so re-rendering the
 * same t always produces the same frame and the exported assets are
 * reproducible from source. Live visitors get the same `render` driven by
 * a requestAnimationFrame loop instead (static end-state under
 * prefers-reduced-motion).
 *
 * URL params: `?layout=square` → 1080×1080 stacked variant for the social
 * crop; `?capture=1` → no self-running loop + CSS animations frozen, so
 * the frame-stepper is the only clock on the page.
 */

// ── timeline (seconds) ──────────────────────────────────────────────
const TOTAL = 6.4; // full loop
const BADGE_IN = 0.15; // "● streaming" fades in
const DONE_AT = 4.45; // stream completes → "✓ typed · validated"
const FADE_AT = 5.7; // content fades back to empty
const FADE_LEN = 0.35; // …over this long (then rest until TOTAL)

// Sentence streams in LLM-ish sub-word chunks, then rows land one by
// one. Fixed schedule — same frames every render.
const CHUNKS: [string, number][] = [
    ['Your', 0.35],
    [' 3', 0.53],
    ['-stop', 0.68],
    [' day', 0.86],
    [' in', 1.02],
    [' Ky', 1.2],
    ['iv', 1.34],
    [':', 1.5],
];

const ROWS = [
    { at: 2.05, icon: Coffee, when: '09:00', what: 'Coffee at Podil' },
    { at: 2.85, icon: Church, when: '12:30', what: 'Saint Sophia Cathedral' },
    { at: 3.65, icon: Sunset, when: '19:00', what: 'Sunset over the Dnipro' },
];

// Real usage — mirrors the `useStitchStream` JSDoc example in
// packages/react/src/index.ts. If that API changes, update this and
// regenerate the assets (`pnpm gen:media`).
const SNIPPET = `const chat = stitch({
  path: 'https://api.example.com/chat',
  output: Reply,
});

const { chunks, isStreaming } =
  useStitchStream(chat, {
    body: { prompt },
  });`;

declare global {
    interface Window {
        __seek?: (t: number) => void;
        __TOTAL?: number;
    }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const easeOutBack = (p: number) => {
    const c = 1.70158;
    return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};

type Mode = { layout: 'wide' | 'square'; capture: boolean };

export function StreamingScene() {
    const [mode, setMode] = useState<Mode | null>(null);

    const streamBadge = useRef<HTMLSpanElement>(null);
    const doneBadge = useRef<HTMLSpanElement>(null);
    const pulse = useRef<HTMLSpanElement>(null);
    const sentence = useRef<HTMLSpanElement>(null);
    const caret = useRef<HTMLSpanElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setMode({
            layout: params.get('layout') === 'square' ? 'square' : 'wide',
            capture: params.has('capture'),
        });
    }, []);

    useEffect(() => {
        if (!mode) return;

        const render = (tAbs: number) => {
            const t = ((tAbs % TOTAL) + TOTAL) % TOTAL;
            const streaming = t < DONE_AT;
            const fade = 1 - clamp01((t - FADE_AT) / FADE_LEN);

            // badge: in → pulsing brand pill → accent "✓" pop → fades out
            const badgeIn = clamp01((t - BADGE_IN) / 0.25);
            if (streamBadge.current && doneBadge.current && pulse.current) {
                streamBadge.current.style.display = streaming
                    ? 'inline-flex'
                    : 'none';
                doneBadge.current.style.display = streaming
                    ? 'none'
                    : 'inline-flex';
                if (streaming) {
                    streamBadge.current.style.opacity = String(badgeIn * fade);
                    const ph = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.3 * t);
                    pulse.current.style.opacity = String(0.45 + 0.55 * ph);
                    pulse.current.style.transform = `scale(${0.8 + 0.35 * ph})`;
                } else {
                    doneBadge.current.style.opacity = String(fade);
                    const pop = clamp01((t - DONE_AT) / 0.3);
                    doneBadge.current.style.transform = `scale(${0.8 + 0.2 * easeOutBack(pop)})`;
                }
            }

            // sentence: chunks whose time has passed; caret blinks while
            // streaming, gone once done
            if (sentence.current) {
                let text = '';
                for (const [chunk, at] of CHUNKS) if (t >= at) text += chunk;
                sentence.current.textContent = text;
            }
            if (caret.current) {
                const blink = Math.sin(2 * Math.PI * 2 * t) > 0 ? 1 : 0.15;
                caret.current.style.opacity = String(
                    streaming && t >= BADGE_IN ? blink : 0,
                );
            }

            // rows: slide-up + fade, one by one
            rowRefs.current.forEach((el, i) => {
                if (!el) return;
                const p = easeOut(clamp01((t - ROWS[i].at) / 0.3));
                el.style.opacity = String(p);
                el.style.transform = `translateY(${16 * (1 - p)}px)`;
            });

            // loop-close: everything fades back to the empty panel
            if (content.current) content.current.style.opacity = String(fade);
        };

        window.__TOTAL = TOTAL;
        window.__seek = render;
        render(0);

        if (mode.capture) return; // the frame-stepper is the only clock
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            render(DONE_AT + 0.6); // static completed state
            return;
        }
        const t0 = performance.now();
        let raf = requestAnimationFrame(function loop() {
            render((performance.now() - t0) / 1000);
            raf = requestAnimationFrame(loop);
        });
        return () => cancelAnimationFrame(raf);
    }, [mode]);

    if (!mode) return null;
    const square = mode.layout === 'square';

    return (
        <div
            className={cn(
                'fixed inset-0 z-[60] flex flex-col overflow-hidden bg-fd-background',
                square ? 'px-12 pt-10 pb-12' : 'px-11 pt-8 pb-10',
            )}
        >
            {mode.capture && (
                // Freeze decorative CSS animation (BrandBackdrop's breathing
                // rings) so frame-stepping is deterministic, and hide the
                // Next.js dev-tools indicator so it can't leak into frames.
                <style>{`*, *::before, *::after { animation-play-state: paused !important; transition: none !important; } nextjs-portal { display: none !important; }`}</style>
            )}
            <BrandBackdrop variant="hero" />

            <div className="relative z-10 mb-8 flex items-center">
                <Logo className="origin-left scale-[1.7]" />
                <span className="ml-auto text-[17px] text-fd-muted-foreground">
                    the streaming-first API client
                </span>
            </div>

            <div
                className={cn(
                    'relative z-10 flex min-h-0 flex-1 gap-6',
                    square && 'flex-col',
                )}
            >
                <div
                    className={cn(
                        'flex flex-col justify-center',
                        !square && 'w-[45%]',
                    )}
                >
                    <CodePanel
                        filename="chat.ts"
                        code={SNIPPET}
                        className="[&_pre]:px-7 [&_pre]:py-6 [&_pre]:text-[19px] [&_pre]:leading-[1.65]"
                    />
                </div>

                <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-fd-border bg-fd-card p-7 shadow-lg">
                    <div className="flex items-center">
                        <span className="text-[15px] font-semibold tracking-[0.14em] text-fd-muted-foreground uppercase">
                            Response
                        </span>
                        <div className="ml-auto grid *:col-start-1 *:row-start-1 *:justify-self-end">
                            <span
                                ref={streamBadge}
                                className="inline-flex items-center gap-2 rounded-full border border-stitch-border bg-stitch-soft px-4 py-1.5 text-[15px] font-medium text-stitch-strong"
                                style={{ opacity: 0 }}
                            >
                                <span
                                    ref={pulse}
                                    className="size-2.5 rounded-full bg-stitch"
                                />
                                streaming
                            </span>
                            <span
                                ref={doneBadge}
                                className="inline-flex items-center gap-1.5 rounded-full border border-accent-line bg-accent-soft px-4 py-1.5 text-[15px] font-medium text-accent"
                                style={{ display: 'none' }}
                            >
                                <Check className="size-4" />
                                typed · validated
                            </span>
                        </div>
                    </div>

                    {/* static — ties the reply to `body: { prompt }` and keeps
                        the panel alive during the loop's empty phase */}
                    <div className="mt-6 self-start rounded-full border border-fd-border bg-fd-muted/40 px-4 py-1.5 text-[15px] text-fd-muted-foreground">
                        prompt ·{' '}
                        <span className="font-medium text-fd-foreground">
                            “Plan my day in Kyiv”
                        </span>
                    </div>

                    <div ref={content}>
                        <div className="mt-6 min-h-[40px] text-[26px] font-medium tracking-[-0.02em] text-fd-foreground">
                            <span ref={sentence} />
                            <span
                                ref={caret}
                                className="ml-1 inline-block h-[26px] w-[11px] translate-y-[3px] rounded-[3px] bg-stitch"
                                style={{ opacity: 0 }}
                            />
                        </div>
                        <div className="mt-7 flex flex-col gap-4">
                            {ROWS.map((row, i) => (
                                <div
                                    key={row.what}
                                    ref={(el) => {
                                        rowRefs.current[i] = el;
                                    }}
                                    className="flex items-center gap-4 rounded-xl border border-fd-border bg-fd-muted/40 px-5 py-4"
                                    style={{ opacity: 0 }}
                                >
                                    <span className="flex size-11 items-center justify-center rounded-lg bg-stitch-soft text-stitch">
                                        <row.icon className="size-[22px]" />
                                    </span>
                                    <span className="w-[72px] font-mono text-[16px] text-fd-muted-foreground">
                                        {row.when}
                                    </span>
                                    <span className="text-[20px] font-medium whitespace-nowrap text-fd-foreground">
                                        {row.what}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
