/**
 * Ambient declaration for the playground transpiler's lazy fallback.
 *
 * `@sandbox/runtime/transpile` prefers `sucrase` (a real dependency — it ships its
 * own types) and only dynamically imports `@babel/standalone` if Sucrase fails to
 * *load*. We don't ship the heavy Babel standalone bundle just to satisfy that
 * never-taken fallback's type reference, so declare the tiny surface `transpile.ts`
 * touches. (The sandbox runtime project declares the same in its own `vendor.d.ts`,
 * which is out of this app's compilation scope.)
 */
declare module '@babel/standalone' {
    export interface TransformOptions {
        presets?: string[];
        filename?: string;
        [key: string]: unknown;
    }
    export interface TransformResult {
        code: string | null | undefined;
    }
    export function transform(
        code: string,
        options: TransformOptions,
    ): TransformResult;
}
