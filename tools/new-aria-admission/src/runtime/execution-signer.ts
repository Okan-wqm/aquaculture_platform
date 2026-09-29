import { createPrivateKey, KeyObject, sign } from 'node:crypto';

import {
  assertExecutableRepositoryTarget,
  assertVerifiedRepositoryTarget,
} from '../application/repository-target-verifier';
import type { VerifiedRepositoryTarget } from '../application/repository-target-verifier';
import { canonicalJsonBytes } from '../kernel/canonical-json';
import { digestBytes, requiredSha256 } from '../kernel/evidence-object';
import { loadEvidenceTrustKeys } from '../kernel/evidence-trust-root';
import { executionRunNonceSha256 } from '../kernel/execution-run-identity';
import { issueExecutionSigningCapability } from '../kernel/execution-signing-capability';
import type { ExecutionSigningCapability } from '../kernel/execution-signing-capability';
import {
  assertExecutionTrustKeyAuthority,
  loadExecutionTrustKey,
} from '../kernel/execution-trust-root';
import { requireIdentifier } from '../kernel/identifiers';
import type { AuthorizedS01ProgressAuthority } from '../kernel/operator-progress-authority';
import { assertAuthorizedS01ProgressAuthority } from '../kernel/operator-progress-authority';

import {
  registerExecutionSigningSecret,
  requireExecutionSigningSecret,
  revokeExecutionSigningSecret,
} from './execution-signing-secrets';
import type { PendingExecutableRun } from './pending-executable-run';
import { snapshotPendingExecutableRun } from './pending-executable-run';

export type { ExecutionSigningCapability } from '../kernel/execution-signing-capability';

export interface ExecutionSigningMaterialInput {
  readonly authority: AuthorizedS01ProgressAuthority;
  readonly trust_root_bytes: Uint8Array;
  readonly evidence_trust_root_bytes: Uint8Array;
  readonly private_key_pkcs8_der: Uint8Array;
}

export interface ExecutableRunAttestationRequest {
  readonly authority: AuthorizedS01ProgressAuthority;
  readonly target: VerifiedRepositoryTarget;
  readonly run: PendingExecutableRun;
}

export interface SignedExecutionReceipt {
  readonly bytes: Buffer;
  readonly sha256: string;
}

const attestedRuns = new WeakSet<object>();

