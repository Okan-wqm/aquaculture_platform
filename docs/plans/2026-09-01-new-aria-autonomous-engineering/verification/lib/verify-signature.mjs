import { createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalJson, parseStrictJson, sha256 } from './canonical.mjs';

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function descendant(root, candidate) {
  const offset = relative(root, candidate);
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset);
}

function requiredPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} path is required`);
  return resolve(value);
}

function verifiedRepositoryRoot(repositoryRoot) {
  const candidate = requiredPath(repositoryRoot, 'repository root');
  const candidateReal = realpathSync(candidate);
  let topLevel;
  try {
    topLevel = execFileSync('git', ['-C', candidate, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('repository root must resolve to a Git worktree top-level');
  }
  const topLevelLexical = resolve(topLevel);
  const topLevelReal = realpathSync(topLevelLexical);
  if (candidateReal !== topLevelReal) {
    throw new Error('repository root must be the actual Git worktree top-level');
  }
  return { lexical: topLevelLexical, real: topLevelReal };
}

function externalAuthority(repositoryRoot, authorityRoot) {
  const repository = verifiedRepositoryRoot(repositoryRoot);
  const authorityLexical = requiredPath(authorityRoot, 'authority root');
  const authorityReal = realpathSync(authorityLexical);
  if (
    authorityLexical === repository.lexical ||
    descendant(repository.lexical, authorityLexical) ||
    descendant(authorityLexical, repository.lexical) ||
    authorityReal === repository.real ||
    descendant(repository.real, authorityReal) ||
    descendant(authorityReal, repository.real)
  ) {
    throw new Error('authority root must be lexically and physically outside the repository');
  }
  return { lexical: authorityLexical, real: authorityReal, repository };
}

function authorityPath(authority, path, label) {
  const lexical = requiredPath(path, label);
  if (!descendant(authority.lexical, lexical)) {
    throw new Error(`${label} lexical path must be under the authority root`);
  }
  const real = realpathSync(lexical);
  if (!descendant(authority.real, real)) {
    throw new Error(`${label} real path must be under the authority root`);
  }
  if (
    lexical === authority.repository.lexical ||
    descendant(authority.repository.lexical, lexical) ||
    real === authority.repository.real ||
    descendant(authority.repository.real, real)
  ) {
    throw new Error(`${label} must be lexically and physically outside the repository`);
  }
  return real;
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
  const authority = externalAuthority(repositoryRoot, authorityRoot);
  const envelopeBytes = readFileSync(authorityPath(authority, envelopePath, 'signed context'));
  const trustRootBytes = readFileSync(authorityPath(authority, trustRootPath, 'trust root'));
  if (
    typeof trustRootSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(trustRootSha256) ||
    sha256(trustRootBytes) !== trustRootSha256
  ) {
    throw new Error('trust root must match the exact out-of-band SHA-256 pin');
  }
  const envelope = parseStrictJson(envelopeBytes.toString('utf8'));
  const trustRoot = parseStrictJson(trustRootBytes.toString('utf8'));
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
    payload: envelope.payload,
    signer: {
      principalId: trustRoot.principal_id,
      capabilities: [...trustRoot.capabilities],
      public_key_sha256: publicKey.sha256,
    },
  };
}
