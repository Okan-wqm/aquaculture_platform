import type { SemanticVerdict } from '../kernel/verdict-propagation';

interface ByteArtifactEvidence {
  readonly byte_length: number;
  readonly sha256: string;
}

export interface ExecutableRunEvidence {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-executable-run-v1';
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly tree_sha: string;
  readonly execution_session_id: string;
  readonly run_id: string;
  readonly run_context_sha256: string;
  readonly run_nonce_sha256: string;
  readonly argv: readonly string[];
  readonly argv_sha256: string;
  readonly materialized_argv: readonly string[];
  readonly materialized_argv_sha256: string;
  readonly cwd: string;
  readonly cwd_sha256: string;
  readonly input_reference_bundle_sha256: string;
  readonly input_envelope_sha256: string;
  readonly input_object_sha256s: readonly string[];
  readonly current_epoch_provider_identity_sha256: string;
  readonly current_epoch_snapshot_sha256: string;
  readonly current_epoch_revision: number;
  readonly current_epoch_read_at: string;
  readonly output_sha256: string;
  readonly runtime: {
    readonly id: string;
    readonly version: string;
    readonly executable_sha256: string;
  };
  readonly tool: { readonly id: string; readonly sha256: string };
  readonly started_at_utc: string;
  readonly ended_at_utc: string;
  readonly process: { readonly exit_code: number; readonly workflow_succeeded: boolean };
  readonly result: { readonly semantic_verdict: SemanticVerdict; readonly final_exit_code: 0 | 1 };
  readonly stdout: ByteArtifactEvidence;
  readonly stderr: ByteArtifactEvidence;
}

export interface ExecutableRunResult {
  readonly evidence: ExecutableRunEvidence;
  readonly input_envelope: Buffer;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly execution_receipt: {
    readonly bytes: Buffer;
    readonly sha256: string;
  };
}
