import { type JsonSchemaCheck, jsonSchemaValidator } from '../src/index';

import { toValidator } from 'stitchapi';

// An OpenAI-compatible tool `parameters` schema — the shape a crawl hands you at runtime.
const toolSchema = {
    type: 'object',
    properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['query'],
    additionalProperties: false,
};

describe('jsonSchemaValidator (bundled Ajv engine)', () => {
    it('passes valid args through unchanged', async () => {
        const validator = toValidator(jsonSchemaValidator(toolSchema));
        const result = await validator!.validate({ query: 'shoes', limit: 5 });
        expect(result).toEqual({
            ok: true,
            value: { query: 'shoes', limit: 5 },
        });
    });

    it('maps a type mismatch to an issue with a path', async () => {
        const validator = toValidator(jsonSchemaValidator(toolSchema));
        const result = await validator!.validate({ query: 42 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.issues).toContainEqual(
                expect.objectContaining({ path: ['query'] }),
            );
        }
    });

    it('reports a missing required argument', async () => {
        const validator = toValidator(jsonSchemaValidator(toolSchema));
        const result = await validator!.validate({ limit: 3 });
        expect(result.ok).toBe(false);
    });

    it('rejects arguments the schema did not declare', async () => {
        const validator = toValidator(jsonSchemaValidator(toolSchema));
        const result = await validator!.validate({ query: 'x', rogue: true });
        expect(result.ok).toBe(false);
    });

    it('flags a nested array index in the path', async () => {
        const listSchema = {
            type: 'object',
            properties: { tags: { type: 'array', items: { type: 'string' } } },
        };
        const validator = toValidator(jsonSchemaValidator(listSchema));
        const result = await validator!.validate({ tags: ['ok', 7] });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.issues).toContainEqual(
                expect.objectContaining({ path: ['tags', 1] }),
            );
        }
    });
});

describe('jsonSchemaValidator (bring-your-own check)', () => {
    it('wraps any engine that yields a JSON Pointer + message', async () => {
        const check: JsonSchemaCheck = () => ({
            valid: false,
            issues: [{ pointer: '/limit', message: 'must be <= 50' }],
        });
        const validator = toValidator(
            jsonSchemaValidator(toolSchema, { check }),
        );
        const result = await validator!.validate({ query: 'x', limit: 99 });
        expect(result).toEqual({
            ok: false,
            issues: [{ path: ['limit'], message: 'must be <= 50' }],
        });
    });

    it('passes when the injected check reports valid', async () => {
        const check: JsonSchemaCheck = () => ({ valid: true, issues: [] });
        const validator = toValidator(
            jsonSchemaValidator<{ query: string }>(toolSchema, { check }),
        );
        const result = await validator!.validate({ query: 'x' });
        expect(result).toEqual({ ok: true, value: { query: 'x' } });
    });
});
