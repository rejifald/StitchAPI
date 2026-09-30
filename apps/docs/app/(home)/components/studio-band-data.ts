/**
 * The studio band's content contract
 * (docs/design/studio-band/anatomy.md §5, `StudioBandData`).
 *
 * One committed JSON file per host and language, read at build time — nothing
 * is fetched while building or in the browser. The file is parsed and
 * validated here, at MODULE SCOPE, so a missing or malformed file throws
 * while Next collects this page's data and fails `next build` rather than
 * shipping a broken band.
 */
import studioBandEnRaw from './studio-band.en.json';

import { z } from 'zod';

const relatedProjectSchema = z.object({
    name: z.string().min(1),
    tagline: z.string().min(1),
    href: z.string().url(),
});

const askSchema = z.object({
    heading: z.string().min(1),
    body: z.string().min(1),
    label: z.string().min(1),
    href: z.string().url(),
});

export const studioBandDataSchema = z.object({
    version: z.literal(1),
    // The host's own slug (e.g. "stitchapi"), not used for rendering.
    project: z.string().min(1),
    lang: z.enum(['en', 'uk']),
    title: z.string().min(1),
    // The wordmark's link. The kit's name is fixed, never localized.
    studio: z.object({
        name: z.literal('Oleks Crane'),
        href: z.string().url(),
    }),
    all: z.object({ label: z.string().min(1), href: z.string().url() }),
    // 0–3, in order; a 4th+ entry would be a spec violation, not silently
    // ignored, so the build fails loudly instead of quietly dropping data.
    related: z.array(relatedProjectSchema).max(3),
    ask: askSchema.nullable(),
});

export type StudioBandData = z.infer<typeof studioBandDataSchema>;

/**
 * stitchapi.dev ships one language (English). The other host in the spec,
 * movar.fyi, also needs "uk" — but that data file lives in movar's own repo,
 * not here, so this map only ever grows a second entry if stitchapi.dev
 * itself goes multilingual.
 */
const studioBandDataByLang = {
    en: studioBandDataSchema.parse(studioBandEnRaw),
} as const satisfies Record<string, StudioBandData>;

export type StudioBandLang = keyof typeof studioBandDataByLang;

/** Picks the data file for the page's language (`StudioBand`'s only prop). */
export function getStudioBandData(lang: StudioBandLang): StudioBandData {
    return studioBandDataByLang[lang];
}
