import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['node_modules', 'lib', 'coverage', 'playground', 'docs'] },
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
