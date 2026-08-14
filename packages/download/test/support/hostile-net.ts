// Re-export the core raw-socket escape hatch (ECONNREFUSED / immediate-FIN / accept-then-silence)
// so @stitchapi/download specs can drive connection-level faults through the batch layer. Same
// re-export pattern as ./mock-server.
export * from '../../../core/test/support/hostile-net';
