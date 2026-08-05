/**
 * Smoke test — conditions.ts: the COLD vs WARM workspace description and
 * `materialize()`. OFFLINE (filesystem only), no network.
 *
 * Run with: npx tsx packages/eval-harness/test/conditions.test.ts
 */
import { CONDITIONS, describeCondition } from '../runner/conditions';

import assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function main(): Promise<void> {
    // The two conditions every task runs under.
    assert.deepEqual([...CONDITIONS], ['cold', 'warm'], 'CONDITIONS');

    // COLD: a bare workspace — no seeds, and a note that says so.
    const cold = await describeCondition('cold', '/tmp/unused-cold');
    assert.equal(cold.condition, 'cold', 'cold: condition');
    assert.deepEqual(cold.seeds, [], 'cold: no seeds');
    assert.ok(/bare workspace/i.test(cold.notes), 'cold: bare note');
    console.log('conditions T1 PASS — cold describe');

    // WARM: always seeds llms.txt (the seed is pushed regardless of the docs
    // tree), plus a note pointing the agent at the project docs.
    const warm = await describeCondition('warm', '/tmp/unused-warm');
    assert.equal(warm.condition, 'warm', 'warm: condition');
    assert.ok(
        warm.seeds.some((s) => s.rel === 'llms.txt'),
        'warm: seeds llms.txt',
    );
    assert.ok(warm.notes.includes('llms.txt'), 'warm: note mentions llms.txt');
    console.log('conditions T2 PASS — warm describe');

    // materialize(): COLD creates an empty scratch root, idempotently.
    const root = path.join(os.tmpdir(), `stitch-eval-cond-${Date.now()}`);
    try {
        const c = await describeCondition('cold', root);
        await c.materialize();
        await c.materialize(); // idempotent — must not throw
        const stat = await fs.stat(root);
        assert.ok(stat.isDirectory(), 'materialize: root is a dir');
        assert.deepEqual(
            await fs.readdir(root),
            [],
            'materialize cold: empty root',
        );
        console.log(
            'conditions T3 PASS — cold materialize (empty, idempotent)',
        );
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }

    console.log('conditions.test OK');
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
