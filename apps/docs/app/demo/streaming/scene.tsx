'use client';

import { BrandBackdrop } from '@/app/(home)/components/brand-backdrop';
import { CodePanel } from '@/app/(home)/components/code-panel';
import { Logo } from '@/components/logo';
import { cn } from '@/lib/cn';

import {
    Activity,
    Blocks,
    Bot,
    Box,
    Braces,
    Check,
    Church,
    CircleCheck,
    CircleX,
    Coffee,
    EyeOff,
    Fingerprint,
    Gauge,
    Globe,
    KeyRound,
    Layers,
    MessageSquare,
    Network,
    RefreshCw,
    RotateCw,
    Scissors,
    ShieldCheck,
    Sparkles,
    Sunset,
    TriangleAlert,
    Zap,
} from 'lucide-react';
import { type ComponentType, useEffect, useRef, useState } from 'react';

/**
 * The hero demo scene (`docs/media/streaming-demo*.{mp4,gif}`), built on
 * the site's own components and tokens: CodePanel, Logo, BrandBackdrop,
 * the Signal palette, and the site type stacks.
 *
 * The loop runs one CHAPTER per core feature — streaming-first,
 * validation + drift, data shaping, resilience, caching, auth,
 * observability, request styles, agent-native — each a code snippet on
 * the left and a live-filling result panel on the right, crossfaded in
 * sequence. Every snippet is real API usage (shapes match README.md and
 * the packages' JSDoc examples).
 *
 * Everything animated is a pure function of time: `render(t)` mutates
 * inline styles only, and `scripts/gen-streaming-demo.mjs` frame-steps it
 * via `window.__seek(t)` — no timers, no randomness, so re-rendering the
 * same t always produces the same frame and the exported assets are
 * reproducible from source. Live visitors get the same `render` driven by
 * a requestAnimationFrame loop instead (static end-state under
 * prefers-reduced-motion). Light/dark follow the site theme; the capture
 * script records both.
 *
 * URL params: `?layout=square` → 1080×1080 stacked variant for the social
 * crop; `?capture=1` → no self-running loop + CSS animations frozen +
 * the Next dev indicator hidden, so the frame-stepper is the only clock.
 */

type Tone = 'brand' | 'ok' | 'warn';

type Row = {
    at: number; // seconds into the chapter
    icon: ComponentType<{ className?: string }>;
    tone: Tone;
    text: string;
    mono?: boolean; // render `text` in the code face
    meta?: string; // right-aligned mono annotation
};

type Chapter = {
    key: string;
    label: string; // right-panel kicker
    filename: string;
    code: string;
    chip: string; // static context chip under the header
    chipMono?: boolean;
    lead?: [string, number][]; // token-by-token intro line (chunk, at)
    rows: Row[];
    doing: string; // in-flight badge text (brand pill, pulsing)
    done: string; // completed badge text (ok pill)
    doneAt: number;
    len: number; // chapter length incl. crossfades
};

const XFADE = 0.35; // chapter crossfade in/out

