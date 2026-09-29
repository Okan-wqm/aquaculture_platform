export interface ProgressAuthorityDocument {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-progress-authority-v1';
  readonly program_id: string;
  readonly sprint_id: string;
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly reviewed_ref: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly event_policy_sha256: string;
  readonly freshness_policy_sha256: string;
  readonly evidence_trust_root_sha256: string;
  readonly execution_trust_root_sha256: string;
  readonly execution_session_id: string;
  readonly checkpoint_store_id: string;
  readonly checkpoint_store_identity_sha256: string;
  readonly invalidation_epoch_provider_id: string;
  readonly invalidation_epoch_provider_identity_sha256: string;
  readonly verification_plan_sha256: string;
  readonly evidence_id: string;
  readonly evidence_version: number;
  readonly dependency_sha256: string;
  readonly policy_epoch_sha256: string;
  readonly verifier_tool_id: string;
  readonly toolchain_sha256: string;
  readonly verifier_sha256: string;
  readonly verifier_argv_sha256: string;
  readonly runtime_id: string;
  readonly execution_cwd_sha256: string;
  readonly git_tool_id: string;
  readonly git_tool_sha256: string;
  readonly oracle_id: string;
  readonly oracle_sha256: string;
  readonly required_negative_control_ids: readonly string[];
  readonly acceptance_ids: readonly string[];
  readonly finding_ids: readonly string[];
}

export interface LoadedProgressAuthority {
  readonly document: ProgressAuthorityDocument;
  readonly sha256: string;
}

export interface CompletionProjection {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-completion-projection-v1';
  readonly program_id: string;
  readonly sprint_id: string;
  readonly state: 'DONE';
  readonly status: 'OK';
  readonly freshness: 'VALID_AT';
  readonly verdict: 'ACCEPTED';
  readonly verified_at: string;
  readonly valid_from: string;
  readonly valid_until: string;
  readonly head_sha: string;
  readonly authority_sha256: string;
  readonly evidence_sha256: string;
  readonly event_chain_sha256: string;
  readonly attestation_sha256: string;
  readonly tail_event_hash: string;
}
