import nextVitals from 'eslint-config-next/core-web-vitals';
import { defineConfig, globalIgnores } from 'eslint/config';

const eslintConfig = defineConfig([
    ...nextVitals,
    globalIgnores([
        '.next/**',
        'out/**',
        'build/**',
        'next-env.d.ts',
        '.source/**',
        'scripts/**',
        // Generated bundle of the core runtime for the live playground (build:sandbox). It
        // carries core's source comments verbatim — including `eslint-disable` directives for
        // rules this app's flat config doesn't load — so it must never be linted as app source.
        'public/sandbox/**',
    ]),
]);

export default eslintConfig;
