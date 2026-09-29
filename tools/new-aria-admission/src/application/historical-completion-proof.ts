import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../kernel/canonical-json';
import {
  loadCompletionProjectionArtifact,
  serializeCompletionProjectionArtifact,
} from '../kernel/completion-projection-artifact';
import { verifyEventChain } from '../kernel/event-chain';
import { verifyEventEvidenceHistory } from '../kernel/event-evidence-history';
import { verifyHistoricalEvidenceAttestation } from '../kernel/evidence-attestation';
import { manifestSha256 } from '../kernel/evidence-chain';
import { assertExactEvidenceObjectClosure } from '../kernel/evidence-object-closure';
import { negativeControlSetSha256 } from '../kernel/evidence-oracle';
import { verifyHistoricalExecutionReceiptRoster } from '../kernel/execution-receipt-admission';
import { evaluateFreshness } from '../kernel/freshness';
import { loadFreshnessPolicy } from '../kernel/freshness-policy';
import { ImmutableStringMap } from '../kernel/immutable-string-map';
import {
  assertHistoricallyVerifiedS01ProgressAuthority,
  type HistoricallyVerifiedS01ProgressAuthority,
} from '../kernel/operator-progress-authority';
import { eventPolicySha256, loadEventPolicy } from '../kernel/policy';

import { snapshotCompletionCandidate, type CompletionCandidate } from './completion-candidate';
import { assertCompletionIdentitySeparation } from './completion-identity-separation';
import {
  assertHistoricalCompletionAuthorityScope,
  historicalCompletionProjection,
} from './historical-completion-binding';
import {
  assertExecutableRepositoryTarget,
  type VerifiedRepositoryTarget,
} from './repository-target-verifier';
import { assertHistoricalSignedVerificationPlanEvidence } from './verification-plan-admission';
import { assertCompletionVerifyingHistory } from './verifying-history-admission';

export interface HistoricalCompletionProofInput {
  readonly authority: HistoricallyVerifiedS01ProgressAuthority;
  readonly target: VerifiedRepositoryTarget;
  readonly candidate: CompletionCandidate;
  readonly evidence_trust_root_bytes: Uint8Array;
  readonly execution_trust_root_bytes: Uint8Array;
  readonly event_policy_bytes: Uint8Array;
  readonly freshness_policy_bytes: Uint8Array;
  readonly projection_artifact_bytes: Uint8Array;
}

export interface HistoricallyVerifiedCompletionProof {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-historical-completion-proof-v1';
  readonly historical_verdict: 'HISTORICALLY_VALID';
  readonly current: false;
  readonly authority_sha256: string;
  readonly evidence_id: string;
  readonly version: number;
  readonly evidence_sha256: string;
  readonly history_sha256: string;
  readonly event_chain_sha256: string;
  readonly attestation_sha256: string;
  readonly projection_sha256: string;
  readonly valid_from: string;
  readonly valid_until: string;
}

const projectionBytes = new WeakMap<object, Buffer>();

function latest(values: readonly string[]): string {
  const value = [...values].sort().at(-1);
  if (value === undefined) throw new TypeError('historical proof observation is missing');
  return value;
}

function earliest(values: readonly string[]): string {
  const value = [...values].sort()[0];
  if (value === undefined) throw new TypeError('historical proof deadline is missing');
  return value;
}

