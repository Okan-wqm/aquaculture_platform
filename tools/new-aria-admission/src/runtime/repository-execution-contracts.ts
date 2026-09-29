import type { VerifiedRepositoryTarget } from '../application/repository-target-verifier';
import type { FileCurrentEpochProvider } from '../adapters/file-current-epoch-provider';
import type { ExecutionSigningCapability } from '../kernel/execution-signing-capability';
import type { AuthorizedS01ProgressAuthority } from '../kernel/operator-progress-authority';

import type { ExecutableRunEvidence } from './executable-run-result';

export interface RepositoryExecutionSession {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-repository-execution-session-v1';
  readonly execution_session_id: string;
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly tree_sha: string;
}

export interface FinalizedRepositoryExecutionRoster {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-finalized-execution-roster-v1';
  readonly execution_session_id: string;
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly tree_sha: string;
}

export interface OpenExecutionSessionRequest {
  readonly authority: AuthorizedS01ProgressAuthority;
  readonly target: VerifiedRepositoryTarget;
  readonly signing_capability: ExecutionSigningCapability;
  readonly execution_trust_root_bytes: Uint8Array;
  readonly current_epoch_provider: FileCurrentEpochProvider;
}

export interface RepositorySessionRunRequest {
  readonly session: RepositoryExecutionSession;
  readonly run_id: string;
  readonly run_context_sha256: string;
  readonly tool_path: string;
  readonly tool_sha256: string;
  readonly runtime_sha256: string;
  readonly tool_id: string;
  readonly input_envelope_bytes: Uint8Array;
  readonly args: readonly string[];
}

export interface ExecutedSessionRun {
  readonly evidence: ExecutableRunEvidence;
  readonly input_envelope: Buffer;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}
