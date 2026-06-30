import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['node_modules', 'lib', 'coverage'] },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                project: ['./tsconfig.eslint.json'],
                tsconfigRootDir: import.meta.dirname,
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
        },
    },
    {
        files: ['src/**/*.ts'],
        rules: {
            '@typescript-eslint/consistent-type-imports': 'error',
            // Steer the `...(x !== undefined ? { k: x } : {})` omit-an-undefined-key
            // idiom toward `compact({ ...obj, k: x })` (util.ts), which drops
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
                        'Use compact({ ...obj, key: value }) from ./util to omit undefined keys instead of `...(x !== undefined ? { key: x } : {})`.',
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
    {
        files: ['test/**/*.ts'],
        ...vitest.configs.recommended,
    },
    {
        files: ['test/**/*.ts'],
        rules: {
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
        },
    },
    eslintConfigPrettier,
);
