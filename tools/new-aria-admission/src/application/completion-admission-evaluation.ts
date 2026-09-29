import { createHash } from 'node:crypto';

import type { CompletionProjection } from '../domain/progress-contracts';
import { canonicalJsonBytes } from '../kernel/canonical-json';
import { verifyEventChain } from '../kernel/event-chain';
import { verifyEventEvidenceHistory } from '../kernel/event-evidence-history';
import { manifestSha256 } from '../kernel/evidence-chain';
import { assertExactEvidenceObjectClosure } from '../kernel/evidence-object-closure';
import { loadFreshnessPolicy } from '../kernel/freshness-policy';
import { eventPolicySha256, loadEventPolicy } from '../kernel/policy';

import { snapshotCompletionCandidate, type CompletionCandidate } from './completion-candidate';
import {
  verifyCurrentCompletionProof,
  type CurrentCompletionProof,
  type CurrentCompletionProofInput,
} from './current-completion-proof';
import {
  completionResourcesFor,
  type TrustedCompletionContext,
} from './trusted-completion-context';
import { assertSignedVerificationPlanEvidence } from './verification-plan-admission';
import { assertCompletionVerifyingHistory } from './verifying-history-admission';

export interface CompletionAdmissionEvaluation {
  readonly context: TrustedCompletionContext;
  readonly manifest: ReturnType<typeof verifyEventEvidenceHistory>['final_manifest'];
  readonly manifest_sha256: string;
  readonly history_sha256: string;
  readonly event_chain_sha256: string;
  readonly tail_event_hash: string;
  readonly proof_input: CurrentCompletionProofInput;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function projectionFor(
  evaluation: CompletionAdmissionEvaluation,
  proof: CurrentCompletionProof,
): CompletionProjection {
  const authority = evaluation.context.progress_authority.authority;
  return Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-completion-projection-v1',
    program_id: authority.document.program_id,
    sprint_id: authority.document.sprint_id,
    state: 'DONE',
    status: 'OK',
    freshness: 'VALID_AT',
    verdict: 'ACCEPTED',
    verified_at: proof.attestation.observed_at,
    valid_from: proof.artifact_valid_from,
    valid_until: proof.valid_until,
    head_sha: evaluation.manifest.target.head_sha,
    authority_sha256: authority.sha256,
    evidence_sha256: evaluation.manifest_sha256,
    event_chain_sha256: evaluation.event_chain_sha256,
    attestation_sha256: proof.attestation.sha256,
    tail_event_hash: evaluation.tail_event_hash,
  });
}

