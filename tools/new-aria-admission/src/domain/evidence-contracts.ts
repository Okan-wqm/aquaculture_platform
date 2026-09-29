export interface EvidenceReference {
  readonly uri: string;
  readonly sha256: string;
}

export interface EvidenceIdentities {
  readonly producer_principal_id: string;
  readonly reviewer_principal_id: string;
  readonly oracle_principal_id: string;
  readonly appellate_principal_id: string;
}

export interface EvidenceNegativeControl {
  readonly id: string;
  readonly mutation_kind: string;
  readonly expected_verdict: 'REJECTED';
  readonly mutant: EvidenceReference;
  readonly result: EvidenceReference;
}

export interface EvidenceOracle {
  readonly principal_id: string;
  readonly oracle_id: string;
  readonly implementation_sha256: string;
  readonly report: EvidenceReference;
  readonly negative_controls: readonly EvidenceNegativeControl[];
}

export interface EvidenceReview {
  readonly conflict_verdict: 'NO_CONFLICT';
  readonly conflict_evidence: EvidenceReference;
}

export interface EvidenceTarget {
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly deployed_sha: string | null;
}

export interface EvidenceExecution {
  readonly execution_session_id: string;
  readonly run_id: string;
  readonly run_context_sha256: string;
  readonly run_nonce_sha256: string;
  readonly argv: readonly string[];
  readonly argv_sha256: string;
  readonly materialized_argv: readonly string[];
  readonly materialized_argv_sha256: string;
  readonly tool_id: string;
  readonly tool_sha256: string;
  readonly runtime_id: string;
  readonly runtime_sha256: string;
  readonly cwd: string;
  readonly cwd_sha256: string;
  readonly input_sha256: string;
  readonly input_reference_bundle_sha256: string;
  readonly input_envelope_sha256: string;
  readonly input_object_sha256s: readonly string[];
  readonly current_epoch_provider_identity_sha256: string;
  readonly current_epoch_snapshot_sha256: string;
  readonly current_epoch_revision: number;
  readonly current_epoch_read_at: string;
  readonly execution_receipt: EvidenceReference;
  readonly output_sha256: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly exit_code: number;
  readonly stdout_sha256: string;
  readonly stderr_sha256: string;
  readonly stderr_byte_length: number;
  readonly failure_reason_sha256: string | null;
  readonly semantic_verdict: 'PASSED' | 'REJECTED';
}

export interface EvidenceClaim {
  readonly program_id: string;
  readonly sprint_id: string;
  readonly state: 'DONE';
  readonly acceptance_ids: readonly string[];
  readonly finding_ids: readonly string[];
}

export type EvidenceTransitionState = 'READY' | 'IN_PROGRESS' | 'VERIFYING';

export interface EvidenceTransitionManifest {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'aria-evidence-manifest-v1';
  readonly evidence_id: string;
  readonly version: number;
  readonly previous_manifest_sha256: string | null;
  readonly observed_at: string;
  readonly observation_id: string;
  readonly authority_sha256: string;
  readonly claim: Omit<EvidenceClaim, 'state'> & {
    readonly state: EvidenceTransitionState;
  };
  readonly identities: EvidenceIdentities;
  readonly target: EvidenceTarget;
}

export type EvidenceHistoryManifest = EvidenceTransitionManifest | EvidenceManifest;

export interface EvidenceFreshness {
  readonly type: string;
  readonly observed_at: string;
  readonly valid_until: string;
  readonly invalidation_epochs: readonly {
    readonly key: string;
    readonly epoch: string;
  }[];
}

export interface EvidenceManifest {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'aria-evidence-manifest-v1';
  readonly evidence_id: string;
  readonly version: number;
  readonly previous_manifest_sha256: string | null;
  readonly observed_at: string;
  readonly observation_id: string;
  readonly authority_sha256: string;
  readonly claim: EvidenceClaim;
  readonly freshness: EvidenceFreshness;
  readonly identities: EvidenceIdentities;
  readonly target: EvidenceTarget;
  readonly execution: EvidenceExecution;
  readonly inputs: readonly EvidenceReference[];
  readonly artifacts: readonly EvidenceReference[];
  readonly report: EvidenceReference;
  readonly oracle: EvidenceOracle;
  readonly review: EvidenceReview;
  readonly admission_reason: 'ALL_REQUIRED_CONTROLS_PASSED';
  readonly verdict: 'ACCEPTED';
  readonly unresolved_findings: readonly string[];
}
