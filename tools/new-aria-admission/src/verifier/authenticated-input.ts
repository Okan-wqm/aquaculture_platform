import { canonicalJsonBytes } from '../kernel/canonical-json';
import { digestBytes } from '../kernel/evidence-object';
import { verifyCurrentEpochSnapshot } from '../kernel/current-epoch-provider';
import { authorizeS01ProgressAuthority } from '../kernel/operator-progress-authority';
import type {
  AuthorizedS01ProgressAuthority,
  VerifiedS01ProgressAuthority,
} from '../kernel/operator-progress-authority';

import { loadVerifierBaselineInput, verifyVerifierBaselineInput } from './baseline-input';
import type { VerifiedVerifierBaseline } from './baseline-input';
import type { TrustedDossierScope } from './verification-dossier';
import {
  directoryRepositoryArtifactSource,
  snapshotRepositoryArtifactSource,
} from './repository-artifact';
import type { RepositoryArtifactSource } from './repository-artifact';
import type { RepositoryExecutionSnapshot } from '../application/repository-execution-snapshot';

export interface VerifiedVerifierContext {
  readonly authority: VerifiedS01ProgressAuthority;
  readonly scope: TrustedDossierScope;
  readonly verification: VerifiedVerifierBaseline;
}

export interface AuthenticatedVerifierInput extends VerifiedVerifierContext {
  readonly authority: AuthorizedS01ProgressAuthority;
}

export function assertBaselineAuthority(
  baseline: ReturnType<typeof loadVerifierBaselineInput>,
  authority: VerifiedS01ProgressAuthority,
): void {
  const document = authority.authority.document;
  if (
    baseline.authority_sha256 !== authority.authority.sha256 ||
    baseline.repository_id !== document.repository_id ||
    baseline.workspace_id !== document.workspace_id ||
    baseline.base_sha !== document.base_sha ||
    baseline.head_sha !== document.head_sha ||
    baseline.evidence_id !== document.evidence_id ||
    baseline.program_id !== document.program_id ||
    baseline.sprint_id !== document.sprint_id ||
    baseline.event_policy_sha256 !== document.event_policy_sha256 ||
    baseline.freshness_policy_sha256 !== document.freshness_policy_sha256 ||
    baseline.epoch_provider_id !== document.invalidation_epoch_provider_id ||
    baseline.epoch_provider_identity_sha256 !==
      document.invalidation_epoch_provider_identity_sha256 ||
    baseline.verification_plan_sha256 !== document.verification_plan_sha256
  )
    throw new TypeError('verifier baseline does not match signed operator authority');
}

export function exactAuthorityEpochs(
  authority: VerifiedS01ProgressAuthority,
  entries: readonly (readonly [string, string])[],
): ReadonlyMap<string, string> {
  const document = authority.authority.document;
  const expected = new Map<string, string>([
    ['authority', `sha256:${authority.authority.sha256}`],
    ['dependency', `sha256:${document.dependency_sha256}`],
    ['policy', `sha256:${document.policy_epoch_sha256}`],
    ['toolchain', `sha256:${document.toolchain_sha256}`],
    ['verifier', `sha256:${document.verifier_sha256}`],
  ]);
  for (const [key, epoch] of entries) {
    if (expected.get(key) !== epoch) {
      throw new TypeError('current epoch snapshot differs from signed operator authority');
    }
  }
  expected.set('source_head', `git:${document.head_sha}`);
  return expected;
}

export function assertSignedInvocation(
  authority: VerifiedS01ProgressAuthority,
  baselineArgs: readonly string[],
): void {
  const document = authority.authority.document;
  const argv = [document.runtime_id, document.verifier_tool_id, ...baselineArgs];
  if (digestBytes(canonicalJsonBytes(argv)) !== document.verifier_argv_sha256) {
    throw new TypeError('verifier invocation differs from signed operator authority');
  }
}

function authenticate(
  objects: readonly Buffer[],
  expectedOperatorTrustRootSha256: string,
  repositoryArtifacts: RepositoryArtifactSource,
  baselineArgs: readonly string[],
): AuthenticatedVerifierInput {
  if (objects.length !== 4) {
    throw new TypeError('authenticated baseline requires four ordered input objects');
  }
  const [baselineBytes, envelopeBytes, trustRootBytes, epochSnapshotBytes] = objects;
  if (
    baselineBytes === undefined ||
    envelopeBytes === undefined ||
    trustRootBytes === undefined ||
    epochSnapshotBytes === undefined
  )
    throw new TypeError('authenticated baseline input roster is incomplete');
  const authority = authorizeS01ProgressAuthority({
    envelope_bytes: envelopeBytes,
    trust_root_bytes: trustRootBytes,
    expected_trust_root_sha256: expectedOperatorTrustRootSha256,
  });
  assertSignedInvocation(authority, baselineArgs);
  const baseline = loadVerifierBaselineInput(baselineBytes);
  assertBaselineAuthority(baseline, authority);
  const document = authority.authority.document;
  const now = Date.now();
  const epochSnapshot = verifyCurrentEpochSnapshot({
    snapshot_bytes: epochSnapshotBytes,
    operator_trust_root_bytes: trustRootBytes,
    expected_operator_trust_root_sha256: expectedOperatorTrustRootSha256,
    provider_id: document.invalidation_epoch_provider_id,
    provider_identity_sha256: document.invalidation_epoch_provider_identity_sha256,
    authority,
    now,
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
    repository_artifacts: repositoryArtifacts,
    event_policy_sha256: document.event_policy_sha256,
    freshness_policy_sha256: document.freshness_policy_sha256,
    current_time: new Date(now).toISOString(),
    current_invalidation_epochs: exactAuthorityEpochs(authority, epochSnapshot.epochs),
  });
  return Object.freeze({
    authority,
    scope,
    verification: verifyVerifierBaselineInput(baselineBytes, scope),
  });
}

export function authenticateVerifierInput(
  objects: readonly Buffer[],
  expectedOperatorTrustRootSha256: string,
  repositoryRoot: string,
  baselineArgs: readonly string[],
): AuthenticatedVerifierInput {
  return authenticate(
    objects,
    expectedOperatorTrustRootSha256,
    directoryRepositoryArtifactSource(repositoryRoot),
    baselineArgs,
  );
}

export function authenticateVerifierSnapshotInput(
  objects: readonly Buffer[],
  expectedOperatorTrustRootSha256: string,
  snapshot: RepositoryExecutionSnapshot,
  baselineArgs: readonly string[],
): AuthenticatedVerifierInput {
  return authenticate(
    objects,
    expectedOperatorTrustRootSha256,
    snapshotRepositoryArtifactSource(snapshot),
    baselineArgs,
  );
}
