'use client';

import type { SimKnobs } from '@stitchapi/sandbox/contracts/sim';
import { useState } from 'react';

/**
 * Controls for the fake API's reserved response knobs (`__status`,
 * `__latencyMs`, `__stream`, `__drift`, `__flaky` — see
 * docs/sandbox/contracts/sim.ts `SimKnobs`). Whatever is configured here is
 * applied AUTOMATICALLY to every call the next run makes — no copy/paste. The
 * builder owns the raw input strings and emits the parsed `SimKnobs` upward via
 * `onChange`; an explicit `?__…` in the snippet still wins for that call.
 *
 * Renders its own header bar (title + Clear) so it fills the aside pane on its
 * own, keeping the footer out of the way of the controls.
 */

type StreamMode = 'off' | 'chunked' | 'sse';

interface KnobsState {
    status: string;
    latencyMs: string;
    stream: StreamMode;
    drift: boolean;
    flaky: string;
}

const INITIAL: KnobsState = {
    status: '',
    latencyMs: '',
    stream: 'off',
    drift: false,
    flaky: '',
};

/** Parse the raw UI state into `SimKnobs`, dropping empty / off / invalid knobs
 *  so a blank field never shapes the response. */
function toSimKnobs(s: KnobsState): SimKnobs {
    const knobs: SimKnobs = {};
    const status = parseInt(s.status, 10);
    if (s.status.trim() && !isNaN(status)) knobs.status = status;
    const latencyMs = parseInt(s.latencyMs, 10);
    if (s.latencyMs.trim() && !isNaN(latencyMs)) knobs.latencyMs = latencyMs;
    if (s.stream !== 'off') knobs.stream = s.stream;
    if (s.drift) knobs.drift = true;
    const flaky = parseInt(s.flaky, 10);
    if (s.flaky.trim() && !isNaN(flaky)) knobs.flaky = flaky;
    return knobs;
}

/** Short header chips for the active knobs (in panel order). */
function activeChips(knobs: SimKnobs): string[] {
    const chips: string[] = [];
    if (knobs.status !== undefined) chips.push(`status ${knobs.status}`);
    if (knobs.latencyMs !== undefined) chips.push(`${knobs.latencyMs}ms`);
    if (knobs.stream !== undefined) chips.push(knobs.stream);
    if (knobs.flaky !== undefined) chips.push(`flaky ${knobs.flaky}`);
    if (knobs.drift) chips.push('drift');
    return chips;
}

export function KnobsBuilder({
    onChange,
}: {
    /** Called with the parsed knobs whenever the controls change. */
    onChange: (knobs: SimKnobs) => void;
}) {
    const [state, setState] = useState<KnobsState>(INITIAL);

    // Apply on every edit: merge the patch, push the parsed knobs upward. No
    // copy step — the next run reads these directly.
    const update = (patch: Partial<KnobsState>) => {
        const next = { ...state, ...patch };
        setState(next);
        onChange(toSimKnobs(next));
    };

    const clear = () => {
        setState(INITIAL);
        onChange({});
    };

    const chips = activeChips(toSimKnobs(state));

    return (
        <div className="stitch-knobs">
            <div
                className="stitch-knobs__head"
                title="Applied automatically to every call the next run makes"
            >
                <span className="stitch-knobs__head-title">Server knobs</span>
                {chips.length > 0 && (
                    <span className="stitch-knobs__chips">
                        {chips.map((c) => (
                            <span key={c} className="stitch-knobs__chip">
                                {c}
                            </span>
                        ))}
                    </span>
                )}
                <button
                    type="button"
                    className="stitch-knobs__clear"
                    onClick={clear}
                    disabled={!chips.length}
                >
                    Clear
                </button>
            </div>

            {/* Compact control bar: label + control only (the meaning is in each
                field's `title` tooltip), so the Console can dominate the column. */}
            <div className="stitch-knobs__body">
                <div className="stitch-knobs__grid">
                    <label
                        className="stitch-knobs__field"
                        title="Force the HTTP response status"
                    >
                        <span className="stitch-knobs__label">Status</span>
                        <input
                            type="text"
                            inputMode="numeric"
                            maxLength={3}
                            className="stitch-knobs__input stitch-knobs__input--num"
                            placeholder="200"
                            value={state.status}
                            onChange={(e) =>
                                update({
                                    status: e.target.value
                                        .replace(/\D/g, '')
                                        .slice(0, 3),
                                })
                            }
                        />
                    </label>

                    <label
                        className="stitch-knobs__field"
                        title="Delay every call by this many milliseconds"
                    >
                        <span className="stitch-knobs__label">Latency ms</span>
                        <input
                            type="text"
                            inputMode="numeric"
                            maxLength={6}
                            className="stitch-knobs__input stitch-knobs__input--num-wide"
                            placeholder="0"
                            value={state.latencyMs}
                            onChange={(e) =>
                                update({
                                    latencyMs: e.target.value
                                        .replace(/\D/g, '')
                                        .slice(0, 6),
                                })
                            }
                        />
                    </label>

                    <label
                        className="stitch-knobs__field"
                        title="Stream the response body"
                    >
                        <span className="stitch-knobs__label">Stream</span>
                        <select
                            className="stitch-knobs__input stitch-knobs__input--select"
                            value={state.stream}
                            onChange={(e) =>
                                update({ stream: e.target.value as StreamMode })
                            }
                        >
                            <option value="off">Off</option>
                            <option value="chunked">Chunked</option>
                            <option value="sse">SSE</option>
                        </select>
                    </label>

                    <label
                        className="stitch-knobs__field"
                        title="Fail the first N calls, then succeed"
                    >
                        <span className="stitch-knobs__label">Flaky</span>
                        <input
                            type="text"
                            inputMode="numeric"
                            maxLength={3}
                            className="stitch-knobs__input stitch-knobs__input--num"
                            placeholder="0"
                            value={state.flaky}
                            onChange={(e) =>
                                update({
                                    flaky: e.target.value
                                        .replace(/\D/g, '')
                                        .slice(0, 3),
                                })
                            }
                        />
                    </label>

                    <div
                        className="stitch-knobs__field stitch-knobs__field--switch"
                        title="Return a body that fails validation"
                    >
                        <span className="stitch-knobs__label">Drift</span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={state.drift}
                            aria-label="Schema drift"
                            className="stitch-knobs__switch"
                            data-on={state.drift}
                            onClick={() => update({ drift: !state.drift })}
                        >
                            <span className="stitch-knobs__switch-thumb" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default KnobsBuilder;
