// @stitchapi/download — a batch downloader / manager on top of core's buffered `download()` surface
// (`stitchapi/download`). Adds FIFO admission, per-item settling, cancellation, aggregate progress +
// ETA, a forward-progress idle timeout, and opt-in same-URL dedupe — none of which core's `throttle`
// can express. Zero runtime deps; browser-first (the Blob surface never touches disk).
export { downloadAll } from './download-all';
export { DownloadManager } from './manager';
export { DownloadCancelledError, DownloadIdleTimeoutError } from './errors';
export type {
    BatchOptions,
    BatchProgress,
    BatchSnapshot,
    DownloadBatch,
    DownloadHandle,
    DownloadId,
    DownloadRequest,
    DownloadResult,
    ItemPhase,
    ItemProgress,
    ItemResult,
    ItemStatus,
} from './types';