function loadPrivateKey(bytes: Uint8Array): KeyObject {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > 4_096 ||
    (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)
  )
    throw new TypeError('execution private key material is invalid');
  const owned = Buffer.from(bytes);
  try {
    const key = createPrivateKey({ key: owned, format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519')
      throw new TypeError('execution private key is not Ed25519');
    const canonical = key.export({ format: 'der', type: 'pkcs8' });
    if (!Buffer.from(canonical).equals(owned)) {
      throw new TypeError('execution private key is not canonical PKCS8 DER');
    }
    return key;
  } finally {
    owned.fill(0);
  }
}

function currentAuthority(authority: AuthorizedS01ProgressAuthority): void {
  assertAuthorizedS01ProgressAuthority(authority);
  const now = Date.now();
  if (
    !Number.isSafeInteger(now) ||
    now < Date.parse(authority.observed_at) ||
    now > Date.parse(authority.valid_until)
  )
    throw new TypeError('execution signing authority is outside its current window');
}

export function loadExecutionSigningCapability(
  input: ExecutionSigningMaterialInput,
): ExecutionSigningCapability {
  currentAuthority(input.authority);
  const document = input.authority.authority.document;
  const trustKey = loadExecutionTrustKey(
    input.trust_root_bytes,
    document.execution_trust_root_sha256,
  );
  const evidenceKeys = loadEvidenceTrustKeys(
    input.evidence_trust_root_bytes,
    document.evidence_trust_root_sha256,
  );
  assertExecutionTrustKeyAuthority(trustKey, input.authority);
  if (
    document.execution_trust_root_sha256 === document.evidence_trust_root_sha256 ||
    document.execution_trust_root_sha256 === input.authority.trust_root_sha256 ||
    trustKey.principalId === input.authority.signer_principal_id ||
    trustKey.keySha256 === input.authority.signer_key_sha256 ||
    evidenceKeys.some(
      (key) =>
        key.principalId === trustKey.principalId ||
        digestBytes(Buffer.from(key.encodedKey, 'base64')) === trustKey.keySha256,
    )
  )
    throw new TypeError(
      'execution signing identity must be separate from operator and evidence identities',
    );
  const privateKey = loadPrivateKey(input.private_key_pkcs8_der);
  const capability = issueExecutionSigningCapability({
    authority: input.authority,
    trust_root_bytes: input.trust_root_bytes,
    private_key: privateKey,
    claims: {
      schema_version: '1.0.0',
      contract_id: 'new-aria-execution-signing-capability-v1',
      capability: 'ATTEST_EXECUTION',
      authority_sha256: input.authority.authority.sha256,
      authority_envelope_sha256: input.authority.envelope_sha256,
      execution_session_id: requireIdentifier(document.execution_session_id, 'execution session'),
      principal_id: trustKey.principalId,
      key_sha256: trustKey.keySha256,
      trust_root_sha256: document.execution_trust_root_sha256,
    },
  });
  registerExecutionSigningSecret(capability, {
    authority: input.authority,
    privateKey,
    principalId: trustKey.principalId,
    keySha256: trustKey.keySha256,
    trustRootSha256: document.execution_trust_root_sha256,
    keyEpoch: trustKey.revocationEpoch,
  });
  return capability;
}

function requireRunId(runId: string, authority: AuthorizedS01ProgressAuthority): string {
  if (
    runId !== 'BASELINE' &&
    !authority.authority.document.required_negative_control_ids.includes(runId)
  )
    throw new TypeError('execution run ID is not an authorized negative control');
  return runId;
}

export function attestExecutableRun(
  capability: ExecutionSigningCapability,
  request: ExecutableRunAttestationRequest,
): SignedExecutionReceipt {
  const state = requireExecutionSigningSecret(capability);
  currentAuthority(request.authority);
  if (request.authority !== state.authority) {
    throw new TypeError('execution signing capability belongs to another authority');
  }
  assertVerifiedRepositoryTarget(request.target);
  assertExecutableRepositoryTarget(request.target);
  if (attestedRuns.has(request.run))
    throw new TypeError('runner-issued execution was already attested');
  const run = snapshotPendingExecutableRun(request.run);
  const evidence = run.evidence;
  const document = request.authority.authority.document;
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const runContext = requiredSha256(evidence.run_context_sha256, 'execution run context');
  const runId = requireRunId(evidence.run_id, request.authority);
  const nonce = executionRunNonceSha256({
    execution_session_id: evidence.execution_session_id,
    run_id: runId,
    run_context_sha256: runContext,
    input_envelope_sha256: evidence.input_envelope_sha256,
    tree_sha: evidence.tree_sha,
  });
  if (
    request.target.repository_id !== document.repository_id ||
    request.target.workspace_id !== document.workspace_id ||
    request.target.base_sha !== document.base_sha ||
    request.target.head_sha !== document.head_sha ||
    evidence.repository_id !== request.target.repository_id ||
    evidence.workspace_id !== request.target.workspace_id ||
    evidence.base_sha !== request.target.base_sha ||
    evidence.head_sha !== request.target.head_sha ||
    evidence.tree_sha !== request.target.tree_sha ||
    evidence.execution_session_id !== document.execution_session_id ||
    evidence.run_nonce_sha256 !== nonce ||
    Date.parse(evidence.started_at_utc) < Date.parse(request.authority.observed_at) ||
    Date.parse(evidence.ended_at_utc) > now
  )
    throw new TypeError('runner evidence does not match the authorized repository execution');
  const payload = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-execution-receipt-payload-v1',
    capability: 'ATTEST_EXECUTION',
    authority_sha256: request.authority.authority.sha256,
    authority_envelope_sha256: request.authority.envelope_sha256,
    execution_trust_root_sha256: state.trustRootSha256,
    execution_session_id: document.execution_session_id,
    signer_principal_id: state.principalId,
    signer_key_sha256: state.keySha256,
    signer_key_epoch: state.keyEpoch,
    repository_id: document.repository_id,
    workspace_id: document.workspace_id,
    base_sha: document.base_sha,
    head_sha: document.head_sha,
    tree_sha: request.target.tree_sha,
    run_id: runId,
    run_context_sha256: runContext,
    run_nonce_sha256: nonce,
    reference_list_sha256: evidence.input_reference_bundle_sha256,
    object_envelope_sha256: evidence.input_envelope_sha256,
    execution: evidence,
    issued_at: issuedAt,
    valid_until: request.authority.valid_until,
  };
  const signature = sign(null, canonicalJsonBytes(payload), state.privateKey);
  attestedRuns.add(request.run);
  const bytes = canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-execution-receipt-envelope-v1',
    payload,
    signature: {
      principal_id: state.principalId,
      capability: 'ATTEST_EXECUTION',
      signature_base64: signature.toString('base64'),
    },
  });
  return Object.freeze({ bytes, sha256: digestBytes(bytes) });
}

export function revokeExecutionSigningCapability(capability: ExecutionSigningCapability): void {
  revokeExecutionSigningSecret(capability);
}
