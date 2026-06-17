/**
 * Seed-task registry — the four Wave-4 eval tasks as plain data.
 *
 * Add a task by authoring a `tasks/<id>.ts` data module and listing it here.
 */
import { oauth2ClientCredentials } from './oauth2-client-credentials';
import { paginatedListRetriesValidate } from './paginated-list-retries-validate';
import { streamLlmCompletion } from './stream-llm-completion';
import type { EvalTask } from './types';
import { wrapGraphqlEndpoint } from './wrap-graphql-endpoint';

export type { EvalTask, TaskFamily } from './types';
export { isRecord, isUserArray } from './types';

/** Every seed task, in a stable display order. */
export const TASKS: readonly EvalTask[] = [
    paginatedListRetriesValidate,
    oauth2ClientCredentials,
    wrapGraphqlEndpoint,
    streamLlmCompletion,
];

/** Look up a task by id, or `undefined` if unknown. */
export function getTask(id: string): EvalTask | undefined {
    return TASKS.find((t) => t.id === id);
}

/** All task ids (for CLI usage / error messages). */
export function taskIds(): string[] {
    return TASKS.map((t) => t.id);
}
