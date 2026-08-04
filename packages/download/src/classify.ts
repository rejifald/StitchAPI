import { StitchError, compact } from 'stitchapi';

/**
 * Transport-error codes (undici / Node) a retry might plausibly clear — sockets dropped, connections
 * refused, DNS blips, connect/idle timeouts. Terminal application errors (a 4xx) are NOT here.
 */
const RETRYABLE_CODES = new Set<string>([
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EPIPE',
]);

/** The classification attached to a rejected {@link ItemResult}. */
export interface Classification {
    retryable: boolean;
    code?: string;
}

/** Coerce any thrown value into a {@link StitchError} (the reason shape callers can rely on). */
export function toStitchError(e: unknown): StitchError {
    if (e instanceof StitchError) return e;
    const message = e instanceof Error ? e.message : String(e);
    return new StitchError(message, { cause: e });
}

/** Walk an error's `cause` chain for a string `code` — undici nests the real transport code there. */
function causeCode(e: unknown): string | undefined {
    let cur: unknown = e;
    for (let depth = 0; cur != null && depth < 8; depth++) {
        const code = (cur as { code?: unknown }).code;
        if (typeof code === 'string') return code;
        cur = (cur as { cause?: unknown }).cause;
    }
    return undefined;
}

/** Pull an `HTTP <status>` out of an error message when the status isn't carried structurally. */
function statusFromMessage(msg: string | undefined): number | undefined {
    if (msg === undefined) return undefined;
    const g = /\bHTTP (\d{3})\b/.exec(msg)?.[1];
    return g !== undefined ? Number(g) : undefined;
}

/**
 * Classify a failed download as retryable-vs-terminal with a best-effort machine `code`.
 *
 * Two sources, deliberately, and the order matters. `raw` is the UNTOUCHED transport error captured
 * via `download()`'s `hooks.onError`; `reason` is the flattened {@link StitchError}, which carries the
 * HTTP `status` when the failure came from a response.
 *
 * `raw` is read FIRST because it is the error itself rather than a rebuild of it. The fallback to
 * `causeCode(reason)` is no longer the dead branch it was when this was written: core's cause-carry
 * (#450, shipped alongside this package) pins the transport error on the error event's non-enumerable
 * channel, so `reason.cause` now reaches an awaited / `.safe()` caller with its `.code` intact. The
 * hook seam is kept because it is strictly wider — it also catches a thrown non-`Error`, which has no
 * `cause` chain to walk.
 */
export function classifyFailure(
    reason: StitchError,
    raw: unknown,
): Classification {
    const code = causeCode(raw) ?? causeCode(reason);
    if (code !== undefined && RETRYABLE_CODES.has(code))
        return { retryable: true, code };

    const status =
        reason.status ??
        statusFromMessage(reason.message) ??
        statusFromMessage(raw instanceof Error ? raw.message : undefined);
    if (status !== undefined) {
        // 5xx and the two "try again" 4xx (429 rate-limit, 408 request-timeout) are retryable; every
        // other 4xx is terminal — a retry can't fix a 404/401/403.
        const retryable = status >= 500 || status === 429 || status === 408;
        return { retryable, code: code ?? `HTTP_${status}` };
    }

    // No status and no known transport code: fall back to the message. A bare `fetch failed` / socket
    // / network error is a transport fault → retryable; anything else, assume terminal.
    const msg = (raw instanceof Error ? raw.message : reason.message) ?? '';
    const transportish =
        /fetch failed|socket|network|terminated|econn|dns|timeout|timed out|aborted/i.test(
            msg,
        );
    return compact({ retryable: transportish, code });
}
