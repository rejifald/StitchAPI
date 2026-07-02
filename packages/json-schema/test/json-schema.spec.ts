import { type JsonSchemaCheck, jsonSchemaValidator } from '../src/index';

// A JSON Schema you obtained at runtime — the shape a discovery hands you.
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
        const validator = jsonSchemaValidator(toolSchema);
        const result = await validator['~standard'].validate({
            query: 'shoes',
            limit: 5,
        });
        expect(result).toEqual({ value: { query: 'shoes', limit: 5 } });
    });

    it('maps a type mismatch to an issue with a path', async () => {
        const validator = jsonSchemaValidator(toolSchema);
        const result = await validator['~standard'].validate({ query: 42 });
        expect(result.issues).toBeDefined();
        if (result.issues) {
            expect(result.issues).toContainEqual(
                expect.objectContaining({ path: ['query'] }),
            );
        }
    });

    it('reports a missing required argument', async () => {
        const validator = jsonSchemaValidator(toolSchema);
        const result = await validator['~standard'].validate({ limit: 3 });
        expect(result.issues).toBeDefined();
    });

    it('rejects arguments the schema did not declare', async () => {
        const validator = jsonSchemaValidator(toolSchema);
        const result = await validator['~standard'].validate({
            query: 'x',
            rogue: true,
        });
        expect(result.issues).toBeDefined();
    });

    it('flags a nested array index in the path', async () => {
        const listSchema = {
            type: 'object',
            properties: { tags: { type: 'array', items: { type: 'string' } } },
        };
        const validator = jsonSchemaValidator(listSchema);
        const result = await validator['~standard'].validate({
            tags: ['ok', 7],
        });
        expect(result.issues).toBeDefined();
        if (result.issues) {
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
        const validator = jsonSchemaValidator(toolSchema, { check });
        const result = await validator['~standard'].validate({
            query: 'x',
            limit: 99,
        });
        expect(result).toEqual({
            issues: [{ message: 'must be <= 50', path: ['limit'] }],
        });
    });

    it('passes when the injected check reports valid', async () => {
        const check: JsonSchemaCheck = () => ({ valid: true, issues: [] });
        const validator = jsonSchemaValidator<{ query: string }>(toolSchema, {
            check,
        });
        const result = await validator['~standard'].validate({ query: 'x' });
        expect(result).toEqual({ value: { query: 'x' } });
    });
});
