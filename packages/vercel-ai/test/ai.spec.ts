// @stitchapi/vercel-ai behaviour, driven with fake stitches. No engine, no AI SDK — the
// tool object is structural, so we assert its shape and run its `execute`.
import { stitchExecute, stitchTool } from '../src';
import type { StitchLike } from '../src';

import { describe, expect, test } from 'vitest';

function unaryStitch<T>(settle: (input: unknown) => Promise<T>): StitchLike<T> {
    return (input?: unknown): PromiseLike<T> => ({
        then: (onf, onr) => settle(input).then(onf, onr),
    });
}

// A fake schema object — the adapter passes it through opaquely.
const schema = { _schema: 'z.object({ id })' };

// --- stitchExecute ---------------------------------------------------------

describe('stitchExecute', () => {
    test('passes the args straight through as the stitch input by default', async () => {
        let seen: unknown;
        const stitch = unaryStitch(async (input) => {
            seen = input;
            return { ok: true };
        });
        const execute = stitchExecute(stitch);
        await expect(execute({ params: { id: '1' } })).resolves.toEqual({
            ok: true,
        });
        expect(seen).toEqual({ params: { id: '1' } });
    });

    test('toInput maps a model-friendly shape onto the stitch input', async () => {
        let seen: unknown;
        const stitch = unaryStitch(async (input) => {
            seen = input;
            return { ok: true };
        });
        const execute = stitchExecute(stitch, (args: { id: string }) => ({
            params: { id: args.id },
        }));
        await execute({ id: '7' });
        expect(seen).toEqual({ params: { id: '7' } });
    });

    test('a stitch failure rejects (for the SDK to surface)', async () => {
        const stitch = unaryStitch(async () => {
            throw new Error('upstream down');
        });
        await expect(stitchExecute(stitch)({})).rejects.toThrow(
            'upstream down',
        );
    });
});

// --- stitchTool ------------------------------------------------------------

describe('stitchTool', () => {
    test('returns a tool object carrying both v4 (parameters) and v5 (inputSchema) keys', () => {
        const stitch = unaryStitch(async () => ({ name: 'Ada' }));
        const tool = stitchTool(stitch, {
            description: 'Fetch a user by id',
            inputSchema: schema,
            toInput: (args: { id: string }) => ({ params: { id: args.id } }),
        });

        expect(tool.description).toBe('Fetch a user by id');
        expect(tool.parameters).toBe(schema);
        expect(tool.inputSchema).toBe(schema);
        expect(typeof tool.execute).toBe('function');
    });

    test('the tool execute runs the stitch with the mapped input', async () => {
        let seen: unknown;
        const stitch = unaryStitch(async (input) => {
            seen = input;
            return { name: 'Ada' };
        });
        const tool = stitchTool(stitch, {
            inputSchema: schema,
            toInput: (args: { id: string }) => ({ params: { id: args.id } }),
        });
        await expect(tool.execute({ id: '7' })).resolves.toEqual({
            name: 'Ada',
        });
        expect(seen).toEqual({ params: { id: '7' } });
    });

    test('omitting description leaves it unset', () => {
        const tool = stitchTool(
            unaryStitch(async () => 1),
            {
                inputSchema: schema,
            },
        );
        expect('description' in tool).toBe(false);
    });
});
