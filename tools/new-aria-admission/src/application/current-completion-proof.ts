import type { EvidenceManifest } from '../domain/evidence-contracts';
import { verifyEvidenceAttestation } from '../kernel/evidence-attestation';
import type { VerifiedEvidenceAttestation } from '../kernel/evidence-attestation';
import { negativeControlSetSha256 } from '../kernel/evidence-oracle';
import { verifyExecutionReceiptRoster } from '../kernel/execution-receipt-admission';
import { evaluateFreshness } from '../kernel/freshness';
import { loadFreshnessPolicy } from '../kernel/freshness-policy';

import {
  completionResourcesFor,
  type TrustedCompletionContext,
  type TrustedCompletionResources,
} from './trusted-completion-context';

export interface CurrentCompletionProofInput {
  readonly context: TrustedCompletionContext;
  readonly manifest: EvidenceManifest;
  readonly objects: ReadonlyMap<string, Uint8Array>;
  readonly attestation_bytes: Uint8Array;
  readonly manifest_sha256: string;
  readonly event_chain_sha256: string;
  readonly tail_event_hash: string;
}

export interface CurrentCompletionProof {
  readonly attestation: VerifiedEvidenceAttestation;
  readonly resources: TrustedCompletionResources;
  readonly artifact_valid_from: string;
  readonly checkpoint_valid_from: string;
  readonly valid_until: string;
}

function earliestDeadline(values: readonly string[]): string {
  const ordered = [...values].sort();
  const earliest = ordered[0];
  if (earliest === undefined) throw new TypeError('completion proof deadline is missing');
  return earliest;
}

function latestObservation(values: readonly string[]): string {
  const ordered = [...values].sort();
  const latest = ordered.at(-1);
  if (latest === undefined) throw new TypeError('completion proof observation is missing');
  return latest;
}

export function verifyCurrentCompletionProof(
  input: CurrentCompletionProofInput,
): CurrentCompletionProof {
  const resources = completionResourcesFor(input.context);
  const authority = input.context.progress_authority;
  const freshnessPolicy = loadFreshnessPolicy(resources.freshness_policy_bytes);
  if (
    evaluateFreshness(
      input.manifest.freshness,
      resources.freshness_context,
      freshnessPolicy.document,
    ) !== 'CURRENT'
  ) {
    throw new TypeError('completion evidence is stale');
  }
  const receipts = verifyExecutionReceiptRoster({
    manifest: input.manifest,
    objects: input.objects,
    authority,
    trust_root_bytes: resources.execution_trust_root_bytes,
    target: input.context.verified_target,
    current_epoch: resources.current_epoch_snapshot,
  });
  const attestation = verifyEvidenceAttestation({
    envelope_bytes: input.attestation_bytes,
    trust_root_bytes: resources.evidence_trust_root_bytes,
    expected: {
      trust_root_sha256: authority.authority.document.evidence_trust_root_sha256,
      manifest_sha256: input.manifest_sha256,
      authority_sha256: authority.authority.sha256,
      event_chain_sha256: input.event_chain_sha256,
      tail_event_hash: input.tail_event_hash,
      target_head_sha: input.manifest.target.head_sha,
      oracle_report_sha256: input.manifest.oracle.report.sha256,
      negative_controls_sha256: negativeControlSetSha256(input.manifest.oracle.negative_controls),
      producer_principal_id: input.manifest.identities.producer_principal_id,
      reviewer_principal_id: input.manifest.identities.reviewer_principal_id,
      oracle_principal_id: input.manifest.identities.oracle_principal_id,
      appellate_principal_id: input.manifest.identities.appellate_principal_id,
    },
    freshness_context: resources.freshness_context,
    freshness_policy: freshnessPolicy.document,
  });
  const artifactValidFrom = latestObservation([
    authority.observed_at,
    input.manifest.observed_at,
    attestation.observed_at,
    resources.current_epoch_snapshot.observed_at,
    ...receipts.map(({ document }) => document.issued_at),
  ]);
  return Object.freeze({
    attestation,
    resources,
    artifact_valid_from: artifactValidFrom,
    checkpoint_valid_from: latestObservation([
      artifactValidFrom,
      resources.freshness_context.now,
    ]),
    valid_until: earliestDeadline([
      authority.valid_until,
      resources.current_epoch_snapshot.valid_until,
      input.manifest.freshness.valid_until,
      attestation.valid_until,
    ]),
  });
}
