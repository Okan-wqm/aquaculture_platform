import { hasExactKeys, requiredSha256, requiredText } from './evidence-object';
import type { JsonRecord } from './evidence-object';
import { freezeReceiptExecution, validateReceiptExecution } from './execution-receipt-evidence';
import { executionRunNonceSha256 } from './execution-run-identity';
import type { ExecutionTrustKey } from './execution-trust-root';
import type {
  AuthorizedS01ProgressAuthority,
  HistoricallyVerifiedS01ProgressAuthority,
  VerifiedS01ProgressAuthority,
} from './operator-progress-authority';
import type { JsonValue } from './strict-json';

export interface ExecutionReceiptDocument {
  readonly authority_sha256: string;
  readonly authority_envelope_sha256: string;
  readonly execution_trust_root_sha256: string;
  readonly execution_session_id: string;
  readonly signer_principal_id: string;
  readonly signer_key_sha256: string;
  readonly signer_key_epoch: number;
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly tree_sha: string;
  readonly run_id: string;
  readonly run_context_sha256: string;
  readonly run_nonce_sha256: string;
  readonly reference_list_sha256: string;
  readonly object_envelope_sha256: string;
  readonly execution: JsonRecord;
  readonly issued_at: string;
  readonly valid_until: string;
}

export interface ExecutionReceiptVerificationInput {
  readonly receipt_bytes: Uint8Array;
  readonly trust_root_bytes: Uint8Array;
  readonly authority: VerifiedS01ProgressAuthority;
  readonly expected_run_id: string;
  readonly expected_run_context_sha256: string;
}

export interface CurrentExecutionReceiptVerificationInput
  extends Omit<ExecutionReceiptVerificationInput, 'authority'> {
  readonly authority: AuthorizedS01ProgressAuthority;
}

export interface HistoricalExecutionReceiptVerificationInput
  extends Omit<ExecutionReceiptVerificationInput, 'authority'> {
  readonly authority: HistoricallyVerifiedS01ProgressAuthority;
}

export interface VerifiedExecutionReceipt {
  readonly sha256: string;
  readonly document: Readonly<ExecutionReceiptDocument>;
}

const payloadKeys = [
  'schema_version',
  'contract_id',
  'capability',
  'authority_sha256',
  'authority_envelope_sha256',
  'execution_trust_root_sha256',
  'execution_session_id',
  'signer_principal_id',
  'signer_key_sha256',
  'signer_key_epoch',
  'repository_id',
  'workspace_id',
  'base_sha',
  'head_sha',
  'tree_sha',
  'run_id',
  'run_context_sha256',
  'run_nonce_sha256',
  'reference_list_sha256',
  'object_envelope_sha256',
  'execution',
  'issued_at',
  'valid_until',
] as const;
const sha40 = /^[a-f0-9]{40}$/u;
const exactUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function timestamp(value: JsonValue | undefined, label: string): [string, number] {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (
    !exactUtc.test(text) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== text
  ) {
    throw new TypeError(`${label} is not canonical UTC`);
  }
  return [text, milliseconds];
}

function requireRunId(
  value: JsonValue | undefined,
  authority: VerifiedS01ProgressAuthority,
): string {
  const runId = requiredText(value, 'execution run ID');
  if (
    runId !== 'BASELINE' &&
    !authority.authority.document.required_negative_control_ids.includes(runId)
  ) {
    throw new TypeError('execution run ID is not an authorized negative control');
  }
  return runId;
}

function validateAuthorityWindow(
  authority: VerifiedS01ProgressAuthority,
  issuedAtMs: number,
  validUntilMs: number,
): void {
  const observedAtMs = Date.parse(authority.observed_at);
  const authorityUntilMs = Date.parse(authority.valid_until);
  if (
    issuedAtMs < observedAtMs ||
    issuedAtMs > authorityUntilMs ||
    validUntilMs !== authorityUntilMs ||
    issuedAtMs > validUntilMs
  )
    throw new TypeError('execution receipt is outside its signed authority window');
}

