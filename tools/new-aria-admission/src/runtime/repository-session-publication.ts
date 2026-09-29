import type {
  FinalizedRepositoryExecutionRoster,
  OpenExecutionSessionRequest,
  RepositoryExecutionSession,
} from './repository-execution-contracts';
import type { ExecutableRunResult } from './executable-run-result';
import type { RepositoryExecutionState } from './repository-run-authentication';
import type { PrivateRepositorySnapshot } from './repository-snapshot-materializer';

export function publishRepositoryExecutionSession(
  input: OpenExecutionSessionRequest,
  trustRootBytes: Buffer,
  repository: PrivateRepositorySnapshot,
  revalidate: () => void,
  registry: WeakMap<object, RepositoryExecutionState>,
): RepositoryExecutionSession {
  const document = input.authority.authority.document;
  const session: RepositoryExecutionSession = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-repository-execution-session-v1',
    execution_session_id: document.execution_session_id,
    repository_id: document.repository_id,
    workspace_id: document.workspace_id,
    tree_sha: input.target.tree_sha,
  });
  registry.set(session, {
    authority: input.authority,
    target: input.target,
    trustRootBytes,
    repository,
    revalidate,
    expectedRuns: Object.freeze(['BASELINE', ...document.required_negative_control_ids]),
    usedRuns: new Set(),
    finalizedRuns: new Map(),
    signingCapability: input.signing_capability,
    currentEpochProvider: input.current_epoch_provider,
    baselineObjectSha256s: undefined,
    baselineRunContextSha256: undefined,
    closed: false,
  });
  return session;
}

export function publishFinalizedRepositoryExecutionRoster(
  session: RepositoryExecutionSession,
  completed: readonly ExecutableRunResult[],
  registry: WeakMap<object, readonly ExecutableRunResult[]>,
): FinalizedRepositoryExecutionRoster {
  const roster: FinalizedRepositoryExecutionRoster = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-finalized-execution-roster-v1',
    execution_session_id: session.execution_session_id,
    repository_id: session.repository_id,
    workspace_id: session.workspace_id,
    tree_sha: session.tree_sha,
  });
  registry.set(roster, completed);
  return roster;
}
