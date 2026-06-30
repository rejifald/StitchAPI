// `compact({ ...obj, key: value })` — a shallow copy with the `undefined`-valued keys dropped,
// typed so undefined-admitting keys come back *optional* (`key?: V`). It pairs with
// `exactOptionalPropertyTypes`: the result drops into a typed target without the
// `...(key !== undefined ? { key } : {})` spread dance. The `const` type parameter preserves
// literal types, so a discriminant such as `{ type: 'start', ... }` survives the wrap.
//
// CAVEATS (each handled at the few call sites that hit it):
//   • a REQUIRED `unknown`-typed key is optionalized (since `undefined extends unknown`) — keep an
//     explicit spread there instead;
//   • the `const` generic freezes an inline `[]` to `readonly []` — pin the element type;
//   • inline callbacks in the wrapped literal lose their contextual param types — annotate them.

export type Compact<T> = {
    [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
    [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
        T[K],
        undefined
    >;
};

export const compact = <const T extends object>(obj: T): Compact<T> => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
        const v = (obj as Record<string, unknown>)[k];
        if (v !== undefined) out[k] = v;
    }
    return out as Compact<T>;
};
