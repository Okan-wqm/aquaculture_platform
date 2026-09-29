export interface OracleProofOverrides {
  readonly argv?: readonly string[];
  readonly tool_id?: string;
  readonly tool_sha256?: string;
  readonly runtime_id?: string;
  readonly runtime_sha256?: string;
  readonly cwd?: string;
  readonly control_stderr_bytes?: Uint8Array;
}

export interface OracleProofConfiguration {
  readonly argv: readonly string[];
  readonly tool_id: string;
  readonly tool_sha256: string;
  readonly runtime_id: string;
  readonly runtime_sha256: string;
  readonly cwd: string;
}

export interface ObjectReference {
  readonly uri: string;
  readonly sha256: string;
}

export interface ExecutionWitness {
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
  readonly execution_receipt: ObjectReference;
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

export type ReceiptlessExecutionWitness = Omit<ExecutionWitness, 'execution_receipt'>;

export type ExecutionReceiptFixtureIssuer = (
  objects: Map<string, Uint8Array>,
  witness: ReceiptlessExecutionWitness,
) => ObjectReference;

export interface ExecutionInputObject {
  readonly bytes: Uint8Array;
  readonly reference: ObjectReference;
}

export interface ExecutionAuthenticationMaterial {
  readonly authority_envelope_bytes: Uint8Array;
  readonly operator_trust_root_bytes: Uint8Array;
  readonly current_epoch_snapshot_bytes: Uint8Array;
  readonly current_epoch_provider_identity_sha256: string;
  readonly current_epoch_revision: number;
}

export interface NegativeControlDeclaration {
  readonly id: string;
  readonly mutation_kind: string;
  readonly run_context_sha256: string;
  readonly expected_verdict: 'REJECTED';
  readonly mutant: ObjectReference;
  readonly result: ObjectReference;
}

export interface OracleProofResult {
  readonly execution: ExecutionWitness;
  readonly oracle: {
    readonly principal_id: string;
    readonly oracle_id: string;
    readonly implementation_sha256: string;
    readonly report: ObjectReference;
    readonly negative_controls: NegativeControlDeclaration[];
  };
  readonly objects: Map<string, Uint8Array>;
}
