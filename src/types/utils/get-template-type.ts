/* eslint-disable @typescript-eslint/no-unused-vars */
// Utility to extract simple param names (e.g. {param}, {+param}, {#param}, {param*})
export type ExtractRFCParams<T extends string> =
    T extends `${infer _}{${infer Param}}${infer Rest}`
        ? Param | ExtractRFCParams<Rest>
        : T extends `${infer _}{+${infer Param}}${infer Rest}`
          ? Param | ExtractRFCParams<Rest>
          : T extends `${infer _}{#${infer Param}}${infer Rest}`
            ? Param | ExtractRFCParams<Rest>
            : T extends `${infer _}{${infer Param}*}${infer Rest}`
              ? Param | ExtractRFCParams<Rest>
              : T extends ''
                ? never
                : never;
