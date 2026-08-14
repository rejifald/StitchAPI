// Re-export the core download rig so @stitchapi/download specs prove the batch layer against the SAME
// adversary the buffered surface was hardened against (rig spec §6 — "it gets its own test/support/
// that imports/re-exports the core fixture"). Mirrors how core's test/support/streams.ts re-exports
// from ../../src/test-stream: one source of truth for the mock server, shared across packages.
export * from '../../../core/test/support/mock-server';