function ownedBytes(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be bytes`);
  if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) {
    throw new TypeError(`${label} cannot use shared mutable memory`);
  }
  return Buffer.from(value);
}

export function verifyHistoricalCompletionProof(
  input: HistoricalCompletionProofInput,
): HistoricallyVerifiedCompletionProof {
  assertHistoricallyVerifiedS01ProgressAuthority(input.authority);
  assertExecutableRepositoryTarget(input.target);
  const candidate = snapshotCompletionCandidate(input.candidate);
  const evidenceRoot = ownedBytes(input.evidence_trust_root_bytes, 'evidence trust root');
  const executionRoot = ownedBytes(input.execution_trust_root_bytes, 'execution trust root');
  const eventPolicyBytes = ownedBytes(input.event_policy_bytes, 'event policy');
  const freshnessPolicyBytes = ownedBytes(input.freshness_policy_bytes, 'freshness policy');
  const artifactBytes = ownedBytes(input.projection_artifact_bytes, 'completion projection');
  assertCompletionIdentitySeparation(input.authority, evidenceRoot, executionRoot);
  const eventPolicy = loadEventPolicy(eventPolicyBytes);
  const freshnessPolicy = loadFreshnessPolicy(freshnessPolicyBytes);
  const document = input.authority.authority.document;
  if (
    eventPolicySha256(eventPolicyBytes) !== document.event_policy_sha256 ||
    freshnessPolicy.sha256 !== document.freshness_policy_sha256
  )
    throw new TypeError('historical completion policy differs from signed authority');
  const events = verifyEventChain(candidate.event_bytes, eventPolicy);
  const history = verifyEventEvidenceHistory(events, candidate.manifest_bytes, candidate.objects);
  const manifest = history.final_manifest;
  const manifestBytes = candidate.manifest_bytes.at(-1);
  const tail = events.at(-1);
  if (manifestBytes === undefined || tail === undefined || tail.to_state !== 'DONE') {
    throw new TypeError('historical completion tail is not DONE');
  }
  const evidenceSha256 = manifestSha256(manifestBytes);
  const historySha256 = createHash('sha256')
    .update(canonicalJsonBytes(candidate.manifest_bytes.map(manifestSha256)))
    .digest('hex');
  if (
    tail.evidence_sha256 !== evidenceSha256 ||
    tail.evidence_uri !== `aria-evidence://sha256/${evidenceSha256}` ||
    tail.authority_sha256 !== input.authority.authority.sha256 ||
    tail.target_sha !== manifest.target.head_sha
  )
    throw new TypeError('historical completion tail evidence is invalid');
  assertHistoricalCompletionAuthorityScope(input.authority, input.target, manifest);
  const plan = assertHistoricalSignedVerificationPlanEvidence(
    manifest,
    candidate.objects,
    input.authority,
    input.target,
    manifest.execution.current_epoch_snapshot_sha256,
    manifest.execution.current_epoch_read_at,
  );
  assertCompletionVerifyingHistory(
    candidate.event_bytes,
    candidate.manifest_bytes,
    manifest.previous_manifest_sha256,
    plan,
  );
  assertExactEvidenceObjectClosure([manifest], candidate.objects);
  const epochs = new ImmutableStringMap([
    ...plan.current_epoch_snapshot.epochs,
    ['source_head', `git:${document.head_sha}`] as const,
  ]);
  const receipts = verifyHistoricalExecutionReceiptRoster({
    manifest,
    objects: candidate.objects,
    authority: input.authority,
    trust_root_bytes: executionRoot,
    target: input.target,
    current_epoch: {
      provider_identity_sha256: document.invalidation_epoch_provider_identity_sha256,
      ...plan.current_epoch_snapshot,
    },
  });
  const eventChainSha256 = createHash('sha256').update(candidate.event_bytes).digest('hex');
  const tailHash = tail.event_hash;
  const tailOccurredAt = tail.occurred_at;
  if (typeof tailHash !== 'string' || typeof tailOccurredAt !== 'string') {
    throw new TypeError('historical completion event fields are invalid');
  }
  const attestation = verifyHistoricalEvidenceAttestation({
    envelope_bytes: candidate.evidence_attestation_bytes,
    trust_root_bytes: evidenceRoot,
    expected: {
      trust_root_sha256: document.evidence_trust_root_sha256,
      manifest_sha256: evidenceSha256,
      authority_sha256: input.authority.authority.sha256,
      event_chain_sha256: eventChainSha256,
      tail_event_hash: tailHash,
      target_head_sha: manifest.target.head_sha,
      oracle_report_sha256: manifest.oracle.report.sha256,
      negative_controls_sha256: negativeControlSetSha256(manifest.oracle.negative_controls),
      ...manifest.identities,
    },
    current_invalidation_epochs: epochs,
    freshness_policy: freshnessPolicy.document,
  });
  const validFrom = latest([
    input.authority.observed_at,
    manifest.observed_at,
    attestation.observed_at,
    plan.current_epoch_snapshot.observed_at,
    ...receipts.map(({ document: receipt }) => receipt.issued_at),
  ]);
  const validUntil = earliest([
    input.authority.valid_until,
    plan.current_epoch_snapshot.valid_until,
    manifest.freshness.valid_until,
    attestation.valid_until,
  ]);
  if (
    Date.parse(manifest.observed_at) > Date.parse(tailOccurredAt) ||
    Date.parse(tailOccurredAt) > Date.parse(attestation.observed_at) ||
    evaluateFreshness(
      manifest.freshness,
      { now: validFrom, current_invalidation_epochs: epochs },
      freshnessPolicy.document,
    ) !== 'CURRENT' ||
    Date.parse(validFrom) > Date.parse(validUntil)
  )
    throw new TypeError('historical completion time or freshness evidence is invalid');
  const projection = historicalCompletionProjection(input.authority, {
    evidence_sha256: evidenceSha256,
    event_chain_sha256: eventChainSha256,
    attestation_sha256: attestation.sha256,
    tail_event_hash: tailHash,
    verified_at: attestation.observed_at,
    valid_from: validFrom,
    valid_until: validUntil,
  });
  const expectedProjection = serializeCompletionProjectionArtifact(projection);
  loadCompletionProjectionArtifact(artifactBytes);
  if (!expectedProjection.equals(artifactBytes)) {
    throw new TypeError('historical completion projection differs from recomputation');
  }
  const proof: HistoricallyVerifiedCompletionProof = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-historical-completion-proof-v1',
    historical_verdict: 'HISTORICALLY_VALID',
    current: false,
    authority_sha256: input.authority.authority.sha256,
    evidence_id: manifest.evidence_id,
    version: manifest.version,
    evidence_sha256: evidenceSha256,
    history_sha256: historySha256,
    event_chain_sha256: eventChainSha256,
    attestation_sha256: attestation.sha256,
    projection_sha256: createHash('sha256').update(expectedProjection).digest('hex'),
    valid_from: validFrom,
    valid_until: validUntil,
  });
  projectionBytes.set(proof, expectedProjection);
  return proof;
}

export function historicalCompletionProjectionBytes(
  proof: HistoricallyVerifiedCompletionProof,
): Buffer {
  const bytes = projectionBytes.get(proof);
  if (bytes === undefined)
    throw new TypeError('historical completion proof was not verifier-issued');
  return Buffer.from(bytes);
}
