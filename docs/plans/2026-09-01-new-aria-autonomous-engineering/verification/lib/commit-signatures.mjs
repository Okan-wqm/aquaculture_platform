import { createPublicKey } from 'node:crypto';
import { canonicalJson, sha256 } from './canonical.mjs';
import { inspectCommitSshSignature, verifyCommitSshSignature } from './ssh-signature.mjs';

const digest = /^[a-f0-9]{64}$/u;
const observationSkewSeconds = 900;
const policyKeys = [
  'algorithm',
  'commit_signers',
  'current_revocation_epoch',
  'hash_algorithms',
  'kind',
  'namespace',
  'operator_observed_at',
  'program_instance',
  'repository_slug',
  'requirement',
  'schema_version',
];
const signerKeys = [
  'capability',
  'key_id',
  'principal_id',
  'program_instance',
  'public_key_sha256',
  'public_key_spki_base64',
  'repository_slug',
  'revocation_epoch',
  'status',
  'valid_from',
  'valid_until',
];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function nonempty(value) {
  return typeof value === 'string' && value.length > 0;
}

function instant(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value ?? '')) {
    throw new Error(`commit signer ${label} is not canonical UTC`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`commit signer ${label} is invalid`);
  const canonical = new Date(milliseconds).toISOString().replace('.000Z', 'Z');
  if (canonical !== value) {
    throw new Error(`commit signer ${label} is invalid`);
  }
  return milliseconds / 1_000;
}

function assertSignerIdentity(signer) {
  if (
    !exactKeys(signer, signerKeys) ||
    !nonempty(signer.key_id) ||
    !nonempty(signer.principal_id)
  ) {
    throw new Error('commit signer policy schema is invalid');
  }
  if (!digest.test(signer.public_key_sha256 ?? '')) {
    throw new Error('commit signer key digest is invalid');
  }
}

function signerSpki(signer) {
  assertSignerIdentity(signer);
  const bytes = Buffer.from(signer.public_key_spki_base64 ?? '', 'base64');
  if (bytes.toString('base64') !== signer.public_key_spki_base64) {
    throw new Error('commit signer SPKI is not canonical base64');
  }
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  const canonical = key.export({ format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519' || !canonical.equals(bytes)) {
    throw new Error('commit signer key must be Ed25519');
  }
  if (sha256(bytes) !== signer.public_key_sha256) {
    throw new Error('commit signer key digest mismatch');
  }
  return bytes;
}

function assertSignerAuthorization(signer, policy, operator) {
  const validFrom = instant(signer.valid_from, 'valid_from');
  const validUntil = instant(signer.valid_until, 'valid_until');
  const observedAt = instant(policy.operator_observed_at, 'operator observation');
  if (
    signer.capability !== 'SIGN_D0_COMMIT' ||
    signer.status !== 'ACTIVE' ||
    signer.repository_slug !== policy.repository_slug ||
    signer.program_instance !== policy.program_instance ||
    signer.revocation_epoch !== policy.current_revocation_epoch ||
    signer.principal_id === operator.principalId ||
    validFrom > observedAt ||
    observedAt > validUntil
  ) {
    throw new Error('commit signer authorization scope, status, epoch, or validity mismatch');
  }
}

function exactSignerRoster(signers, policy, operator) {
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new Error('commit signer roster must be non-empty');
  }
  signers.forEach((signer) => {
    signerSpki(signer);
    assertSignerAuthorization(signer, policy, operator);
  });
  const digests = signers.map(({ public_key_sha256: value }) => value);
  const keyIds = signers.map(({ key_id: value }) => value);
  const principals = signers.map(({ principal_id: value }) => value);
  if (
    new Set(digests).size !== digests.length ||
    new Set(keyIds).size !== keyIds.length ||
    new Set(principals).size !== principals.length ||
    JSON.stringify(digests) !== JSON.stringify([...digests].sort())
  ) {
    throw new Error('commit signer roster must be sorted and unique');
  }
  if (digests.includes(operator.keySha256)) {
    throw new Error('target operator key cannot authorize repository commits');
  }
}

function validPolicyIdentity(policy, authority) {
  return [
    exactKeys(policy, policyKeys),
    policy.schema_version === '1.0.0',
    policy.kind === 'new-aria-d0-commit-signature-policy',
    policy.requirement === 'EVERY_INTRODUCED_COMMIT',
    policy.algorithm === 'ssh-ed25519',
    policy.namespace === 'git',
    JSON.stringify(policy.hash_algorithms) === JSON.stringify(['sha512']),
    digest.test(authority.operatorKeySha256 ?? ''),
    Number.isSafeInteger(policy.current_revocation_epoch),
    policy.current_revocation_epoch >= 0,
    policy.repository_slug === authority.manifest.repository_slug,
    policy.program_instance === authority.manifest.program_instance,
  ].every(Boolean);
}

export function assertCommitSignaturePolicy(policy, authority) {
  if (!validPolicyIdentity(policy, authority)) {
    throw new Error('commit signature policy schema or identity mismatch');
  }
  const observedAt = instant(policy.operator_observed_at, 'operator observation');
  if (Math.abs(Math.floor(Date.now() / 1_000) - observedAt) > observationSkewSeconds) {
    throw new Error('commit signer operator observation is not current');
  }
  exactSignerRoster(policy.commit_signers, policy, {
    keySha256: authority.operatorKeySha256,
    principalId: authority.operatorPrincipalId,
  });
  return policy;
}

function verifyCommit(commit, policy, signers) {
  const { committerTimestamp, raw, sha: commitSha } = commit;
  const inspected = inspectCommitSshSignature(raw, policy.hash_algorithms);
  const signerKeySha256 = sha256(inspected.signerSpki);
  const signer = signers.get(signerKeySha256);
  if (!signer) throw new Error('commit signer key is not authorized');
  const observedAt = instant(policy.operator_observed_at, 'operator observation');
  const validFrom = instant(signer.valid_from, 'valid_from');
  const validUntil = instant(signer.valid_until, 'valid_until');
  if (
    committerTimestamp < validFrom ||
    committerTimestamp > validUntil ||
    committerTimestamp > observedAt
  ) {
    throw new Error('commit timestamp is outside signer authorization window');
  }
  verifyCommitSshSignature(raw, signer, policy.hash_algorithms);
  return {
    commit_sha: commitSha,
    signature_sha256: sha256(inspected.signatureBlob),
    signer_key_sha256: signerKeySha256,
  };
}

export function verifyIntroducedCommitSignatures(commits, policy) {
  const signers = new Map(
    policy.commit_signers.map((signer) => [signer.public_key_sha256, signer]),
  );
  const records = commits.map((commit) => verifyCommit(commit, policy, signers));
  const used = [...new Set(records.map(({ signer_key_sha256: value }) => value))].sort();
  const declared = [...signers.keys()];
  if (JSON.stringify(used) !== JSON.stringify(declared)) {
    throw new Error('declared commit signer roster is not the exact used signer set');
  }
  return { records, digest: sha256(Buffer.from(canonicalJson(records))) };
}
