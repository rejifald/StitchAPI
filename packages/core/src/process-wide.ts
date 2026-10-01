// State that must be ONE object per process, whichever entry of the package reached it.
//
// The ESM build code-splits: `stitchapi`, `stitchapi/auth`, `stitchapi/otlp`, … import shared
// chunks, so a module-level `Map`/`Set` is one object however many entries a program imports.
// The CJS build does NOT split. Each entry (`lib/index.js`, `lib/auth.js`, `lib/otlp.js`, …)
// bundles its own copy of every module it reaches, so the same module-level collection exists once
// PER ENTRY: a `require('stitchapi/auth').apiKey({ in: 'query', name })` registers its secret
// query key in `auth.js`'s copy of the denylist while the engine in `index.js` and the sink in
// `otlp.js` scrub against their own, and the key reaches a trace unredacted (#898).
//
// A registry whose job is to be seen by every entry therefore lives on `globalThis`, under a
// `Symbol.for` key (the cross-realm symbol registry hands every copy the same symbol), and each
// copy takes the existing object instead of minting its own. The first copy to load creates it.
//
// Only state whose callers depend on it being shared belongs here: an additive denylist, the
// fingerprinter registry, the host-pooled rate budget, the seam-id counter. A cache that is merely
// an optimisation, or a per-run object, stays module-local. Class identity across entries is a
// separate problem with a different fix (#896: `instanceof` needs one class, so the build has to
// stop duplicating it).
//
// Structural state whose shape this package owns (not a bag of strings or a public contract)
// carries a layout number in its name, `/1`: bump it when the shape changes, so a copy of an older
// release in the same process never reads a layout it does not understand.
export function processWide<T>(name: string, make: () => T): T {
    const slots = globalThis as unknown as Record<symbol, T | undefined>;
    const key = Symbol.for(name);
    return (slots[key] ??= make());
}