export function validateExecutionReceiptPayload(
  payload: JsonRecord,
  input: ExecutionReceiptVerificationInput,
  key: ExecutionTrustKey,
): ExecutionReceiptDocument {
  const authority = input.authority;
  const document = authority.authority.document;
  if (!hasExactKeys(payload, payloadKeys))
    throw new TypeError('execution receipt payload schema is invalid');
  const runId = requireRunId(payload.run_id, authority);
  const runContext = requiredSha256(payload.run_context_sha256, 'execution run context');
  const runNonce = requiredSha256(payload.run_nonce_sha256, 'execution run nonce');
  const execution = validateReceiptExecution(payload.execution);
  const [issuedAt, issuedAtMs] = timestamp(payload.issued_at, 'execution receipt issue time');
  const [validUntil, validUntilMs] = timestamp(payload.valid_until, 'execution receipt validity');
  validateAuthorityWindow(authority, issuedAtMs, validUntilMs);
  if (
    payload.schema_version !== '1.0.0' ||
    payload.contract_id !== 'new-aria-execution-receipt-payload-v1' ||
    payload.capability !== 'ATTEST_EXECUTION' ||
    payload.authority_sha256 !== authority.authority.sha256 ||
    payload.authority_envelope_sha256 !== authority.envelope_sha256 ||
    payload.execution_trust_root_sha256 !== document.execution_trust_root_sha256 ||
    payload.execution_session_id !== document.execution_session_id ||
    payload.signer_principal_id !== key.principalId ||
    payload.signer_key_sha256 !== key.keySha256 ||
    payload.signer_key_epoch !== key.revocationEpoch ||
    payload.repository_id !== document.repository_id ||
    payload.workspace_id !== document.workspace_id ||
    payload.base_sha !== document.base_sha ||
    payload.head_sha !== document.head_sha ||
    typeof payload.tree_sha !== 'string' ||
    !sha40.test(payload.tree_sha) ||
    runId !== input.expected_run_id ||
    runContext !== input.expected_run_context_sha256 ||
    execution.execution_session_id !== document.execution_session_id ||
    execution.run_id !== runId ||
    execution.run_context_sha256 !== runContext ||
    execution.run_nonce_sha256 !== runNonce ||
    runNonce !==
      executionRunNonceSha256({
        execution_session_id: document.execution_session_id,
        run_id: runId,
        run_context_sha256: runContext,
        input_envelope_sha256: requiredSha256(
          execution.input_envelope_sha256,
          'execution envelope',
        ),
        tree_sha: String(payload.tree_sha),
      }) ||
    payload.reference_list_sha256 !== execution.input_reference_bundle_sha256 ||
    payload.object_envelope_sha256 !== execution.input_envelope_sha256 ||
    execution.repository_id !== document.repository_id ||
    execution.workspace_id !== document.workspace_id ||
    execution.base_sha !== document.base_sha ||
    execution.head_sha !== document.head_sha ||
    execution.tree_sha !== payload.tree_sha ||
    Date.parse(requiredText(execution.started_at_utc, 'execution start')) <
      Date.parse(authority.observed_at) ||
    Date.parse(requiredText(execution.ended_at_utc, 'execution end')) > issuedAtMs ||
    Date.parse(requiredText(execution.current_epoch_read_at, 'execution epoch read')) > issuedAtMs
  )
    throw new TypeError(
      'execution receipt does not match expected authority, context, or execution',
    );
  return Object.freeze({
    authority_sha256: authority.authority.sha256,
    authority_envelope_sha256: authority.envelope_sha256,
    execution_trust_root_sha256: document.execution_trust_root_sha256,
    execution_session_id: document.execution_session_id,
    signer_principal_id: key.principalId,
    signer_key_sha256: key.keySha256,
    signer_key_epoch: key.revocationEpoch,
    repository_id: document.repository_id,
    workspace_id: document.workspace_id,
    base_sha: document.base_sha,
    head_sha: document.head_sha,
    tree_sha: String(payload.tree_sha),
    run_id: runId,
    run_context_sha256: runContext,
    run_nonce_sha256: runNonce,
    reference_list_sha256: requiredSha256(payload.reference_list_sha256, 'receipt reference list'),
    object_envelope_sha256: requiredSha256(
      payload.object_envelope_sha256,
      'receipt object envelope',
    ),
    execution: freezeReceiptExecution(execution),
    issued_at: issuedAt,
    valid_until: validUntil,
  });
}