export function evaluateCompletionCandidate(
  candidate: CompletionCandidate,
  context: TrustedCompletionContext,
): { readonly evaluation: CompletionAdmissionEvaluation; readonly proof: CurrentCompletionProof } {
  const resources = completionResourcesFor(context);
  const input = snapshotCompletionCandidate(candidate);
  const authority = context.progress_authority.authority;
  const eventPolicy = loadEventPolicy(resources.event_policy_bytes);
  const freshnessPolicy = loadFreshnessPolicy(resources.freshness_policy_bytes);
  if (
    authority.document.event_policy_sha256 !== eventPolicySha256(resources.event_policy_bytes) ||
    authority.document.freshness_policy_sha256 !== freshnessPolicy.sha256
  )
    throw new TypeError('progress policy digest mismatch');
  const events = verifyEventChain(input.event_bytes, eventPolicy);
  const history = verifyEventEvidenceHistory(events, input.manifest_bytes, input.objects);
  const tail = events.at(-1);
  const evidence = history.final_manifest;
  const evidenceBytes = input.manifest_bytes.at(-1);
  if (tail === undefined || evidenceBytes === undefined || tail.to_state !== 'DONE') {
    throw new TypeError('completion tail is not DONE');
  }
  const evidenceDigest = manifestSha256(evidenceBytes);
  if (
    tail.evidence_sha256 !== evidenceDigest ||
    tail.evidence_uri !== `aria-evidence://sha256/${evidenceDigest}` ||
    tail.authority_sha256 !== authority.sha256 ||
    evidence.authority_sha256 !== authority.sha256
  )
    throw new TypeError('completion authority or evidence digest mismatch');
  const claim = evidence.claim;
  if (
    evidence.evidence_id !== authority.document.evidence_id ||
    evidence.version !== authority.document.evidence_version ||
    tail.program_id !== authority.document.program_id ||
    tail.sprint_id !== authority.document.sprint_id ||
    claim.program_id !== authority.document.program_id ||
    claim.sprint_id !== authority.document.sprint_id ||
    claim.state !== 'DONE' ||
    !sameStrings(claim.acceptance_ids, authority.document.acceptance_ids) ||
    !sameStrings(claim.finding_ids, authority.document.finding_ids)
  )
    throw new TypeError('completion claim does not match progress authority');
  const controls = evidence.oracle.negative_controls.map(({ id }) => id);
  if (
    evidence.oracle.oracle_id !== authority.document.oracle_id ||
    evidence.oracle.implementation_sha256 !== authority.document.oracle_sha256 ||
    !sameStrings(controls, authority.document.required_negative_control_ids)
  )
    throw new TypeError('completion oracle or negative controls do not match progress authority');
  if (
    evidence.execution.argv_sha256 !== authority.document.verifier_argv_sha256 ||
    evidence.execution.tool_id !== authority.document.verifier_tool_id ||
    evidence.execution.tool_sha256 !== authority.document.verifier_sha256 ||
    evidence.execution.runtime_id !== authority.document.runtime_id ||
    evidence.execution.runtime_sha256 !== authority.document.toolchain_sha256 ||
    evidence.execution.cwd_sha256 !== authority.document.execution_cwd_sha256
  )
    throw new TypeError('completion execution does not match progress authority');
  if (
    tail.target_sha !== evidence.target.head_sha ||
    evidence.target.repository_id !== authority.document.repository_id ||
    evidence.target.workspace_id !== authority.document.workspace_id ||
    evidence.target.base_sha !== authority.document.base_sha ||
    evidence.target.head_sha !== authority.document.head_sha
  )
    throw new TypeError('completion evidence target does not match progress authority');
  assertExactEvidenceObjectClosure([evidence], input.objects);
  const epochs = new Map(
    evidence.freshness.invalidation_epochs.map(({ key, epoch }) => [key, epoch]),
  );
  if (
    epochs.get('authority') !== `sha256:${authority.sha256}` ||
    epochs.get('dependency') !== `sha256:${authority.document.dependency_sha256}` ||
    epochs.get('policy') !== `sha256:${authority.document.policy_epoch_sha256}` ||
    epochs.get('source_head') !== `git:${authority.document.head_sha}` ||
    epochs.get('toolchain') !== `sha256:${authority.document.toolchain_sha256}` ||
    epochs.get('verifier') !== `sha256:${authority.document.verifier_sha256}`
  )
    throw new TypeError('completion freshness epochs do not match authority target');
  const eventChainDigest = createHash('sha256').update(input.event_bytes).digest('hex');
  const tailHash = tail.event_hash;
  if (typeof tailHash !== 'string') throw new TypeError('completion tail hash is invalid');
  const proofInput: CurrentCompletionProofInput = {
    context,
    manifest: evidence,
    objects: input.objects,
    attestation_bytes: input.evidence_attestation_bytes,
    manifest_sha256: evidenceDigest,
    event_chain_sha256: eventChainDigest,
    tail_event_hash: tailHash,
  };
  const proof = verifyCurrentCompletionProof(proofInput);
  const verifyingHistory = assertSignedVerificationPlanEvidence(
    evidence,
    input.objects,
    context.progress_authority,
    context.verified_target,
    proof.resources.current_epoch_snapshot.sha256,
  );
  assertCompletionVerifyingHistory(
    input.event_bytes,
    input.manifest_bytes,
    evidence.previous_manifest_sha256,
    verifyingHistory,
  );
  const tailTime = tail.occurred_at;
  if (
    typeof tailTime !== 'string' ||
    Date.parse(evidence.observed_at) > Date.parse(tailTime) ||
    Date.parse(tailTime) > Date.parse(proof.attestation.observed_at) ||
    Date.parse(proof.attestation.observed_at) > Date.parse(proof.resources.freshness_context.now)
  )
    throw new TypeError('completion evidence, event, and attestation time order is invalid');
  const historySha256 = createHash('sha256')
    .update(canonicalJsonBytes(input.manifest_bytes.map(manifestSha256)))
    .digest('hex');
  return Object.freeze({
    evaluation: Object.freeze({
      context,
      manifest: evidence,
      manifest_sha256: evidenceDigest,
      history_sha256: historySha256,
      event_chain_sha256: eventChainDigest,
      tail_event_hash: tailHash,
      proof_input: proofInput,
    }),
    proof,
  });
}
