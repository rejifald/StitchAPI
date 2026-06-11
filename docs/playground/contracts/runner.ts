/**
 * Frozen re-export of the existing `CodeRunner` contract.
 *
 * The canonical definitions still live in `../component/runner.ts` — moving them
 * would break `../component/StitchPlayground.tsx`, which imports `{ CodeRunner,
 * RunResult, mockRunner }` from `./runner`. So this module re-exports them,
 * giving every downstream sandbox task (S*, R*, D1, U1, T-α) a single import
 * surface under `contracts/` without disturbing the UI shell's import path.
 *
 * Frozen by C1 (Wave 0). Do not widen here — see ./README.md.
 */
export type {
    CodeRunner,
    RunRequest,
    RunResult,
    RunError,
    RunNotice,
    RunEvent,
    StitchTraceEntry,
    LogEntry,
    LogLevel,
} from '../component/runner';
