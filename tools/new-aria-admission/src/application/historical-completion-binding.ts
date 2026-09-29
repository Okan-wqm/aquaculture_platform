import type { EvidenceManifest } from '../domain/evidence-contracts';
import type { CompletionProjection } from '../domain/progress-contracts';
import type { HistoricallyVerifiedS01ProgressAuthority } from '../kernel/operator-progress-authority';

import type { VerifiedRepositoryTarget } from './repository-target-verifier';

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function assertHistoricalCompletionAuthorityScope(
  authority: HistoricallyVerifiedS01ProgressAuthority,
  target: VerifiedRepositoryTarget,
  manifest: EvidenceManifest,
): void {
  const document = authority.authority.document;
  const claim = manifest.claim;
  const controls = manifest.oracle.negative_controls.map(({ id }) => id);
  if (
    manifest.authority_sha256 !== authority.authority.sha256 ||
    manifest.evidence_id !== document.evidence_id ||
    manifest.version !== document.evidence_version ||
    claim.program_id !== document.program_id ||
    claim.sprint_id !== document.sprint_id ||
    !sameStrings(claim.acceptance_ids, document.acceptance_ids) ||
    !sameStrings(claim.finding_ids, document.finding_ids) ||
    manifest.oracle.oracle_id !== document.oracle_id ||
    manifest.oracle.implementation_sha256 !== document.oracle_sha256 ||
    !sameStrings(controls, document.required_negative_control_ids) ||
    manifest.execution.argv_sha256 !== document.verifier_argv_sha256 ||
    manifest.execution.tool_id !== document.verifier_tool_id ||
    manifest.execution.tool_sha256 !== document.verifier_sha256 ||
    manifest.execution.runtime_id !== document.runtime_id ||
    manifest.execution.runtime_sha256 !== document.toolchain_sha256 ||
    manifest.execution.cwd_sha256 !== document.execution_cwd_sha256 ||
    manifest.target.repository_id !== document.repository_id ||
    manifest.target.workspace_id !== document.workspace_id ||
    manifest.target.base_sha !== document.base_sha ||
    manifest.target.head_sha !== document.head_sha ||
    target.repository_id !== document.repository_id ||
    target.workspace_id !== document.workspace_id ||
    target.base_sha !== document.base_sha ||
    target.head_sha !== document.head_sha ||
    target.git_tool_id !== document.git_tool_id ||
    target.git_tool_sha256 !== document.git_tool_sha256
  ) {
    throw new TypeError('historical completion scope differs from signed authority');
  }
}

export interface HistoricalCompletionProjectionFacts {
  readonly evidence_sha256: string;
  readonly event_chain_sha256: string;
  readonly attestation_sha256: string;
  readonly tail_event_hash: string;
  readonly verified_at: string;
  readonly valid_from: string;
  readonly valid_until: string;
}

export function historicalCompletionProjection(
  authority: HistoricallyVerifiedS01ProgressAuthority,
  facts: HistoricalCompletionProjectionFacts,
): CompletionProjection {
  const document = authority.authority.document;
  return Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-completion-projection-v1',
    program_id: document.program_id,
    sprint_id: document.sprint_id,
    state: 'DONE',
    status: 'OK',
    freshness: 'VALID_AT',
    verdict: 'ACCEPTED',
    verified_at: facts.verified_at,
    valid_from: facts.valid_from,
    valid_until: facts.valid_until,
    head_sha: document.head_sha,
    authority_sha256: authority.authority.sha256,
    evidence_sha256: facts.evidence_sha256,
    event_chain_sha256: facts.event_chain_sha256,
    attestation_sha256: facts.attestation_sha256,
    tail_event_hash: facts.tail_event_hash,
  });
}