const CHAPTERS: Chapter[] = [
    {
        key: 'stream',
        label: 'Streaming-first',
        filename: 'chat.ts',
        // Mirrors the `useStitchStream` JSDoc example in
        // packages/react/src/index.ts.
        code: `const chat = stitch({
  path: 'https://api.example.com/chat',
  output: Reply,
});

const { chunks, isStreaming } =
  useStitchStream(chat, {
    body: { prompt },
  });`,
        chip: 'prompt · “Plan my day in Kyiv”',
        lead: [
            ['Your', 0.35],
            [' 3', 0.53],
            ['-stop', 0.68],
            [' day', 0.86],
            [' in', 1.02],
            [' Ky', 1.2],
            ['iv', 1.34],
            [':', 1.5],
        ],
        rows: [
            {
                at: 1.9,
                icon: Coffee,
                tone: 'brand',
                text: 'Coffee at Podil',
                meta: '09:00',
            },
            {
                at: 2.6,
                icon: Church,
                tone: 'brand',
                text: 'Saint Sophia Cathedral',
                meta: '12:30',
            },
            {
                at: 3.3,
                icon: Sunset,
                tone: 'brand',
                text: 'Sunset over the Dnipro',
                meta: '19:00',
            },
        ],
        doing: 'streaming',
        done: 'typed · validated',
        doneAt: 4.1,
        len: 5.6,
    },
    {
        key: 'drift',
        label: 'Validation + drift',
        filename: 'user.ts',
        code: `const getUser = stitch({
  baseUrl: 'https://demo.stitchapi.dev',
  path: '/users/{id}',
  output: drift(User),
});

const user = await getUser({
  params: { id: '42' },
});`,
        chip: `await getUser({ params: { id: '42' } })`,
        chipMono: true,
        rows: [
            {
                at: 0.7,
                icon: Braces,
                tone: 'brand',
                text: `{ id: 42, name: 'Ada Lovelace' }`,
                mono: true,
                meta: '200 OK',
            },
            {
                at: 1.5,
                icon: ShieldCheck,
                tone: 'ok',
                text: 'output matches User',
                meta: 'typed',
            },
            {
                at: 2.3,
                icon: TriangleAlert,
                tone: 'warn',
                text: 'drift: meta.plan appeared',
                meta: 'info',
            },
        ],
        doing: 'validating',
        done: 'validated · drift logged',
        doneAt: 3.2,
        len: 4.8,
    },
    {
        key: 'unwrap',
        label: 'Data shaping',
        filename: 'unwrap.ts',
        // Mirrors the README hero example: unwrap peels the transport
        // envelope before validation, so callers get the value itself.
        code: `const getUser = stitch({
  baseUrl: 'https://demo.stitchapi.dev',
  path: '/users/{id}',
  output: User,
  unwrap: 'data', // peel the envelope
});

const user = await getUser({
  params: { id: '42' },
});`,
        chip: `unwrap: 'data'`,
        chipMono: true,
        rows: [
            {
                at: 0.7,
                icon: Box,
                tone: 'brand',
                text: '{ data: { … }, meta: { … } }',
                mono: true,
                meta: 'raw envelope',
            },
            {
                at: 1.6,
                icon: Scissors,
                tone: 'brand',
                text: 'envelope peeled before validation',
                meta: "unwrap: 'data'",
            },
            {
                at: 2.5,
                icon: Sparkles,
                tone: 'ok',
                text: 'callers see User, not plumbing',
                meta: 'clean shape',
            },
        ],
        doing: 'unwrapping',
        done: 'just the data',
        doneAt: 3.4,
        len: 5.0,
    },
    {
        key: 'resilience',
        label: 'Resilience',
        filename: 'orders.ts',
        code: `const listOrders = stitch({
  baseUrl: 'https://demo.stitchapi.dev',
  path: '/orders',
  retry: { attempts: 3, on: [429, 502] },
  throttle: { rate: '10/s' },
  timeout: '10s',
});`,
        chip: 'await listOrders()',
        chipMono: true,
        rows: [
            {
                at: 0.7,
                icon: CircleX,
                tone: 'warn',
                text: '502 Bad Gateway',
                meta: 'attempt 1',
            },
            {
                at: 1.6,
                icon: RotateCw,
                tone: 'warn',
                text: 'backing off 200 ms',
                meta: 'attempt 2',
            },
            {
                at: 2.5,
                icon: CircleCheck,
                tone: 'ok',
                text: '200 OK — 41 orders',
                meta: '184 ms',
            },
        ],
        doing: 'retrying',
        done: 'recovered',
        doneAt: 3.4,
        len: 5.0,
    },
    {
        key: 'cache',
        label: 'Caching',
        filename: 'news.ts',
        // Mirrors the README Caching example (announcements): derived,
        // principal-scoped keys; object form = { ttl, scope, vary }.
        code: `const listNews = stitch({
  baseUrl: 'https://demo.stitchapi.dev',
  path: '/announcements',
  output: z.array(Announcement),
  cache: { ttl: '1h', scope: 'app' },
});

await listNews(); // network
await listNews(); // cache — 0 ms`,
        chip: 'await listNews() × 2',
        chipMono: true,
        rows: [
            {
                at: 0.7,
                icon: Globe,
                tone: 'brand',
                text: 'GET /announcements — network',
                meta: 'MISS · 121 ms',
            },
            {
                at: 1.6,
                icon: Zap,
                tone: 'ok',
                text: 'same call — served from cache',
                meta: 'HIT · 0 ms',
            },
            {
                at: 2.5,
                icon: Fingerprint,
                tone: 'brand',
                text: 'key derived from the request',
                meta: 'scope: app',
            },
        ],
        doing: 'fetching',
        done: 'cached · 0 ms',
        doneAt: 3.4,
        len: 5.0,
    },
    {
        key: 'auth',
        label: 'Auth as a boundary',
        filename: 'order.ts',
        // Mirrors the README Auth example: header strategies (bearer/
        // apiKey/basic) + managed oauth2()/cookieSession lifecycles;
        // secrets resolve at call time via env().
        code: `const getOrder = stitch({
  baseUrl: 'https://demo.stitchapi.dev',
  path: '/orders/{id}',
  auth: bearer(env('API_TOKEN')),
});

// callers get data, never the secret
await getOrder({ params: { id: '7' } });`,
        chip: `auth: bearer(env('API_TOKEN'))`,
        chipMono: true,
        rows: [
            {
                at: 0.7,
                icon: KeyRound,
                tone: 'brand',
                text: 'Authorization: Bearer ••••••',
                mono: true,
                meta: 'resolved per call',
            },
            {
                at: 1.6,
                icon: ShieldCheck,
                tone: 'ok',
                text: 'capability, not credential',
                meta: 'no secret shared',
            },
            {
                at: 2.5,
                icon: RefreshCw,
                tone: 'brand',
                text: 'oauth2 / cookieSession auto-renew',
                meta: 'managed',
            },
        ],
        doing: 'authorizing',
        done: 'authorized',
        doneAt: 3.4,
        len: 5.0,
    },
    {
        key: 'trace',
        label: 'Observability',
        filename: 'trace.ts',
        // Mirrors the README Zero-infra observability section: per-stitch
        // trace sinks ('console' | fileSink | TraceSink), STITCH_TRACE_*
        // env opt-in, and the `stitch trace` JSONL summarizer.
        code: `const getUser = stitch({
  baseUrl: 'https://demo.stitchapi.dev',
  path: '/users/{id}',
  trace: 'console', // opt-in, per stitch
});

// or, without touching code:
// $ STITCH_TRACE_FILE=run.jsonl node app
// $ stitch trace run.jsonl — summary`,
        chip: '$ stitch trace run.jsonl',
        chipMono: true,
        rows: [
            {
                at: 0.7,
                icon: Activity,
                tone: 'brand',
                text: '124 runs · 3 retried · 1 drift',
                meta: 'run.jsonl',
            },
            {
                at: 1.6,
                icon: Gauge,
                tone: 'brand',
                text: 'p50 88 ms · p95 231 ms',
                meta: 'latency',
            },
            {
                at: 2.5,
                icon: EyeOff,
                tone: 'ok',
                text: 'secrets scrubbed at the sink',
                meta: 'no collector',
            },
        ],
        doing: 'tracing',
        done: 'zero infra',
        doneAt: 3.4,
        len: 5.0,
    },
    {
        key: 'styles',
        label: 'Any request style',
        filename: 'ask.ts',
        // Mirrors the llm() JSDoc example in packages/core/src/llm.ts;
        // the surfaces list matches the README Surfaces table.
        code: `const ask = llm({
  provider: anthropic,
  model: 'claude-opus-4-8',
});

const { text } = await ask({
  body: { messages },
});

// graphql · sse · shell · download —
// same engine, same guarantees`,
        chip: `import { llm } from 'stitchapi/llm'`,
        chipMono: true,
        rows: [
            {
                at: 0.7,
                icon: MessageSquare,
                tone: 'brand',
                text: 'llm → { text, usage }',
                mono: true,
                meta: 'normalized',
            },
            {
                at: 1.6,
                icon: Network,
                tone: 'brand',
                text: 'graphql → data · sse → events',
                meta: 'peer surfaces',
            },
            {
                at: 2.5,
                icon: Blocks,
                tone: 'ok',
                text: 'retry · auth · validation compose',
                meta: 'one engine',
            },
        ],
        doing: 'generating',
        done: '8 styles, one engine',
        doneAt: 3.4,
        len: 5.0,
    },
    {
        key: 'agent',
        label: 'Agent-native',
        filename: 'agent.ts',
        code: `// One definition, four front doors
const listUsers = stitch({
  baseUrl: 'https://demo.stitchapi.dev',
  path: '/users',
  output: z.array(User),
});

await listUsers(); // in-process
// $ stitch run list-users — CLI
// $ stitch mcp — agent tool`,
        chip: '$ stitch mcp',
        chipMono: true,
        rows: [
            {
                at: 0.7,
                icon: Bot,
                tone: 'brand',
                text: 'agent writes: listUsers()',
                meta: 'run_stitch',
            },
            {
                at: 1.5,
                icon: Braces,
                tone: 'brand',
                text: '3 users — typed, trimmed',
                meta: '218 ms',
            },
            {
                at: 2.3,
                icon: Layers,
                tone: 'ok',
                text: 'context stays flat as tools grow',
                meta: 'code-mode',
            },
        ],
        doing: 'tool call',
        done: 'typed result',
        doneAt: 3.2,
        len: 4.8,
    },
];

