import type { EvidenceReference } from '../domain/evidence-contracts';
import { parseCanonicalEvidenceObject, verifyDigestObject } from '../kernel/evidence-object';
import { loadOracleBaselineDocument } from '../kernel/oracle-baseline';
import type { VerifiedCurrentEpochSnapshot } from '../kernel/current-epoch-provider';
import type {
  AuthorizedS01ProgressAuthority,
  HistoricallyVerifiedS01ProgressAuthority,
  VerifiedS01ProgressAuthority,
} from '../kernel/operator-progress-authority';
import { assertBaselineVerifierOutput } from '../runtime/verifier-baseline-output';
import { authenticateVerifierSnapshotInput } from '../verifier/authenticated-input';
import { authenticateHistoricalVerifierSnapshotInput } from '../verifier/historical-authenticated-input';

import {
  snapshotExecutableRepositoryTarget,
  type VerifiedRepositoryTarget,
} from './repository-target-verifier';
import type { VerifiedVerifyingHistory } from './verifying-history-admission';

interface CompletionPlanManifest {
  readonly inputs: readonly EvidenceReference[];
  readonly report: EvidenceReference;
}

interface CompletionPlanArtifacts {
  readonly report_bytes: Buffer;
  readonly authentication_objects: readonly Buffer[];
}

export interface HistoricalVerificationPlanEvidence extends VerifiedVerifyingHistory {
  readonly current_epoch_snapshot: VerifiedCurrentEpochSnapshot;
}

function readPlanArtifacts(
  manifest: CompletionPlanManifest,
  objects: ReadonlyMap<string, Uint8Array>,
  authority: VerifiedS01ProgressAuthority,
  currentEpochSnapshotSha256: string,
): CompletionPlanArtifacts {
  const inputReference = manifest.inputs[0];
  if (manifest.inputs.length !== 1 || inputReference === undefined) {
    throw new TypeError('completion requires one execution-free verifier baseline');
  }
  const input = parseCanonicalEvidenceObject(
    { uri: inputReference.uri, sha256: inputReference.sha256 },
    objects,
    'completion verifier baseline',
  );
  const baseline = loadOracleBaselineDocument(input.reference.bytes);
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
    throw new TypeError('completion verifier baseline differs from signed authority');
  const report = parseCanonicalEvidenceObject(
    { uri: manifest.report.uri, sha256: manifest.report.sha256 },
    objects,
    'completion verifier report',
  );
  const envelopeBytes = verifyDigestObject(
    authority.envelope_sha256,
    objects,
    'completion operator authority envelope',
    true,
  );
  const operatorRootBytes = verifyDigestObject(
    authority.trust_root_sha256,
    objects,
    'completion operator trust root',
    true,
  );
  const epochSnapshotBytes = verifyDigestObject(
    currentEpochSnapshotSha256,
    objects,
    'completion current epoch snapshot',
    true,
  );
  return Object.freeze({
    report_bytes: Buffer.from(report.reference.bytes),
    authentication_objects: Object.freeze([
      Buffer.from(input.reference.bytes),
      Buffer.from(envelopeBytes),
      Buffer.from(operatorRootBytes),
      Buffer.from(epochSnapshotBytes),
    ]),
  });
}

function verifiedHistory(
  reportBytes: Uint8Array,
  dossier: Parameters<typeof assertBaselineVerifierOutput>[1],
): VerifiedVerifyingHistory {
  assertBaselineVerifierOutput(
    Buffer.concat([Buffer.from(reportBytes), Buffer.from('\n')]),
    dossier,
  );
  return Object.freeze({
    event_chain_bytes: Buffer.from(dossier.event_chain_bytes),
    manifest_chain_bytes: Object.freeze(
      dossier.manifest_chain_bytes.map((bytes) => Buffer.from(bytes)),
    ),
    manifest_chain_sha256s: Object.freeze([...dossier.manifest_chain_sha256s]),
  });
}

export function assertSignedVerificationPlanEvidence(
  manifest: CompletionPlanManifest,
  objects: ReadonlyMap<string, Uint8Array>,
  authority: AuthorizedS01ProgressAuthority,
  target: VerifiedRepositoryTarget,
  currentEpochSnapshotSha256: string,
): VerifiedVerifyingHistory {
  const artifacts = readPlanArtifacts(
    manifest,
    objects,
    authority,
    currentEpochSnapshotSha256,
  );
  const authenticated = authenticateVerifierSnapshotInput(
    artifacts.authentication_objects,
    authority.trust_root_sha256,
    snapshotExecutableRepositoryTarget(target),
    ['--mode', 'full', '--operator-trust-root-sha256', authority.trust_root_sha256],
  );
  if (
    authenticated.authority.authority.sha256 !== authority.authority.sha256 ||
    authenticated.authority.envelope_sha256 !== authority.envelope_sha256
  )
    throw new TypeError('completion verifier authority changed during recomputation');
  return verifiedHistory(artifacts.report_bytes, authenticated.verification.dossier);
}

export function assertHistoricalSignedVerificationPlanEvidence(
  manifest: CompletionPlanManifest,
  objects: ReadonlyMap<string, Uint8Array>,
  authority: HistoricallyVerifiedS01ProgressAuthority,
  target: VerifiedRepositoryTarget,
  currentEpochSnapshotSha256: string,
  receiptEpochReadAt: string,
): HistoricalVerificationPlanEvidence {
  const artifacts = readPlanArtifacts(
    manifest,
    objects,
    authority,
    currentEpochSnapshotSha256,
  );
  const authenticated = authenticateHistoricalVerifierSnapshotInput(
    artifacts.authentication_objects,
    authority,
    snapshotExecutableRepositoryTarget(target),
    ['--mode', 'full', '--operator-trust-root-sha256', authority.trust_root_sha256],
    receiptEpochReadAt,
  );
  const history = verifiedHistory(artifacts.report_bytes, authenticated.verification.dossier);
  return Object.freeze({
    ...history,
    current_epoch_snapshot: authenticated.current_epoch_snapshot,
  });
}
