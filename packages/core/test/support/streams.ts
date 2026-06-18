// Dogfooding: re-export the PUBLISHED mocking-kit stream helpers (stitchapi/testing, in src/) so
// the library's own sse/stream specs exercise the same code users do. This shim keeps the historical
// import path — and the `collectEvents` name — working for the specs that predate the public kit.
export {
    gatedStream,
    streamAdapter,
    streamOf,
    streamThenError,
} from '../../src/test-stream';
export {
    type CollectedEvents,
    collectStitchEvents as collectEvents,
} from '../../src/test-events';