// Chapter starts/total for a (possibly ?chapters=-filtered) sequence.
function timelineOf(chapters: Chapter[]) {
    const starts: number[] = [];
    let acc = 0;
    for (const ch of chapters) {
        starts.push(acc);
        acc += ch.len;
    }
    return { starts, total: acc };
}

const TONE_ICON: Record<Tone, string> = {
    brand: 'bg-stitch-soft text-stitch',
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-accent-soft text-accent',
};

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

type Mode = {
    layout: 'wide' | 'square';
    capture: boolean;
    // ?chapters=stream,agent — subset of chapter keys to run (the GIF is
    // captured from a shorter marquee cut so it stays under its budget).
    chapters: string[] | null;
};

export function StreamingScene() {
    const [mode, setMode] = useState<Mode | null>(null);
    const els = useRef<Record<string, HTMLElement | null>>({});
    const set = (key: string) => (el: HTMLElement | null) => {
        els.current[key] = el;
    };

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const chapters = params.get('chapters');
        setMode({
            layout: params.get('layout') === 'square' ? 'square' : 'wide',
            capture: params.has('capture'),
            chapters: chapters ? chapters.split(',') : null,
        });
    }, []);

    useEffect(() => {
        if (!mode) return;
        const el = (key: string) => els.current[key];
        const sel = mode.chapters;
        const active = sel
            ? CHAPTERS.filter((c) => sel.includes(c.key))
            : CHAPTERS;
        const { starts, total } = timelineOf(active);

        const render = (tAbs: number) => {
            const t = ((tAbs % total) + total) % total;
            let ci = 0;
            for (let i = 0; i < active.length; i++) if (t >= starts[i]) ci = i;
            const ch = active[ci];
            const lt = t - starts[ci];
            const fade =
                clamp01(lt / XFADE) *
                // The out-fade lands at 0 a beat BEFORE the chapter boundary
                // (not exactly on it), so the frame grid can't leave a ghost
                // of the outgoing chapter on the loop's last frame.
                (1 - clamp01((lt - (ch.len - XFADE - 0.1)) / XFADE));

            active.forEach((chapter, i) => {
                const k = chapter.key;
                const op = i === ci ? String(fade) : '0';
                const code = el(`code-${k}`);
                const panel = el(`panel-${k}`);
                if (code) code.style.opacity = op;
                if (panel) panel.style.opacity = op;
                const dot = el(`dot-${k}`);
                if (dot) {
                    dot.style.opacity = i === ci ? '1' : '0.3';
                    dot.style.transform = i === ci ? 'scale(1.3)' : 'scale(1)';
                }

                if (i !== ci) return;
                const streaming = lt < chapter.doneAt;

                // badge: pulsing brand pill → ok pill with a pop
                const doing = el(`doing-${k}`);
                const done = el(`done-${k}`);
                const pulse = el(`pulse-${k}`);
                if (doing && done && pulse) {
                    doing.style.display = streaming ? 'inline-flex' : 'none';
                    done.style.display = streaming ? 'none' : 'inline-flex';
                    if (streaming) {
                        doing.style.opacity = String(
                            clamp01((lt - 0.15) / 0.25),
                        );
                        const ph = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.3 * lt);
                        pulse.style.opacity = String(0.45 + 0.55 * ph);
                        pulse.style.transform = `scale(${0.8 + 0.35 * ph})`;
                    } else {
                        const pop = clamp01((lt - chapter.doneAt) / 0.3);
                        done.style.transform = `scale(${0.8 + 0.2 * easeOutBack(pop)})`;
                    }
                }

                // lead line: chunks whose time has passed + blinking caret
                if (chapter.lead) {
                    const lead = el(`lead-${k}`);
                    const caret = el(`caret-${k}`);
                    if (lead) {
                        let text = '';
                        for (const [chunk, at] of chapter.lead)
                            if (lt >= at) text += chunk;
                        lead.textContent = text;
                    }
                    if (caret) {
                        const blink =
                            Math.sin(2 * Math.PI * 2 * lt) > 0 ? 1 : 0.15;
                        caret.style.opacity = String(
                            streaming && lt >= 0.15 ? blink : 0,
                        );
                    }
                }

                // rows: slide-up + fade, one by one
                chapter.rows.forEach((row, j) => {
                    const rowEl = el(`row-${k}-${j}`);
                    if (!rowEl) return;
                    const p = easeOut(clamp01((lt - row.at) / 0.3));
                    rowEl.style.opacity = String(p);
                    rowEl.style.transform = `translateY(${16 * (1 - p)}px)`;
                });
            });
        };

        window.__TOTAL = total;
        window.__seek = render;
        render(0);

        if (mode.capture) return; // the frame-stepper is the only clock
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            render(active[0].doneAt + 0.6); // static completed state
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
    const selected = mode.chapters;
    const active = selected
        ? CHAPTERS.filter((c) => selected.includes(c.key))
        : CHAPTERS;

    return (
        <div
            className={cn(
                'fixed inset-0 z-[60] flex flex-col overflow-hidden bg-fd-background',
                square ? 'px-12 pt-10 pb-10' : 'px-11 pt-8 pb-8',
            )}
        >
            {mode.capture && (
                // Freeze decorative CSS animation (BrandBackdrop's breathing
                // rings) so frame-stepping is deterministic, and hide the
                // Next.js dev-tools indicator so it can't leak into frames.
                <style>{`*, *::before, *::after { animation-play-state: paused !important; transition: none !important; } nextjs-portal { display: none !important; }`}</style>
            )}
            <BrandBackdrop variant="hero" />

            <div className="relative z-10 mb-7 flex items-center">
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
                    className={cn('relative', square ? 'h-[420px]' : 'w-[45%]')}
                >
                    {active.map((ch, i) => (
                        <div
                            key={ch.key}
                            ref={set(`code-${ch.key}`)}
                            className="absolute inset-0 flex flex-col justify-center"
                            style={{ opacity: i === 0 ? 1 : 0 }}
                        >
                            <CodePanel
                                filename={ch.filename}
                                code={ch.code}
                                className="[&_pre]:px-7 [&_pre]:py-6 [&_pre]:text-[19px] [&_pre]:leading-[1.6]"
                            />
                        </div>
                    ))}
                </div>

                <div className="relative min-h-0 flex-1">
                    {active.map((ch, i) => (
                        <div
                            key={ch.key}
                            ref={set(`panel-${ch.key}`)}
                            className="absolute inset-0 flex flex-col rounded-xl border border-fd-border bg-fd-card p-7 shadow-lg"
                            style={{ opacity: i === 0 ? 1 : 0 }}
                        >
                            <div className="flex items-center">
                                <span className="text-[15px] font-semibold tracking-[0.14em] text-fd-muted-foreground uppercase">
                                    {ch.label}
                                </span>
                                <div className="ml-auto grid *:col-start-1 *:row-start-1 *:justify-self-end">
                                    <span
                                        ref={set(`doing-${ch.key}`)}
                                        className="inline-flex items-center gap-2 rounded-full border border-stitch-border bg-stitch-soft px-4 py-1.5 text-[15px] font-medium text-stitch-strong"
                                        style={{ opacity: 0 }}
                                    >
                                        <span
                                            ref={set(`pulse-${ch.key}`)}
                                            className="size-2.5 rounded-full bg-stitch"
                                        />
                                        {ch.doing}
                                    </span>
                                    <span
                                        ref={set(`done-${ch.key}`)}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-ok-line bg-ok-soft px-4 py-1.5 text-[15px] font-medium text-ok"
                                        style={{ display: 'none' }}
                                    >
                                        <Check className="size-4" />
                                        {ch.done}
                                    </span>
                                </div>
                            </div>

                            <div
                                className={cn(
                                    'mt-6 self-start rounded-full border border-fd-border bg-fd-muted/40 px-4 py-1.5 text-[15px] text-fd-muted-foreground',
                                    ch.chipMono && 'font-mono text-[14px]',
                                )}
                            >
                                {ch.chip}
                            </div>

                            {ch.lead && (
                                <div className="mt-6 min-h-[38px] text-[25px] font-medium tracking-[-0.02em] text-fd-foreground">
                                    <span ref={set(`lead-${ch.key}`)} />
                                    <span
                                        ref={set(`caret-${ch.key}`)}
                                        className="ml-1 inline-block h-[25px] w-[11px] translate-y-[3px] rounded-[3px] bg-stitch"
                                        style={{ opacity: 0 }}
                                    />
                                </div>
                            )}

                            <div className="mt-6 flex flex-col gap-3.5">
                                {ch.rows.map((row, j) => (
                                    <div
                                        key={row.text}
                                        ref={set(`row-${ch.key}-${j}`)}
                                        className="flex items-center gap-4 rounded-xl border border-fd-border bg-fd-muted/40 px-5 py-3.5"
                                        style={{ opacity: 0 }}
                                    >
                                        <span
                                            className={cn(
                                                'flex size-10 shrink-0 items-center justify-center rounded-lg',
                                                TONE_ICON[row.tone],
                                            )}
                                        >
                                            <row.icon className="size-5" />
                                        </span>
                                        <span
                                            className={cn(
                                                'font-medium whitespace-nowrap text-fd-foreground',
                                                row.mono
                                                    ? 'font-mono text-[17px]'
                                                    : 'text-[19px]',
                                            )}
                                        >
                                            {row.text}
                                        </span>
                                        {row.meta && (
                                            <span className="ml-auto font-mono text-[14px] whitespace-nowrap text-fd-muted-foreground">
                                                {row.meta}
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div className="relative z-10 mt-5 flex justify-center gap-2.5">
                {active.map((ch, i) => (
                    <span
                        key={ch.key}
                        ref={set(`dot-${ch.key}`)}
                        className="size-2 rounded-full bg-stitch"
                        style={{ opacity: i === 0 ? 1 : 0.3 }}
                    />
                ))}
            </div>
        </div>
    );
}
