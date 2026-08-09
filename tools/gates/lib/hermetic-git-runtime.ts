/**
 * Production-safe façade for the descriptor-bound Git kernel.
 *
 * Raw runtime construction, arbitrary descriptor cleanup, and direct file fingerprint test hooks
 * are intentionally absent. Tests receive those capabilities only through the closed
 * hermetic-git-runtime.fixture module and its exact reverse-import authority.
 */
export {
  CANONICAL_GIT_HEAD_TREE_ARGS,
  CANONICAL_GIT_INDEX_ARGS,
  CANONICAL_GIT_INDEX_FSMONITOR_ARGS,
  CANONICAL_GIT_UNTRACKED_ARGS,
  CANONICAL_GIT_UNTRACKED_GITIGNORE_ARGS,
  HERMETIC_GIT_EXECUTION_MODES_V1,
  HERMETIC_GIT_EXECUTION_POLICY_V1,
  HERMETIC_GIT_RUNTIME,
  HermeticGitExecutionCleanupError,
  HermeticGitExecutionTimeoutError,
  HermeticGitSynchronousBudgetError,
  InventoryInspectionError,
  REPOSITORY_CHILD_FD_COORDINATES_V1,
  captureCanonicalGitWorktreeStatus,
  computeCanonicalGitWorktreeEvidence,
  runWithHermeticGitExecutionBudget,
  runWithHermeticGitExecutionDeadline,
} from './hermetic-git-runtime.kernel';

export type {
  CanonicalGitWorktreeEvidence,
  CanonicalGitWorktreeEvidenceObserver,
  CanonicalGitWorktreeStatus,
  GitStreamFingerprint,
  HermeticGitAttestation,
  HermeticGitBufferResult,
  HermeticGitProductionRuntimeV1,
  HermeticGitReadQueryV1,
  HermeticGitRepositoryAsyncSessionV1,
  HermeticGitRepositorySyncSessionV1,
  HermeticGitTextResult,
} from './hermetic-git-runtime.kernel';
