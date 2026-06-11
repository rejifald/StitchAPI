import { fakeApi } from './fake-api/plugin';

import { defineConfig } from 'vite';

// The fakeApi() plugin is the whole point of this example: it serves the API
// the StitchAPI calls in src/main.ts hit, so the sandbox is fully
// self-contained and never reaches out to a third-party service.
export default defineConfig({
    plugins: [fakeApi()],
});
