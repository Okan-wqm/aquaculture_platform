import {
  checkpointStoreIdentityFor,
  recoverCommittedCheckpointProjection,
} from '../adapters/file-evidence-checkpoint-store';
import { loadCompletionProjectionArtifact } from '../kernel/completion-projection-artifact';
import {
  assertHistoricallyVerifiedS01ProgressAuthority,
  type HistoricallyVerifiedS01ProgressAuthority,
} from '../kernel/operator-progress-authority';

import type { EvidenceCheckpointStore, EvidenceTip } from './evidence-checkpoint';

export interface CompletionPublicationRecoveryInput {
  readonly authority: HistoricallyVerifiedS01ProgressAuthority;
  readonly checkpoint_store: EvidenceCheckpointStore;
}

export interface RecoveredCommittedCompletion {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-recovered-committed-completion-v1';
  readonly authority_sha256: string;
  readonly evidence_id: string;
  readonly evidence_sha256: string;
  readonly history_sha256: string;
  readonly event_chain_sha256: string;
  readonly attestation_sha256: string;
  readonly projection_sha256: string;
  readonly version: number;
  readonly checkpoint_tip: EvidenceTip;
}

const recoveredProjectionBytes = new WeakMap<object, Buffer>();

export function recoverCommittedCompletionProjection(
  input: CompletionPublicationRecoveryInput,
): RecoveredCommittedCompletion | null {
  assertHistoricallyVerifiedS01ProgressAuthority(input.authority);
  const document = input.authority.authority.document;
  const identity = checkpointStoreIdentityFor(input.checkpoint_store);
  if (
    identity.checkpoint_store_id !== document.checkpoint_store_id ||
    identity.sha256 !== document.checkpoint_store_identity_sha256
  )
    throw new TypeError('checkpoint recovery store identity differs from historical authority');
  const recovered = recoverCommittedCheckpointProjection(input.checkpoint_store, {
    repository_id: document.repository_id,
    workspace_id: document.workspace_id,
    program_id: document.program_id,
    sprint_id: document.sprint_id,
    authority_sha256: input.authority.authority.sha256,
    evidence_id: document.evidence_id,
    version: document.evidence_version,
  });
  if (recovered === null) return null;
  const projection = loadCompletionProjectionArtifact(recovered.bytes);
  if (
    projection.program_id !== document.program_id ||
    projection.sprint_id !== document.sprint_id ||
    projection.head_sha !== document.head_sha ||
    projection.authority_sha256 !== input.authority.authority.sha256 ||
    projection.evidence_sha256 !== recovered.manifest_sha256 ||
    Date.parse(projection.verified_at) < Date.parse(input.authority.observed_at) ||
    Date.parse(projection.valid_from) < Date.parse(input.authority.observed_at) ||
    Date.parse(projection.valid_until) > Date.parse(input.authority.valid_until)
  )
    throw new TypeError('checkpoint projection semantic identity is invalid');
  const checkpointTip: EvidenceTip = Object.freeze({
    authority_sha256: input.authority.authority.sha256,
    evidence_id: document.evidence_id,
    version: document.evidence_version,
    manifest_sha256: recovered.manifest_sha256,
    history_sha256: recovered.history_sha256,
    projection_sha256: recovered.sha256,
    projection_artifact_base64: recovered.bytes.toString('base64'),
  });
  const result: RecoveredCommittedCompletion = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-recovered-committed-completion-v1',
    authority_sha256: input.authority.authority.sha256,
    evidence_id: document.evidence_id,
    evidence_sha256: recovered.manifest_sha256,
    history_sha256: recovered.history_sha256,
    event_chain_sha256: projection.event_chain_sha256,
    attestation_sha256: projection.attestation_sha256,
    projection_sha256: recovered.sha256,
    version: document.evidence_version,
    checkpoint_tip: checkpointTip,
  });
  recoveredProjectionBytes.set(result, Buffer.from(recovered.bytes));
  return result;
}

export function assertRecoveredCommittedCompletion(
  value: unknown,
): asserts value is RecoveredCommittedCompletion {
  if (value === null || typeof value !== 'object' || !recoveredProjectionBytes.has(value)) {
    throw new TypeError('completion recovery was not issued by the trusted checkpoint store');
  }
}

export function recoveredCompletionProjectionBytes(value: RecoveredCommittedCompletion): Buffer {
  assertRecoveredCommittedCompletion(value);
  const bytes = recoveredProjectionBytes.get(value);
  if (bytes === undefined) throw new TypeError('recovered completion projection is absent');
  return Buffer.from(bytes);
}
