/**
 * Smoke test — score/run.ts executes pre-baked stitch snippets OFFLINE against
 * sandbox-sim and the task's expectedShape passes. No network, no credentials.
 *
 * The paginated + graphql + llm snippets are run against a fixture fetch shim
 * (test/sandbox-fixtures.ts) that implements the AGREED ENDPOINT CONTRACTS plus
 * the existing sandbox-sim handlers (for the LLM endpoint). This keeps the test
 * self-contained even before Agent B's production handlers land.
 */
import { PREBAKED } from '../runner/prebaked';
import { runProduced } from '../score/run';
import { getTask } from '../tasks/index';
import { makeFixtureFetch } from './sandbox-fixtures';

import assert from 'node:assert';

async function scoreTask(id: string): Promise<void> {
    const task = getTask(id);
    assert(task, `task ${id} must exist`);
    const source = PREBAKED[id];
    assert(source, `prebaked snippet for ${id} must exist`);

    const res = await runProduced(source, task, makeFixtureFetch());
    assert.strictEqual(
        res.compiled,
        true,
        `${id}: snippet should compile/import — ${res.error ?? ''}`,
    );
    assert.strictEqual(
        res.ran,
        true,
        `${id}: snippet should run — ${res.error ?? ''}`,
    );
    assert.strictEqual(
        res.shapeOk,
        true,
        `${id}: expectedShape should pass — ${res.error ?? ''}`,
    );
    console.log(`✓ ${id}: compiled + ran + shape ok`);
}

async function main(): Promise<void> {
    // Paginated list: follows the cursor across 2 pages (with a retried 429),
    // validates each user → 4 users.
    await scoreTask('paginated-list-retries-validate');

    // GraphQL: unwraps data.user → a single user object.
    await scoreTask('wrap-graphql-endpoint');

    // LLM completion: hits the existing /v1/chat/completions handler (non-stream
    // JSON), returns the deterministic completion text.
    await scoreTask('stream-llm-completion');

    // A produced file that throws at runtime is reported, not crashed on.
    const task = getTask('wrap-graphql-endpoint')!;
    const broken = `export async function run() { throw new Error('boom'); }`;
    const res = await runProduced(broken, task, makeFixtureFetch());
    assert.strictEqual(res.compiled, true, 'broken snippet still imports');
    assert.strictEqual(res.ran, false, 'broken snippet does not "run" ok');
    assert(res.error?.includes('boom'), 'error surfaces the thrown message');
    console.log('✓ runtime throw is reported, not crashed on');

    console.log('run.test OK');
}

main().catch((err) => {
    console.error('run.test FAILED:', err);
    process.exit(1);
});
