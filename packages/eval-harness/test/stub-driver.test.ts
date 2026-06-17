/**
 * Smoke test — the StubDriver round-trips every task offline, and the produced
 * file classifies as 'stitch'. No network, no credentials.
 */
import { MAIN_FILE, StubDriver, mainFileOf } from '../runner/driver';
import { chooseFromFiles } from '../score/choose';
import { TASKS } from '../tasks/index';

import assert from 'node:assert';

async function main(): Promise<void> {
    const driver = new StubDriver();
    assert.strictEqual(driver.id, 'stub');

    for (const task of TASKS) {
        for (const condition of ['cold', 'warm'] as const) {
            const run = await driver.runAgent(task, condition);

            // Produces a main file.
            assert(
                run.files[MAIN_FILE],
                `${task.id}/${condition}: produces ${MAIN_FILE}`,
            );
            const main = mainFileOf(run.files);
            assert(main, `${task.id}/${condition}: mainFileOf resolves`);

            // The produced file uses stitch.
            assert.strictEqual(
                chooseFromFiles(run.files),
                'stitch',
                `${task.id}/${condition}: chooses stitch`,
            );

            // Bookkeeping is well-formed and non-negative.
            assert(run.transcriptTurns >= 0, 'turns >= 0');
            assert(run.tokensIn >= 0, 'tokensIn >= 0');
            assert(run.tokensOut >= 0, 'tokensOut >= 0');
        }

        // Warm "costs" no more than cold in the stub fixture.
        const cold = await driver.runAgent(task, 'cold');
        const warm = await driver.runAgent(task, 'warm');
        assert(
            warm.tokensIn <= cold.tokensIn,
            `${task.id}: warm tokensIn <= cold`,
        );
    }

    // Unknown task id rejects clearly.
    await assert.rejects(
        () => driver.runAgent({ id: 'no-such-task' } as never, 'cold'),
        /no pre-baked snippet/,
        'unknown task rejects',
    );

    console.log('stub-driver.test OK');
}

main().catch((err) => {
    console.error('stub-driver.test FAILED:', err);
    process.exit(1);
});
