import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import tseslint from 'typescript-eslint';

// The workspace-wide lint config. It used to live in packages/core, which is why only
// core was ever linted: `pnpm -r check:lint` fans out to packages that DEFINE a
// `check:lint` script, and the 35 companions never did (#457). Rules now live here,
// once, and `scripts/check-lint.mjs` applies them to every packages/* directory it
// finds on disk — so a package can no longer opt out by omitting a script.
//
// The runner invokes eslint once per package, with `cwd` set to that package. That
// matters twice over:
//
//   1. `parserOptions.project` below resolves against `process.cwd()`, so each
//      process type-checks against ONE package's tsconfig instead of loading all 36
//      programs at once. A single whole-workspace pass exhausts Node's default heap
//      (verified: SIGABRT at ~4.7 GB RSS, with both a project glob and
//      `projectService`), which would have made this gate unrunnable in CI.
//   2. ESLint resolves `eslint-suppressions.json` relative to cwd, so each package
//      keeps its own baseline — including core's existing one, which stays valid
//      byte-for-byte because its keys were already package-relative.
//
// `files` patterns stay position-independent (`**/src/**`, not `packages/*/src/**`)
// so they match whether eslint is run from a package or from the repo root.
const project = [
    // Precedence, first match wins: a package's type-aware lint project must cover
    // BOTH src and test. core's tsconfig.json is src-only (test lives in the .test
    // project), so it needs the dedicated .eslint project; sandbox-sim colocates
    // *.test.ts inside src/ and only its .test project includes them.
    'tsconfig.eslint.json',
    'tsconfig.test.json',
    'tsconfig.json',
].find((file) => existsSync(resolve(process.cwd(), file)));

export default tseslint.config(
    {
        ignores: [
            '**/node_modules/**',
            '**/lib/**',
            '**/dist/**',
            '**/coverage/**',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                project: project ? [`./${project}`] : undefined,
                tsconfigRootDir: process.cwd(),
            },
        },
    },
    {
        // Project-wide rule tuning for this unknown-heavy HTTP/JSON runtime.
        rules: {
            // Numbers/booleans in template literals are fine (URLs, log lines).
            '@typescript-eslint/restrict-template-expressions': [
                'error',
                { allowNumber: true, allowBoolean: true },
            ],
            // Async interface impls (StitchStore, Validator) return Promises even
            // when a given implementation is synchronous.
            '@typescript-eslint/require-await': 'off',
            // Conflicts with no-non-null-assertion; prefer explicit `as T` or a guard.
            '@typescript-eslint/non-nullable-type-assertion-style': 'off',
            // tsconfig's noPropertyAccessFromIndexSignature forces bracket access on
            // index-signature properties (process.env, header maps); allow that here so
            // the compiler option and dot-notation don't pull in opposite directions.
            '@typescript-eslint/dot-notation': [
                'error',
                { allowIndexSignaturePropertyAccess: true },
            ],
            // Same "don't pull in opposite directions" reasoning as dot-notation above.
            // Every package compiles under noUnusedLocals + noUnusedParameters, and
            // TypeScript exempts `_`-prefixed identifiers from BOTH — so the leading
            // underscore is already this workspace's marker for a deliberately-unused
            // binding (an interface-conformance parameter, a phantom type parameter, a
            // destructured key being dropped). eslint's defaults don't know that
            // convention, so without this the two gates disagree on the same file.
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    args: 'all',
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                    ignoreRestSiblings: true,
                },
            ],
        },
    },
    {
        // Plain-JavaScript packages (completions-plugin is .mjs with no tsconfig)
        // have no program for the type-aware rules to consult, and those rules throw
        // rather than skip. Drop them to the syntactic set for .js/.mjs/.cjs so the
        // package is still linted instead of being excluded from the gate.
        files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
        ...tseslint.configs.disableTypeChecked,
    },
    {
        files: ['**/src/**/*.ts'],
        rules: {
            '@typescript-eslint/consistent-type-imports': 'error',
            // Steer the `...(x !== undefined ? { k: x } : {})` omit-an-undefined-key
            // idiom toward `compact({ ...obj, k: x })` (core's util.ts), which drops
            // undefined-valued keys and types them optional under
            // exactOptionalPropertyTypes. Truthy spreads (`...(x ? … : {})`) and array
            // spreads are intentionally NOT matched. Rare sites where compact would
            // optionalize a REQUIRED `unknown` key keep the spread + an inline disable.
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        "SpreadElement[argument.type='ConditionalExpression'][argument.test.operator='!=='][argument.test.right.type='Identifier'][argument.test.right.name='undefined'][argument.consequent.type='ObjectExpression'][argument.alternate.properties.length=0]",
                    message:
                        'Use compact({ ...obj, key: value }) to omit undefined keys instead of `...(x !== undefined ? { key: x } : {})`.',
                },
            ],
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: 'lodash',
                            message:
                                'Import [module] from lodash/[module] instead',
                        },
                    ],
                },
            ],
        },
    },
    // Tests poke at loosely-typed mock payloads; relax the rules that fight that.
    // sandbox-sim colocates its suite as src/**/*.test.ts, so match that shape too.
    {
        files: ['**/test/**/*.ts', '**/src/**/*.test.ts'],
        ...vitest.configs.recommended,
    },
    {
        files: ['**/test/**/*.ts', '**/src/**/*.test.ts'],
        rules: {
            // The store/adapter suites assert through `conformance.assert(...)`, the
            // shared contract-runner helper — a real assertion the rule can't see
            // through, so name it rather than let those specs read as assertion-free.
            'vitest/expect-expect': [
                'error',
                { assertFunctionNames: ['expect', 'conformance.assert'] },
            ],
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
        },
    },
    eslintConfigPrettier,
);
