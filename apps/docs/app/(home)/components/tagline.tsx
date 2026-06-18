import { Reel } from './reel';

/**
 * Hero tagline — two stacked "drums" that frame the core pitch: any transport
 * in (HTTP, GraphQL, shell, LLM) becomes one StitchAPI capability out, cycling
 * the qualities that capability gains (typed, validated, observable, …). The
 * sources read as code tokens (brand mono); the qualities read as emphasized
 * prose. A static sentence below carries the a11y text and the
 * prefers-reduced-motion fallback, listing every source and quality in full.
 */

const SOURCES = ['HTTP endpoint', 'GraphQL query', 'shell command', 'LLM call'];

const QUALITIES = [
    'typed',
    'validated',
    'observable',
    'resilient',
    'streamable',
    'declarative',
];

export function Tagline() {
    return (
        <div className="mt-7 text-lg font-medium leading-snug text-fd-muted-foreground sm:text-xl">
            {/* Animated — decorative; the static line below carries a11y. */}
            <p
                className="flex flex-wrap items-center gap-x-2 gap-y-1 motion-reduce:hidden"
                aria-hidden="true"
            >
                <span>Wrap any</span>
                <Reel
                    items={SOURCES}
                    className="font-mono text-[0.9em] font-semibold text-stitch"
                />
                <span>in one</span>
                <Reel
                    items={QUALITIES}
                    className="font-semibold text-fd-foreground"
                />
                <span>function.</span>
            </p>

            {/* Read by screen readers always; shown when motion is reduced. */}
            <p className="sr-only motion-reduce:not-sr-only">
                Wrap any HTTP, GraphQL, shell, or LLM call in one{' '}
                <strong className="font-semibold text-fd-foreground">
                    typed, validated, observable, resilient, streamable,
                    declarative function.
                </strong>
            </p>
        </div>
    );
}
