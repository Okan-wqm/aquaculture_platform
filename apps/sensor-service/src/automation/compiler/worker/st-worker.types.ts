/**
 * ST Worker Thread Types
 *
 * Re-exports from compiler.types.ts for convenience.
 * Worker-specific types that are not in compiler.types.ts are defined here.
 */

export type {
  WorkerInput,
  WorkerOutput,
  WorkerAnalyzeResult,
  WorkerCompleteResult,
  WorkerHoverResult,
  WorkerFormatResult,
  WorkerOutlineResult,
  WorkerDefinitionResult,
  WorkerReferencesResult,
  WorkerLimits,
  WorkerError,
  WorkerTaskType,
  Diagnostic,
  OutlineNode,
  CompletionEntry,
  DefinitionLocation,
  ReferenceLocation,
} from '../compiler.types';

/** Worker pool status for health checks */
export interface WorkerPoolStatus {
  /** Number of currently running tasks */
  runningTasks: number;
  /** Number of tasks waiting in queue */
  waitingTasks: number;
  /** Total number of worker threads */
  threads: number;
  /** Whether the pool is accepting new tasks */
  accepting: boolean;
}

/** Error codes for worker operations */
export const WorkerErrorCodes = {
  TIMEOUT: 'WORKER_TIMEOUT',
  BUSY: 'WORKER_BUSY',
  PARSE_ERROR: 'WORKER_PARSE_ERROR',
  INTERNAL_ERROR: 'WORKER_INTERNAL_ERROR',
  ABORTED: 'WORKER_ABORTED',
  SOURCE_TOO_LARGE: 'WORKER_SOURCE_TOO_LARGE',
} as const;

export type WorkerErrorCode = typeof WorkerErrorCodes[keyof typeof WorkerErrorCodes];
