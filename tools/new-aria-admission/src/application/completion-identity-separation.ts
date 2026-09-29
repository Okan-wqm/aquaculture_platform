import { digestBytes } from '../kernel/evidence-object';
import { loadEvidenceTrustKeys } from '../kernel/evidence-trust-root';
import {
  assertExecutionTrustKeyAuthority,
  loadExecutionTrustKey,
} from '../kernel/execution-trust-root';
import type { VerifiedS01ProgressAuthority } from '../kernel/operator-progress-authority';

export function assertCompletionIdentitySeparation(
  authority: VerifiedS01ProgressAuthority,
  evidenceTrustRootBytes: Uint8Array,
  executionTrustRootBytes: Uint8Array,
): void {
  const evidenceKeys = loadEvidenceTrustKeys(
    evidenceTrustRootBytes,
    authority.authority.document.evidence_trust_root_sha256,
  );
  const executionKey = loadExecutionTrustKey(
    executionTrustRootBytes,
    authority.authority.document.execution_trust_root_sha256,
  );
  assertExecutionTrustKeyAuthority(executionKey, authority);
  const evidenceReusesOperator = evidenceKeys.some(
    (key) =>
      key.principalId === authority.signer_principal_id ||
      digestBytes(Buffer.from(key.encodedKey, 'base64')) === authority.signer_key_sha256,
  );
  const executionReusesIdentity =
    executionKey.principalId === authority.signer_principal_id ||
    executionKey.keySha256 === authority.signer_key_sha256 ||
    evidenceKeys.some(
      (key) =>
        key.principalId === executionKey.principalId ||
        digestBytes(Buffer.from(key.encodedKey, 'base64')) === executionKey.keySha256,
    );
  if (evidenceReusesOperator || executionReusesIdentity) {
    throw new TypeError('operator, evidence, and execution identities violate required separation');
  }
}
