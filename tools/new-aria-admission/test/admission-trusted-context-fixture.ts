import type { FileCurrentEpochProvider } from '../src/adapters/file-current-epoch-provider';
import type { FileEvidenceCheckpointStore } from '../src/adapters/file-evidence-checkpoint-store';
import type { TrustedCompletionContextInput } from '../src/application/trusted-completion-context';
import type { AuthorizedS01ProgressAuthority } from '../src/kernel/operator-progress-authority';

import type { verifiedGitTarget } from './git-target-fixture';
import { eventPolicyBytes, freshnessPolicyBytes } from './progress-fixture';

interface AdmissionEvidenceFixture {
  readonly trustRoot: Uint8Array;
}

export function trustedContextInput(
  fixture: AdmissionEvidenceFixture,
  checkpointStore: FileEvidenceCheckpointStore,
  verifiedTarget: ReturnType<typeof verifiedGitTarget>,
  executionRoot: Uint8Array,
  progressAuthority: AuthorizedS01ProgressAuthority,
  currentEpochProvider: FileCurrentEpochProvider,
): TrustedCompletionContextInput {
  return {
    progress_authority: progressAuthority,
    verified_target: verifiedTarget,
    evidence_trust_root_bytes: fixture.trustRoot,
    execution_trust_root_bytes: executionRoot,
    event_policy_bytes: eventPolicyBytes,
    freshness_policy_bytes: freshnessPolicyBytes,
    checkpoint_store: checkpointStore,
    current_epoch_provider: currentEpochProvider,
  };
}
