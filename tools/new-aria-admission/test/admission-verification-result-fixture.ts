import { readCurrentEpochSnapshot } from '../src/adapters/file-current-epoch-provider';
import type { FileCurrentEpochProvider } from '../src/adapters/file-current-epoch-provider';
import {
  snapshotExecutableRepositoryTarget,
  type VerifiedRepositoryTarget,
} from '../src/application/repository-target-verifier';
import type { JsonRecord } from '../src/kernel/evidence-object';
import type { AuthorizedS01ProgressAuthority } from '../src/kernel/operator-progress-authority';
import { snapshotRepositoryArtifactSource } from '../src/verifier/repository-artifact';
import { verifyS01VerificationDossier } from '../src/verifier/verification-dossier';
import type { VerifiedDossierResult } from '../src/verifier/verification-dossier';

export function verifiedDossierResult(
  dossier: JsonRecord,
  authority: AuthorizedS01ProgressAuthority,
  target: VerifiedRepositoryTarget,
  provider: FileCurrentEpochProvider,
): VerifiedDossierResult {
  const document = authority.authority.document;
  const epoch = readCurrentEpochSnapshot(provider, authority);
  return verifyS01VerificationDossier(dossier, {
    authority_sha256: authority.authority.sha256,
    verification_plan_sha256: document.verification_plan_sha256,
    repository_id: document.repository_id,
    workspace_id: document.workspace_id,
    base_sha: document.base_sha,
    head_sha: document.head_sha,
    evidence_id: document.evidence_id,
    program_id: document.program_id,
    sprint_id: document.sprint_id,
    acceptance_ids: document.acceptance_ids,
    finding_ids: document.finding_ids,
    epoch_provider_id: document.invalidation_epoch_provider_id,
    epoch_provider_identity_sha256: document.invalidation_epoch_provider_identity_sha256,
    repository_artifacts: snapshotRepositoryArtifactSource(
      snapshotExecutableRepositoryTarget(target),
    ),
    event_policy_sha256: document.event_policy_sha256,
    freshness_policy_sha256: document.freshness_policy_sha256,
    current_time: epoch.read_at,
    current_invalidation_epochs: new Map([
      ...epoch.epochs,
      ['source_head', `git:${target.head_sha}`] as const,
    ]),
  });
}
