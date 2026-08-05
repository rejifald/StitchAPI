// The construction under test, in one place: two providers of the same SHAPE that are not
// interchangeable on the wire.
//
//   primary  POST https://primary.llm.test/v1/complete   Authorization: Bearer pk-primary
//   backup   POST https://backup.llm.test/generate       x-api-key: sk-backup
//
// Different origin, different path, different auth scheme, different success body. That is the
// normal case for a provider pair — "interchangeable sources" is a property of the CAPABILITY, not
// of the endpoint — and C4 is the claim that measures whether the combinators can address it.
import { apiKey, bearer } from '../../../../packages/core/src/auth';
import { stitch } from '../../../../packages/core/src/index';
import {
    type ManualClock,
    manualClock,
} from '../../../../packages/core/src/testing';
import type {
    Stitch,
    StitchConfig,
    TraceSink,
} from '../../../../packages/core/src/types';
import { type ProviderPair, providerPair } from './fake-provider';

export interface Rig {
    clock: ManualClock;
    p: ProviderPair;
    primary: Stitch<unknown>;
    backup: Stitch<unknown>;
}

export interface RigOptions {
    trace?: TraceSink;
    /** Extra config merged into BOTH stitches — `retry`, `circuit`, `store`, `verdict`, … */
    each?: Partial<StitchConfig>;
    /** Extra config for the primary only. */
    onPrimary?: Partial<StitchConfig>;
    /** Extra config for the backup only. */
    onBackup?: Partial<StitchConfig>;
}

/** Both providers, both stitches, one injected clock. */
export function rig(opts: RigOptions = {}): Rig {
    const clock = manualClock();
    const p = providerPair(clock);
    const common: Partial<StitchConfig> = {
        method: 'POST',
        clock,
        ...(opts.trace ? { trace: opts.trace } : {}),
        ...opts.each,
    };
    const primary = stitch({
        name: 'primary',
        url: `${p.primary.origin}${p.primary.path}`,
        adapter: p.primary.adapter(),
        auth: bearer('pk-primary'),
        ...common,
        ...opts.onPrimary,
    });
    const backup = stitch({
        name: 'backup',
        url: `${p.backup.origin}${p.backup.path}`,
        adapter: p.backup.adapter(),
        auth: apiKey({ in: 'header', name: 'x-api-key', secret: 'sk-backup' }),
        ...common,
        ...opts.onBackup,
    });
    return { clock, p, primary, backup };
}
