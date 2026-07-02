/**
 * Webpack plugin that auto-discovers playground primitives from TypeScript
 * packages and regenerates the completions map before every compilation.
 *
 * Discovery rule: for every exported `*Config` interface in `src/**\/*.ts`,
 * if the derived function name (`StitchConfig → stitch`) is also exported from
 * `src/index.ts`, it becomes a completions entry automatically.
 *
 * Usage in next.config.mjs:
 *   import { PlaygroundCompletionsPlugin } from '@stitchapi/completions-plugin';
 *
 *   new PlaygroundCompletionsPlugin({
 *     packages: [
 *       resolve(repoRoot, 'packages/core'),
 *       // add more packages as they land
 *     ],
 *     outputFile: '/abs/path/to/playground-completions.generated.ts',
 *   })
 *
 * @typedef {{ packages: string[], outputFile: string }} PluginOptions
 */
import { generatePlaygroundCompletions } from './codegen.mjs';

export {
    generatePlaygroundCompletions,
    renderPlaygroundCompletions,
} from './codegen.mjs';

export class PlaygroundCompletionsPlugin {
    /** @param {PluginOptions} opts */
    constructor(opts) {
        this.opts = opts;
    }

    /** @param {import('webpack').Compiler} compiler */
    apply(compiler) {
        compiler.hooks.beforeCompile.tapAsync(
            'PlaygroundCompletionsPlugin',
            async (_, callback) => {
                try {
                    await generatePlaygroundCompletions(this.opts);
                } catch (err) {
                    // Log but don't crash — stale generated file stays in place.
                    console.error('[PlaygroundCompletionsPlugin]', err.message);
                }
                callback();
            },
        );
    }
}
