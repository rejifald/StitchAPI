const metrics = [
    {
        value: '0',
        unit: 'runtime deps',
        body: 'Built on the platform’s global fetch — nothing to install, nothing to audit, nothing in your transitive tree.',
    },
    {
        value: '~25 kB',
        unit: 'min + gzip',
        body: 'The whole stitchapi entry, tree-shaken — and it is an enforced budget in CI, not an aspiration.',
    },
    {
        value: '~20 kB',
        unit: 'import { stitch }',
        body: 'Pay only for what you import: every surface beyond http lives behind its own subpath, so the core trims down.',
    },
];

export function Metrics() {
    return (
        <section className="border-b border-fd-border px-6 py-14">
            <div className="mx-auto w-full max-w-5xl">
                <div className="grid gap-px overflow-hidden rounded-2xl border border-fd-border bg-fd-border sm:grid-cols-3">
                    {metrics.map(({ value, unit, body }) => (
                        <div key={unit} className="bg-fd-card p-7">
                            <div className="flex items-baseline gap-2">
                                <span className="font-display text-4xl font-black tracking-[-0.03em] text-stitch">
                                    {value}
                                </span>
                                <span className="font-mono text-sm text-fd-muted-foreground">
                                    {unit}
                                </span>
                            </div>
                            <p className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">
                                {body}
                            </p>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
