import { JsonSchema, type JsonSchemaCheck } from '../src/index';

import Ajv from 'ajv';
import { compile, validate } from 'stitchapi';

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

// The engine is supplied by the caller — this stands in for your app's configured Ajv.
const ajv = new Ajv({ allErrors: true, strict: false });

describe('JsonSchema.adapt (caller-supplied Ajv instance)', () => {
    it('passes valid args through unchanged', async () => {
        const validator = JsonSchema.adapt(toolSchema, { ajv });
        const result = await validator['~standard'].validate({
            query: 'shoes',
            limit: 5,
        });
        expect(result).toEqual({ value: { query: 'shoes', limit: 5 } });
    });

    it('maps a type mismatch to an issue with a path', async () => {
        const validator = JsonSchema.adapt(toolSchema, { ajv });
        const result = await validator['~standard'].validate({ query: 42 });
        expect(result.issues).toBeDefined();
        if (result.issues) {
            expect(result.issues).toContainEqual(
                expect.objectContaining({ path: ['query'] }),
            );
        }
    });

    it('reports a missing required argument', async () => {
        const validator = JsonSchema.adapt(toolSchema, { ajv });
        const result = await validator['~standard'].validate({ limit: 3 });
        expect(result.issues).toBeDefined();
    });

    it('rejects arguments the schema did not declare', async () => {
        const validator = JsonSchema.adapt(toolSchema, { ajv });
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
        const validator = JsonSchema.adapt(listSchema, { ajv });
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

describe('JsonSchema.adapt (bring-your-own check)', () => {
    it('wraps any engine that yields a JSON Pointer + message', async () => {
        const check: JsonSchemaCheck = () => ({
            valid: false,
            issues: [{ pointer: '/limit', message: 'must be <= 50' }],
        });
        const validator = JsonSchema.adapt(toolSchema, { check });
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
        const validator = JsonSchema.adapt<{ query: string }>(toolSchema, {
            check,
        });
        const result = await validator['~standard'].validate({ query: 'x' });
        expect(result).toEqual({ value: { query: 'x' } });
    });
});

// P23 — one schema intake: the adapted schema enters core through the same `SchemaLike`
// intake as any Standard Schema and yields core's `ValidationResult` shape
// (`{ ok: true, value } | { ok: false, issues }`), with issues nominally matching core's
// `Issue` (`{ message, path }`). Verified through the workspace dev-dependency; this
// package's runtime still depends on nothing from core.
describe('JsonSchema.adapt feeds core validate/compile (P23)', () => {
    it('validate() returns { ok: true, value } for a conforming payload', async () => {
        const schema = JsonSchema.adapt(toolSchema, { ajv });
        const result = await validate(schema, { query: 'shoes', limit: 5 });
        expect(result).toEqual({
            ok: true,
            value: { query: 'shoes', limit: 5 },
        });
    });

    it('compile() returns { ok: false, issues } with { message, path } per failure', async () => {
        const check = compile(JsonSchema.adapt(toolSchema, { ajv }));
        const result = await check({ query: 42 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.issues).toContainEqual({
                message: expect.any(String),
                path: ['query'],
            });
        }
    });
});
