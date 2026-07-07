/**
 * CLI entry — prints the agent run to the terminal.
 *
 * See `agent.ts` for the wiring (stitch → stitchTool → Agent), and `server.ts`
 * for the same run rendered to a web page.
 *
 *   npm run cli
 */
import { PROMPT, createAgent } from './agent.js';

import assert from 'node:assert/strict';

async function main(): Promise<void> {
    const agent = await createAgent();

    console.log(`▶  prompt: "${PROMPT}"\n`);

    let toolOutput: unknown;
    for await (const event of agent.run([], PROMPT)) {
        switch (event.type) {
            case 'tool.start':
                console.log(
                    `   ├─ tool call    ${event.toolName}(${JSON.stringify(event.input)})`,
                );
                break;
            case 'tool.done':
                toolOutput = event.output;
                console.log(
                    `   ├─ tool result  ${JSON.stringify(event.output)}`,
                );
                console.log(
                    `   │               ↑ validated & shaped by the stitch's Zod output schema`,
                );
                break;
            case 'text.delta':
                process.stdout.write(event.text);
                break;
            case 'done':
                console.log(
                    `\n\n✓  done — the agent answered from the schema-validated tool result.`,
                );
                break;
            case 'error':
                throw event.error;
        }
    }

    // The tool result carries only the four fields in the `output` schema — the
    // adapter returned seven. That stripping is the stitch validating the response.
    assert.deepEqual(toolOutput, {
        id: 2,
        name: 'Ervin Howell',
        email: 'Shanna@melissa.tv',
        company: { name: 'Deckow-Crist' },
    });
    console.log('\nexamples/openharness OK');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
