// `@stitchapi/openapi` — the public library surface. The generator is pure: feed `planGen`
// a parsed OpenAPI document and it returns the files to write (ADR 0013). The `stitch-openapi`
// CLI (src/cli.ts) is a thin wrapper over this. Kept OUT of the `stitchapi` runtime package so
// it can take build-time dependencies (a YAML parser, validator-source emitters) without ever
// touching the zero-dep core.
export {
    planGen,
    type GenOptions,
    type GenFile,
    type GenResult,
    type OpenApiDoc,
    type SchemaNode,
} from './gen-openapi';
