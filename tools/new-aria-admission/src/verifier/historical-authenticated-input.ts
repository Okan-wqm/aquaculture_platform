import type { RepositoryExecutionSnapshot } from '../application/repository-execution-snapshot';
import { verifyHistoricalCurrentEpochSnapshot } from '../kernel/current-epoch-provider';
import type { VerifiedCurrentEpochSnapshot } from '../kernel/current-epoch-provider';
import { digestBytes } from '../kernel/evidence-object';
import type { HistoricallyVerifiedS01ProgressAuthority } from '../kernel/operator-progress-authority';

import {
  assertBaselineAuthority,
  assertSignedInvocation,
  exactAuthorityEpochs,
} from './authenticated-input';
import type { VerifiedVerifierContext } from './authenticated-input';
import { loadVerifierBaselineInput, verifyVerifierBaselineInput } from './baseline-input';
import type { VerifiedVerifierBaseline } from './baseline-input';
import { snapshotRepositoryArtifactSource } from './repository-artifact';
import type { TrustedDossierScope } from './verification-dossier';

export interface HistoricallyAuthenticatedVerifierInput extends VerifiedVerifierContext {
  readonly authority: HistoricallyVerifiedS01ProgressAuthority;
  readonly scope: TrustedDossierScope;
  readonly verification: VerifiedVerifierBaseline;
  readonly current_epoch_snapshot: VerifiedCurrentEpochSnapshot;
}

export function authenticateHistoricalVerifierSnapshotInput(
  objects: readonly Buffer[],
  authority: HistoricallyVerifiedS01ProgressAuthority,
  snapshot: RepositoryExecutionSnapshot,
  baselineArgs: readonly string[],
  receiptEpochReadAt: string,
): HistoricallyAuthenticatedVerifierInput {
  if (objects.length !== 4) {
    throw new TypeError('historical baseline requires four ordered input objects');
  }
  const [baselineBytes, envelopeBytes, trustRootBytes, epochSnapshotBytes] = objects;
  if (
    baselineBytes === undefined ||
    envelopeBytes === undefined ||
    trustRootBytes === undefined ||
    epochSnapshotBytes === undefined
  )
    throw new TypeError('historical baseline input roster is incomplete');
  if (
    digestBytes(envelopeBytes) !== authority.envelope_sha256 ||
    digestBytes(trustRootBytes) !== authority.trust_root_sha256
  )
    throw new TypeError('historical baseline authentication objects differ from authority');
  assertSignedInvocation(authority, baselineArgs);
  const baseline = loadVerifierBaselineInput(baselineBytes);
  assertBaselineAuthority(baseline, authority);
  const document = authority.authority.document;
  const epoch = verifyHistoricalCurrentEpochSnapshot({
    snapshot_bytes: epochSnapshotBytes,
    operator_trust_root_bytes: trustRootBytes,
    expected_operator_trust_root_sha256: authority.trust_root_sha256,
    provider_id: document.invalidation_epoch_provider_id,
    provider_identity_sha256: document.invalidation_epoch_provider_identity_sha256,
    authority,
    receipt_epoch_read_at: receiptEpochReadAt,
  });
  const scope: TrustedDossierScope = Object.freeze({
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
    repository_artifacts: snapshotRepositoryArtifactSource(snapshot),
    event_policy_sha256: document.event_policy_sha256,
    freshness_policy_sha256: document.freshness_policy_sha256,
    current_time: receiptEpochReadAt,
    current_invalidation_epochs: exactAuthorityEpochs(authority, epoch.epochs),
  });
  return Object.freeze({
    authority,
    scope,
    verification: verifyVerifierBaselineInput(baselineBytes, scope),
    current_epoch_snapshot: epoch,
  });
}
