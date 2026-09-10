import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256 } from './lib/canonical.mjs';

function keyMaterial(role, capability, index) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    credential: {
      role,
      principal_id: `${role}-principal-${index}`,
      session_id: `${role}-session-${index}`,
      agent_execution_id: `${role}-agent-execution-${index}`,
      key_id: `${role}-key-${index}`,
      algorithm: 'Ed25519',
      capabilities: [capability],
      public_key_spki_base64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    },
    privateKey,
  };
}

export function signedEnvelope(kind, payload, signer) {
  return Buffer.from(
    `${JSON.stringify({
      schema_version: '1.0.0',
      kind,
      algorithm: 'Ed25519',
      key_id: signer.credential.key_id,
      payload,
      signature_base64: sign(
        null,
        Buffer.from(canonicalJson(payload), 'utf8'),
        signer.privateKey,
      ).toString('base64'),
    })}\n`,
    'utf8',
  );
}

export function writeArtifact(root, uri, bytes) {
  const path = join(root, uri);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
  return { artifact_uri: uri, sha256: sha256(bytes) };
}

export function writeReviewerAuthority(externalRoot, spec) {
  const reviewerSigners = spec.roles.map((role, index) => keyMaterial(role, role, index));
  const oracleSigner = keyMaterial('oracle', 'd0-review-oracle', 'oracle');
  const conflictSigner = keyMaterial('conflict', 'd0-conflict-oracle', 'conflict');
  const bundle = {
    schema_version: '1.0.0',
    kind: 'new-aria-review-authority-bundle',
    contract_id: 'new-aria-review-authority-v1',
    bundle_id: 'fixture-review-authority-1',
    authority_epoch: 1,
    observed_at: spec.observedAt,
    valid_until: spec.validUntil,
    reviewed_target: spec.reviewedTarget,
    producer: spec.producer,
    admission_operator_principal_id: spec.admissionPrincipal,
    independence_assurance: 'OPERATOR_ATTESTED',
    reviewers: reviewerSigners.map((signer) => signer.credential),
    oracle: oracleSigner.credential,
    conflict: conflictSigner.credential,
  };
  const root = join(externalRoot, 'reviewers');
  const path = join(root, 'review-authority.json');
  mkdirSync(root, { recursive: true });
  writeFileSync(path, `${JSON.stringify(bundle)}\n`);
  return {
    root,
    path,
    sha256: sha256(readFileSync(path)),
    bundle,
    reviewerSigners,
    oracleSigner,
    conflictSigner,
  };
}

export function writeAdmissionAuthority(externalRoot, context) {
  const signer = keyMaterial('admission', 'review-dossier-admission', 'admission');
  signer.credential.principal_id = 'admission-operator';
  const root = join(externalRoot, 'admission');
  const envelopePath = join(root, 'context.json');
  const trustRootPath = join(root, 'trust-root.json');
  const trustRoot = {
    schema_version: '1.0.0',
    kind: 'new-aria-external-trust-root',
    algorithm: 'Ed25519',
    key_id: signer.credential.key_id,
    principal_id: signer.credential.principal_id,
    capabilities: signer.credential.capabilities,
    public_key_spki_base64: signer.credential.public_key_spki_base64,
  };
  const resign = () =>
    writeFileSync(envelopePath, signedEnvelope('new-aria-review-dossier-context', context, signer));
  mkdirSync(root, { recursive: true });
  writeFileSync(trustRootPath, `${JSON.stringify(trustRoot)}\n`);
  resign();
  return { root, envelopePath, trustRootPath, resign };
}
