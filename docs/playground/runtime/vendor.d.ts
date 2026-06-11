/**
 * Build-time placeholder type shims — until deps are installed.
 * These are minimal stubs so `tsc --noEmit` passes in the worktree
 * without `npm install`.  Remove once the real packages are installed
 * (their own `.d.ts` files will take precedence via skipLibCheck).
 */

declare module 'sucrase' {
    export interface Options {
        transforms: Array<'typescript' | 'jsx' | 'imports' | 'flow'>;
        [key: string]: unknown;
    }
    export interface TransformResult {
        code: string;
    }
    export function transform(code: string, options: Options): TransformResult;
}

declare module '@babel/standalone' {
    export interface TransformOptions {
        presets?: string[];
        filename?: string;
        [key: string]: unknown;
    }
    export interface TransformResult {
        code: string | null | undefined;
    }
    export function transform(code: string, options: TransformOptions): TransformResult;
}

// Node.js `process` — present in tsx/ts-node; shim so tsc accepts the test file.
declare const process: {
    exit(code?: number): never;
};
