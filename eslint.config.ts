import js from '@eslint/js';
import type { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

export default [
    {
        ...js.configs.recommended,
        ignores: ['node_modules', 'lib/**/*.*'],
    },
    ...tseslint.configs.recommended.map((config) => ({
        ...config,
        ignores: ['node_modules', 'lib/**/*.*'],
    })),
    {
        rules: {
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
] satisfies Linter.FlatConfig[];
