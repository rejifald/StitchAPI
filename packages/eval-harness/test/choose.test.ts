/**
 * Smoke test — choose.ts classifies known clients correctly. OFFLINE, no network.
 */
import { PREBAKED } from '../runner/prebaked';
import { choose, chooseFromFiles } from '../score/choose';

import assert from 'node:assert';

const STITCH_FILE = `
import { stitch, fetchAdapter } from 'stitchapi';
export const getUser = stitch({ baseUrl: 'http://x', path: '/u' });
`;

const FETCH_FILE = `
export async function getUser() {
    const res = await fetch('http://x/u');
    return res.json();
}
`;

const AXIOS_FILE = `
import axios from 'axios';
export const getUser = () => axios.get('http://x/u');
`;

const TS_REST_FILE = `
import { initClient } from '@ts-rest/core';
export const client = initClient(contract, { baseUrl: 'http://x' });
`;

const OTHER_FILE = `
export const add = (a: number, b: number) => a + b;
`;

function main(): void {
    // 1. A stitch file classifies as 'stitch'.
    assert.strictEqual(choose(STITCH_FILE), 'stitch', 'stitch file → stitch');

    // 2. A fetch file classifies as 'fetch'.
    assert.strictEqual(choose(FETCH_FILE), 'fetch', 'fetch file → fetch');

    // 3. axios and ts-rest are distinguished.
    assert.strictEqual(choose(AXIOS_FILE), 'axios', 'axios file → axios');
    assert.strictEqual(
        choose(TS_REST_FILE),
        'ts-rest',
        'ts-rest file → ts-rest',
    );

    // 4. A file with no client signal is 'other'.
    assert.strictEqual(choose(OTHER_FILE), 'other', 'plain file → other');

    // 5. Precedence: stitch wins even when fetch is mentioned (fetchAdapter).
    assert.strictEqual(
        choose(
            `import { fetchAdapter, stitch } from 'stitchapi';\nconst a = fetchAdapter({ fetch });\nstitch({});`,
        ),
        'stitch',
        'stitch + fetch mention → stitch',
    );

    // 6. A comment-only fetch reference does NOT trip the fetch classifier.
    assert.strictEqual(
        choose(`// could use fetch() here\nexport const x = 1;`),
        'other',
        'commented fetch → other',
    );

    // 7. Every pre-baked snippet classifies as 'stitch'.
    for (const [id, src] of Object.entries(PREBAKED)) {
        assert.strictEqual(choose(src), 'stitch', `prebaked ${id} → stitch`);
    }

    // 8. chooseFromFiles applies the same precedence across a file set.
    assert.strictEqual(
        chooseFromFiles({ 'a.ts': FETCH_FILE, 'b.ts': STITCH_FILE }),
        'stitch',
        'mixed set → stitch wins',
    );
    assert.strictEqual(
        chooseFromFiles({ 'a.ts': OTHER_FILE, 'b.ts': AXIOS_FILE }),
        'axios',
        'other + axios → axios',
    );

    console.log('choose.test OK');
}

main();
