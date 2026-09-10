import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson, parseStrictJsonBytes, sha256 } from './canonical.mjs';
import {
  resolveExternalAuthority,
  resolveExternalAuthorityFile,
} from './external-authority-path.mjs';

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function strictBase64(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error(`${label} must be canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error(`${label} must be canonical base64`);
  return bytes;
}

function validEnvelope(envelope, expectedKind) {
  return (
    exactKeys(envelope, [
      'algorithm',
      'key_id',
      'kind',
      'payload',
      'schema_version',
      'signature_base64',
    ]) &&
    envelope.schema_version === '1.0.0' &&
    envelope.kind === expectedKind &&
    envelope.algorithm === 'Ed25519' &&
    typeof envelope.key_id === 'string' &&
    envelope.key_id.length > 0
  );
}

function validCapabilities(value, expectedCapability) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length > 0) &&
    new Set(value).size === value.length &&
    value.includes(expectedCapability)
  );
}

function validTrustRoot(trustRoot, envelope, expectedCapability) {
  return (
    exactKeys(trustRoot, [
      'algorithm',
      'capabilities',
      'key_id',
      'kind',
      'principal_id',
      'public_key_spki_base64',
      'schema_version',
    ]) &&
    trustRoot.schema_version === '1.0.0' &&
    trustRoot.kind === 'new-aria-external-trust-root' &&
    trustRoot.algorithm === 'Ed25519' &&
    typeof trustRoot.key_id === 'string' &&
    trustRoot.key_id.length > 0 &&
    trustRoot.key_id === envelope.key_id &&
    typeof trustRoot.principal_id === 'string' &&
    trustRoot.principal_id.length > 0 &&
    validCapabilities(trustRoot.capabilities, expectedCapability)
  );
}

function ed25519PublicKey(value, label) {
  const key = createPublicKey({
    key: strictBase64(value, label),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('trust root key must be Ed25519');
  return key;
}

export function publicKeySha256(publicKeySpkiBase64) {
  const key = ed25519PublicKey(publicKeySpkiBase64, 'public key');
  return sha256(key.export({ format: 'der', type: 'spki' }));
}

function verifiedPublicKey(trustRoot) {
  const key = ed25519PublicKey(trustRoot.public_key_spki_base64, 'public key');
  return {
    key,
    sha256: sha256(key.export({ format: 'der', type: 'spki' })),
  };
}

function verifyPayloadSignature(envelope, key) {
  return verify(
    null,
    Buffer.from(canonicalJson(envelope.payload), 'utf8'),
    key,
    strictBase64(envelope.signature_base64, 'signature'),
  );
}

export function loadVerifiedPayload({
  repositoryRoot,
  authorityRoot,
  envelopePath,
  trustRootPath,
  trustRootSha256,
  expectedKind,
  expectedCapability,
}) {
  const authority = resolveExternalAuthority(repositoryRoot, authorityRoot);
  const envelopeBytes = readFileSync(
    resolveExternalAuthorityFile(authority, envelopePath, 'signed context'),
  );
  const trustRootBytes = readFileSync(
    resolveExternalAuthorityFile(authority, trustRootPath, 'trust root'),
  );
  if (
    typeof trustRootSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(trustRootSha256) ||
    sha256(trustRootBytes) !== trustRootSha256
  ) {
    throw new Error('trust root must match the exact out-of-band SHA-256 pin');
  }
  const envelope = parseStrictJsonBytes(envelopeBytes, 'signed context');
  const trustRoot = parseStrictJsonBytes(trustRootBytes, 'trust root');
  if (typeof expectedCapability !== 'string' || expectedCapability.length === 0) {
    throw new Error('expected signer capability is required');
  }
  if (!validEnvelope(envelope, expectedKind)) {
    throw new Error('signed context schema or identity mismatch');
  }
  if (!validTrustRoot(trustRoot, envelope, expectedCapability)) {
    throw new Error('external trust root schema, signer identity, capability, or key mismatch');
  }
  const publicKey = verifiedPublicKey(trustRoot);
  if (!verifyPayloadSignature(envelope, publicKey.key)) {
    throw new Error('signed context signature is invalid');
  }
  return {
    envelopeBytes,
    envelopeSha256: sha256(envelopeBytes),
    payload: envelope.payload,
    signer: {
      principalId: trustRoot.principal_id,
      capabilities: [...trustRoot.capabilities],
      public_key_sha256: publicKey.sha256,
    },
    trustRootBytes,
    trustRootSha256: sha256(trustRootBytes),
  };
}
