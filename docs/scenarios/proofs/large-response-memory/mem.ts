// The measurement kit. Heap numbers are the whole evidence in this scenario, so the methodology has
// to be stated in code, not just in prose.
//
// TWO numbers are recorded per run, and they answer different questions:
//
//   1. `peakHeap`  — the high-water mark of `process.memoryUsage().heapUsed`, sampled. This is what
//      the OS-facing pressure looks like: it includes floating garbage the collector had not got to
//      yet. It is REAL (an allocation rate the GC cannot keep up with is exactly how a process dies)
//      but it is NOISY — it depends on when V8 chose to collect.
//
//   2. `peakLive`  — the high-water mark of `heapUsed` sampled IMMEDIATELY AFTER a forced full GC.
//      This is the RETAINED working set: bytes that are still reachable and therefore cannot be
//      collected under pressure. It is nearly noise-free and it is the number that decides whether a
//      workload scales. **Every verdict in this directory is based on `peakLive`**; `peakHeap` is
//      reported alongside as context.
//
// A forced GC costs real time on a large heap, so `mark()` (the GC-ing sample) is called ~10 times
// per run at workload seams, while `tick()` (the cheap sample) is called densely. `tick` alone would
// not be trustworthy: a `setInterval` sampler cannot preempt a synchronous `JSON.parse`, and an
// in-memory `ReadableStream` resolves its reads on the MICROtask queue, which starves timers
// entirely. So the workload calls `tick()`/`mark()` itself at points it knows are seams, and the
// interval sampler is a backstop rather than the mechanism.
//
// Requires `--expose-gc`. The scripts FAIL LOUDLY without it rather than silently reporting the
// noisy number as if it were the clean one.

/** Fail loudly when the process was not started with `--expose-gc`. */
export function requireGc(): () => void {
    const g = (globalThis as { gc?: () => void }).gc;
    if (typeof g !== 'function') {
        console.error(
            'FAIL — this script measures heap and needs a forced GC between phases.\n' +
                '       Re-run with --expose-gc, e.g.\n' +
                '         pnpm exec tsx --expose-gc <this-file>',
        );
        process.exit(2);
    }
    return g;
}

/** What the workload uses to sample itself. */
export interface Sampler {
    /** Cheap `heapUsed` sample — call densely (every N records). No GC. */
    tick(): void;
    /**
     * Forced-GC sample: collect, then read `heapUsed`. Returns the RETAINED bytes above baseline at
     * this instant. Call at workload seams (~10 per run) — it is not cheap.
     */
    mark(): number;
}

export interface Measurement {
    /** Bytes the fake vendor actually wrote to the wire. */
    wireBytes: number;
    /** Records the workload observed (deltas, array elements, rows — mode-dependent). */
    records: number;
    /** `heapUsed` after a full GC, before the workload started. */
    baseline: number;
    /** High-water `heapUsed` above baseline, INCLUDING floating garbage. Noisy. */
    peakHeap: number;
    /** High-water POST-GC `heapUsed` above baseline — the retained working set. The robust number. */
    peakLive: number;
    /**
     * High-water `arrayBuffers` above its own baseline. `heapUsed` counts the V8 heap ONLY, and a
     * `Uint8Array` off the socket lives in an external backing store — so a body sitting unread in a
     * `ReadableStream`'s internal queue is INVISIBLE to `heapUsed`. C6 turns on this distinction, so
     * it is measured rather than assumed.
     */
    peakBuffers: number;
    /** Retained bytes above baseline after the workload finished and its result went out of scope. */
    settled: number;
    /** `peakLive / wireBytes` — the multiplier the scenario is about. */
    ratio: number;
    /** How many cheap samples and forced-GC samples were taken. */
    ticks: number;
    marks: number;
    /** Wall-clock ms. */
    ms: number;
}

/**
 * Run `fn` under measurement. `fn` receives a {@link Sampler} and must return the number of records
 * it observed; `wire()` is read afterwards for the byte count the producer emitted.
 *
 * The result of `fn` is deliberately NOT returned — holding on to it would keep the workload's data
 * alive past the final GC and corrupt `settled`.
 */
export async function measure(
    fn: (s: Sampler) => Promise<number>,
    wire: () => number,
): Promise<Measurement> {
    const gc = requireGc();

    gc();
    gc(); // a second pass collects what the first one's finalizers freed
    const base = process.memoryUsage();
    const baseline = base.heapUsed;
    const baseBuffers = base.arrayBuffers;

    let peakHeap = 0;
    let peakLive = 0;
    let peakBuffers = 0;
    let ticks = 0;
    let marks = 0;

    /** One reading of both spaces. Returns the heap delta; records the buffer high-water too. */
    const read = (): number => {
        const m = process.memoryUsage();
        const b = m.arrayBuffers - baseBuffers;
        if (b > peakBuffers) peakBuffers = b;
        return m.heapUsed - baseline;
    };
    const tick = (): void => {
        ticks++;
        const d = read();
        if (d > peakHeap) peakHeap = d;
    };
    const mark = (): number => {
        marks++;
        gc();
        const d = read();
        if (d > peakLive) peakLive = d;
        if (d > peakHeap) peakHeap = d;
        return d;
    };

    // Backstop sampler. Only fires when the workload yields to the timer phase; the workload's own
    // `tick()` calls are what actually carry the measurement (see the header note).
    const timer = setInterval(tick, 1);
    timer.unref?.();

    const t0 = Date.now();
    let records: number;
    try {
        records = await fn({ tick, mark });
        mark(); // the mandatory final live sample, taken while the workload's result is still in scope
    } finally {
        clearInterval(timer);
    }
    const ms = Date.now() - t0;

    gc();
    gc();
    const settled = process.memoryUsage().heapUsed - baseline;
    const wireBytes = wire();

    return {
        wireBytes,
        records,
        baseline,
        peakHeap,
        peakLive,
        peakBuffers,
        settled,
        ratio: wireBytes === 0 ? 0 : peakLive / wireBytes,
        ticks,
        marks,
        ms,
    };
}
