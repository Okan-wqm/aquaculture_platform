import { createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalJson, parseStrictJson, sha256 } from './canonical.mjs';

const bundleKeys = [
  'schema_version',
  'kind',
  'contract_id',
  'bundle_id',
  'authority_epoch',
  'observed_at',
  'valid_until',
  'reviewed_target',
  'producer',
  'admission_operator_principal_id',
  'reviewers',
  'oracle',
  'conflict',
];
const credentialKeys = [
  'role',
  'principal_id',
  'session_id',
  'key_id',
  'algorithm',
  'capabilities',
  'public_key_spki_base64',
];
const producerKeys = ['principal_id', 'session_id'];
const envelopeKeys = [
  'schema_version',
  'kind',
  'algorithm',
  'key_id',
  'payload',
  'signature_base64',
];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function equal(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
}

function strictBase64(value, label) {
  requiredString(value, label);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error(`${label} must be canonical base64`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error(`${label} must be canonical base64`);
  return bytes;
}

function descendant(root, candidate) {
  const offset = relative(root, candidate);
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset);
}

function overlaps(left, right) {
  return left === right || descendant(left, right) || descendant(right, left);
}

function repositoryTopLevel(repositoryRoot) {
  const lexical = resolve(repositoryRoot);
  const real = realpathSync(lexical);
  const top = execFileSync('git', ['-C', lexical, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (realpathSync(top) !== real) throw new Error('repository root must be its Git top-level');
  return { lexical, real };
}

function externalBundlePath(options) {
  requiredString(options.reviewerAuthorityRoot, 'reviewer authority root');
  requiredString(options.reviewerAuthorityBundlePath, 'reviewer authority bundle path');
  const repository = repositoryTopLevel(options.repositoryRoot);
  const rootLexical = resolve(options.reviewerAuthorityRoot);
  const pathLexical = resolve(options.reviewerAuthorityBundlePath);
  const rootReal = realpathSync(rootLexical);
  const pathReal = realpathSync(pathLexical);
  const repositoryOverlap =
    overlaps(repository.lexical, rootLexical) || overlaps(repository.real, rootReal);
  if (
    repositoryOverlap ||
    !descendant(rootLexical, pathLexical) ||
    !descendant(rootReal, pathReal)
  ) {
    throw new Error('reviewer authority bundle must be under an external authority root');
  }
  return pathReal;
}

function publicKey(credential) {
  const key = createPublicKey({
    key: strictBase64(credential.public_key_spki_base64, 'reviewer public key'),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('reviewer key must be Ed25519');
  return key;
}

function validateCredential(credential, role, capability) {
  if (!exactKeys(credential, credentialKeys)) throw new Error(`${role} credential schema drift`);
  for (const field of ['principal_id', 'session_id', 'key_id']) {
    requiredString(credential[field], `${role} credential ${field}`);
  }
  if (
    credential.role !== role ||
    credential.algorithm !== 'Ed25519' ||
    !equal(credential.capabilities, [capability])
  ) {
    throw new Error(`${role} credential role, algorithm, or exact capability mismatch`);
  }
  publicKey(credential);
}

function validateCredentialRoster(bundle, roles) {
  if (!Array.isArray(bundle.reviewers) || bundle.reviewers.length !== roles.length) {
    throw new Error('reviewer authority must contain exactly twelve reviewer credentials');
  }
  bundle.reviewers.forEach((credential, index) =>
    validateCredential(credential, roles[index], roles[index]),
  );
  validateCredential(bundle.oracle, 'oracle', 'd0-review-oracle');
  validateCredential(bundle.conflict, 'conflict', 'd0-conflict-oracle');
}

function assertUniqueIdentities(bundle) {
  const credentials = [...bundle.reviewers, bundle.oracle, bundle.conflict];
  const principals = [
    bundle.producer.principal_id,
    bundle.reviewed_target.target_operator_principal_id,
    bundle.admission_operator_principal_id,
    ...credentials.map((credential) => credential.principal_id),
  ];
  const sessions = [
    bundle.producer.session_id,
    ...credentials.map((credential) => credential.session_id),
  ];
  for (const [label, values] of [
    ['principal', principals],
    ['session', sessions],
    ['key', credentials.map((credential) => credential.key_id)],
    ['public key', credentials.map((credential) => credential.public_key_spki_base64)],
  ]) {
    if (new Set(values).size !== values.length) throw new Error(`${label} identity alias detected`);
  }
}

function validateClock(bundle, maxFreshnessSeconds) {
  const observed = Date.parse(bundle.observed_at);
  const validUntil = Date.parse(bundle.valid_until);
  const now = Date.now();
  if (
    !Number.isFinite(observed) ||
    observed > now ||
    now >= validUntil ||
    validUntil - observed > maxFreshnessSeconds * 1000
  ) {
    throw new Error('reviewer authority bundle is stale or has an invalid clock');
  }
}

function validateBundleIdentity(bundle) {
  if (!exactKeys(bundle, bundleKeys)) throw new Error('reviewer authority bundle schema drift');
  if (
    bundle.schema_version !== '1.0.0' ||
    bundle.kind !== 'new-aria-review-authority-bundle' ||
    bundle.contract_id !== 'new-aria-review-authority-v1' ||
    !Number.isSafeInteger(bundle.authority_epoch) ||
    bundle.authority_epoch < 1
  ) {
    throw new Error('reviewer authority bundle identity mismatch');
  }
  requiredString(bundle.bundle_id, 'reviewer authority bundle ID');
}

function validateBundleBindings(bundle, expected) {
  if (!exactKeys(bundle.producer, producerKeys) || !equal(bundle.producer, expected.producer)) {
    throw new Error('reviewer authority producer binding mismatch');
  }
  if (
    !equal(bundle.reviewed_target, expected.reviewedTarget) ||
    bundle.admission_operator_principal_id !== expected.admissionPrincipal
  ) {
    throw new Error('reviewer authority target or admission signer principal binding mismatch');
  }
}

function validateBundle(bundle, expected) {
  validateBundleIdentity(bundle);
  validateBundleBindings(bundle, expected);
  validateCredentialRoster(bundle, expected.roles);
  assertUniqueIdentities(bundle);
  validateClock(bundle, expected.maxFreshnessSeconds);
}

export function loadReviewerAuthority(options, expected) {
  const bytes = readFileSync(externalBundlePath(options));
  if (
    typeof options.reviewerAuthorityBundleSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(options.reviewerAuthorityBundleSha256) ||
    sha256(bytes) !== options.reviewerAuthorityBundleSha256
  ) {
    throw new Error('reviewer authority bundle must match its out-of-band SHA-256 pin');
  }
  const bundle = parseStrictJson(bytes.toString('utf8'));
  validateBundle(bundle, expected);
  return { bundle, sha256: sha256(bytes) };
}

export function verifyReviewerEnvelope(bytes, credential, expectedKind) {
  let envelope;
  try {
    envelope = parseStrictJson(bytes.toString('utf8'));
  } catch {
    throw new Error('reviewer signed envelope is not strict JSON');
  }
  if (
    !exactKeys(envelope, envelopeKeys) ||
    envelope.schema_version !== '1.0.0' ||
    envelope.kind !== expectedKind ||
    envelope.algorithm !== 'Ed25519' ||
    envelope.key_id !== credential.key_id
  ) {
    throw new Error('reviewer signed envelope schema, kind, algorithm, or key mismatch');
  }
  const accepted = verify(
    null,
    Buffer.from(canonicalJson(envelope.payload), 'utf8'),
    publicKey(credential),
    strictBase64(envelope.signature_base64, 'reviewer signature'),
  );
  if (!accepted) throw new Error('reviewer signed envelope signature is invalid');
  return envelope.payload;
}
