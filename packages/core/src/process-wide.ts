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
// fingerprinter registry, the host-pooled rate budget, the seam ids, the warn-once flags. A cache
// that is merely an optimisation, or a per-run object, stays module-local. Class identity across
// entries is a separate problem with a different fix (#896: `instanceof` needs one class, so the
// build has to stop duplicating it).
//
// A slot is a name every copy of the package agrees on, and a name freezes at the first release
// that ships it, so two rules keep it safe to share:
//   - EVERY name ends in a layout number, `/1`: bump it when the shape stored under it changes, so a
//     copy of another release in the same process never reads a layout it does not understand;
//   - the shape is CHECKED. A slot is always a `Set` or a `Map` — the platform's own classes, one per
//     realm, so `instanceof` is sound across copies (a class this package defines is not: that is
//     #896) — and is taken only if it is one. Something else may have put a value there (a bug, a
//     different layout under the same name, a stray assignment), and a registry that throws on its
//     first use is worse than one that is not shared. A slot holding another shape is REPLACED by a
//     fresh, empty collection of the right type: every copy of this release then shares that one,
//     nothing throws, and what the foreign value held is lost (it could not have been read as what
//     it was meant to be). A flag or a counter is a `Set` too (of the names that fired, of the ids
//     issued).
//
// Call it from a function, never at module scope: `const registry = () => processWide(…)`. A
// module-level call is a side effect no bundler may drop, so every entry that merely imports the
// module (`stitchapi/auth` imports `resilience` for two helpers) would carry the registry it never
// reads; a function nobody calls tree-shakes away.
export function processWide<T extends object>(
    name: string,
    Type: new () => T,
): T {
    const slots = globalThis as unknown as Record<symbol, unknown>;
    const key = Symbol.for(name);
    const held = slots[key];
    return held instanceof Type ? held : (slots[key] = new Type());
}
