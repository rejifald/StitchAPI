// The `stitchapi/graphql` surface subpath (ADR 0005 Decisions 3, 10): the graphql surface's
// monomorphic authoring helpers. `graphql(config)` stays the terse callable form; `graphql.stitch`
// is its alias, `graphql.seam(...)` binds graphql members to a seam, and `graphql.surface` is the
// Surface identity. The seam stays surface-agnostic — graphql members are created through the
// seam's own `graphql()` method (in Stage 4 graphql's shaping/unwrap move behind the surface
// hooks; today they ride the engine's id-keyed handling + this helper).
import { seam as makeSeam } from './seam';
import { graphql as graphqlStitch } from './stitch';
import { graphqlSurface } from './surface';
import { isSeam } from './types';
import type { Seam, SeamOptions } from './types';

/** graphql members bound to a seam. `stitch(config)` creates a graphql member of `seam`; `seam`
 *  is the underlying handle for lifecycle/principal (`.as`/`.flush`/`.close`). */
export interface GraphqlSeamApi {
    readonly stitch: Seam['graphql'];
    readonly seam: Seam;
}

const bind = (s: Seam): GraphqlSeamApi => ({
    stitch: s.graphql.bind(s),
    seam: s,
});

/**
 * The graphql surface's authoring helper — callable for the terse form (`graphql(config)`) plus:
 * - `graphql.stitch(config)` — a standalone graphql stitch (alias of the callable).
 * - `graphql.seam(existingSeam)` — bind graphql members to an existing seam.
 * - `graphql.seam(options)` — a new seam whose members default to graphql.
 * - `graphql.surface` — the graphql {@link Surface} identity.
 */
export const graphql = Object.assign(graphqlStitch, {
    surface: graphqlSurface,
    stitch: graphqlStitch,
    seam: (arg: Seam | SeamOptions): GraphqlSeamApi =>
        bind(isSeam(arg) ? arg : makeSeam(arg)),
});
