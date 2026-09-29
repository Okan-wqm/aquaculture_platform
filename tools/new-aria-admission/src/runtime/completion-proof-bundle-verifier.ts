import { createHash } from 'node:crypto';

import {
  historicalCompletionProjectionBytes,
  verifyHistoricalCompletionProof,
} from '../application/historical-completion-proof';
import type {
  HistoricallyVerifiedCompletionProof,
  HistoricalCompletionProofInput,
} from '../application/historical-completion-proof';
import type { VerifiedRepositoryTarget } from '../application/repository-target-verifier';
import { canonicalJsonBytes } from '../kernel/canonical-json';
import { manifestSha256, parseEvidenceManifest } from '../kernel/evidence-chain';
import type { HistoricallyVerifiedS01ProgressAuthority } from '../kernel/operator-progress-authority';

import { readCompletionProofBundle } from './completion-proof-bundle-reader';
import { loadRepositoryTargetRequest } from './repository-target-request';
import {
  assertProgressTrustRootAuthority,
  assertRepositoryTargetRequestAuthority,
} from './verifier-invocation-authority';

export interface CompletionProofBundleVerificationInput {
  readonly bundle_path: string;
  readonly authority: HistoricallyVerifiedS01ProgressAuthority;
  readonly target: VerifiedRepositoryTarget;
}

export interface VerifiedCompletionProofBundle {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-verified-completion-proof-bundle-v1';
  readonly historical_verdict: 'HISTORICALLY_VALID';
  readonly current: false;
  readonly bundle_sha256: string;
  readonly authority_sha256: string;
  readonly evidence_sha256: string;
  readonly history_sha256: string;
  readonly projection_sha256: string;
  readonly version: number;
  readonly head_sha: string;
  readonly valid_from: string;
  readonly valid_until: string;
  readonly current_epoch_provider_identity_sha256: string;
  readonly current_epoch_snapshot_sha256: string;
  readonly current_epoch_revision: number;
  readonly historical_proof: HistoricallyVerifiedCompletionProof;
}

const verifiedBundles = new WeakSet<object>();
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function verify(
  input: CompletionProofBundleVerificationInput,
  markerName: 'CANDIDATE.json' | 'COMPLETE.json',
): VerifiedCompletionProofBundle {
  const loaded = readCompletionProofBundle(input.bundle_path, markerName);
  const source = loaded.source;
  const targetRequest = loadRepositoryTargetRequest(source.target_request_bytes);
  assertRepositoryTargetRequestAuthority(
    input.authority,
    targetRequest,
    input.target.git_tool_sha256,
  );
  if (
    targetRequest.reviewed_ref !== input.target.reviewed_ref ||
    targetRequest.base_sha !== input.target.base_sha ||
    targetRequest.head_sha !== input.target.head_sha ||
    sha256(source.operator_envelope_bytes) !== input.authority.envelope_sha256 ||
    sha256(source.operator_trust_root_bytes) !== input.authority.trust_root_sha256
  )
    throw new TypeError('completion bundle operator authority artifacts differ');
  assertProgressTrustRootAuthority(
    input.authority,
    source.execution_trust_root_bytes,
    source.evidence_trust_root_bytes,
  );
  const proofInput: HistoricalCompletionProofInput = {
    authority: input.authority,
    target: input.target,
    candidate: {
      event_bytes: source.event_chain_bytes,
      manifest_bytes: source.manifest_bytes,
      objects: source.objects,
      evidence_attestation_bytes: source.evidence_attestation_bytes,
    },
    evidence_trust_root_bytes: source.evidence_trust_root_bytes,
    execution_trust_root_bytes: source.execution_trust_root_bytes,
    event_policy_bytes: source.event_policy_bytes,
    freshness_policy_bytes: source.freshness_policy_bytes,
    projection_artifact_bytes: source.projection_artifact_bytes,
  };
  const proof = verifyHistoricalCompletionProof(proofInput);
  if (!historicalCompletionProjectionBytes(proof).equals(source.projection_artifact_bytes)) {
    throw new TypeError('completion bundle projection differs from verified proof');
  }
  const manifestBytes = source.manifest_bytes.at(-1);
  if (manifestBytes === undefined)
    throw new TypeError('completion bundle final manifest is absent');
  const manifest = parseEvidenceManifest(manifestBytes, source.objects);
  const historySha256 = sha256(canonicalJsonBytes(source.manifest_bytes.map(manifestSha256)));
  const result: VerifiedCompletionProofBundle = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-verified-completion-proof-bundle-v1',
    historical_verdict: 'HISTORICALLY_VALID',
    current: false,
    bundle_sha256: sha256(loaded.marker_bytes),
    authority_sha256: proof.authority_sha256,
    evidence_sha256: proof.evidence_sha256,
    history_sha256: historySha256,
    projection_sha256: proof.projection_sha256,
    version: manifest.version,
    head_sha: input.target.head_sha,
    valid_from: proof.valid_from,
    valid_until: proof.valid_until,
    current_epoch_provider_identity_sha256:
      manifest.execution.current_epoch_provider_identity_sha256,
    current_epoch_snapshot_sha256: manifest.execution.current_epoch_snapshot_sha256,
    current_epoch_revision: manifest.execution.current_epoch_revision,
    historical_proof: proof,
  });
  verifiedBundles.add(result);
  return result;
}

export function verifyStagedCompletionProofBundle(
  input: CompletionProofBundleVerificationInput,
): VerifiedCompletionProofBundle {
  return verify(input, 'CANDIDATE.json');
}

export function verifyHistoricalCompletionProofBundle(
  input: CompletionProofBundleVerificationInput,
): VerifiedCompletionProofBundle {
  return verify(input, 'COMPLETE.json');
}

export function assertVerifiedCompletionProofBundle(
  value: unknown,
): asserts value is VerifiedCompletionProofBundle {
  if (value === null || typeof value !== 'object' || !verifiedBundles.has(value)) {
    throw new TypeError('completion proof bundle was not verifier-issued');
  }
}
