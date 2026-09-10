import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson, sha256 } from './lib/canonical.mjs';

const magic = Buffer.from('SSHSIG', 'ascii');
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const armorBegin = '-----BEGIN SSH SIGNATURE-----';
const armorEnd = '-----END SSH SIGNATURE-----';
let timestamp = Math.floor(Date.now() / 1_000) - 3_600;
const instant = (seconds) => new Date(seconds * 1_000).toISOString().replace('.000Z', 'Z');

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function sshString(value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint32(bytes.length), bytes]);
}

function runGit(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.binary ? null : 'utf8',
    input: options.input,
  });
}

function publicBlob(rawKey) {
  return Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(rawKey)]);
}

function signedData(message, hashAlgorithm) {
  const digest = createHash(hashAlgorithm).update(message).digest();
  return Buffer.concat([
    magic,
    sshString(Buffer.from('git')),
    sshString(Buffer.alloc(0)),
    sshString(Buffer.from(hashAlgorithm)),
    sshString(digest),
  ]);
}

function signatureBlob(message, signer) {
  const hashAlgorithm = 'sha512';
  const signature = sign(null, signedData(message, hashAlgorithm), signer.privateKey);
  const encodedSignature = Buffer.concat([
    sshString(Buffer.from('ssh-ed25519')),
    sshString(signature),
  ]);
  return Buffer.concat([
    magic,
    uint32(1),
    sshString(publicBlob(signer.publicKeyRaw)),
    sshString(Buffer.from('git')),
    sshString(Buffer.alloc(0)),
    sshString(Buffer.from(hashAlgorithm)),
    sshString(encodedSignature),
  ]);
}

function armor(blob) {
  const base64 = blob.toString('base64');
  const lines = base64.match(/.{1,70}/gu) ?? [];
  return ['-----BEGIN SSH SIGNATURE-----', ...lines, '-----END SSH SIGNATURE-----'];
}

function signedCommitBytes(unsigned, signer) {
  const separator = unsigned.indexOf('\n\n');
  const headers = unsigned.subarray(0, separator).toString('utf8');
  const body = unsigned.subarray(separator + 2);
  const signature = armor(signatureBlob(unsigned, signer));
  const gpgsig = `gpgsig ${signature.join('\n ')}`;
  return Buffer.concat([Buffer.from(`${headers}\n${gpgsig}\n\n`), body]);
}

function currentHead(root) {
  try {
    return runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).trim();
  } catch {
    return null;
  }
}

export function createCommitSigner(keyId = 'committer-test-key', principalId = 'd0-committer') {
  const keys = generateKeyPairSync('ed25519');
  const spki = keys.publicKey.export({ format: 'der', type: 'spki' });
  return {
    keyId,
    principalId,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    publicKeyRaw: spki.subarray(spkiPrefix.length),
    publicKeySpki: spki,
  };
}

export function writeSignedCommit(root, message, signer, additionalParents = []) {
  runGit(root, ['add', '.']);
  const tree = runGit(root, ['write-tree']).trim();
  const parent = currentHead(root);
  const identity = 'D0 Test <d0-test@example.invalid>';
  timestamp += 1;
  const headers = [
    `tree ${tree}`,
    ...(parent ? [`parent ${parent}`] : []),
    ...additionalParents.map((value) => `parent ${value}`),
    `author ${identity} ${timestamp} +0000`,
    `committer ${identity} ${timestamp} +0000`,
  ];
  const unsigned = Buffer.from(`${headers.join('\n')}\n\n${message}\n`);
  const signed = signedCommitBytes(unsigned, signer);
  const commit = runGit(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: signed,
  }).trim();
  runGit(root, ['update-ref', 'HEAD', commit, ...(parent ? [parent] : [])]);
  return commit;
}

function readString(bytes, state) {
  if (state.offset + 4 > bytes.length) throw new Error('commit SSH signature is truncated');
  const size = bytes.readUInt32BE(state.offset);
  state.offset += 4;
  if (size > bytes.length - state.offset) throw new Error('commit SSH signature is truncated');
  const value = bytes.subarray(state.offset, state.offset + size);
  state.offset += size;
  return value;
}

function extractSignatureBlob(raw) {
  const lines = raw.toString('utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('gpgsig '));
  if (start < 0) throw new Error('commit SSH signature is missing');
  const armorLines = [lines[start].slice('gpgsig '.length)];
  let index = start + 1;
  while (lines[index]?.startsWith(' ')) armorLines.push(lines[index++].slice(1));
  if (armorLines[0] !== armorBegin || armorLines.at(-1) !== armorEnd) {
    throw new Error('commit SSH signature armor is invalid');
  }
  return Buffer.from(armorLines.slice(1, -1).join(''), 'base64');
}

function signerKey(blob) {
  if (
    blob.length < magic.length + 4 ||
    !blob.subarray(0, magic.length).equals(magic) ||
    blob.readUInt32BE(magic.length) !== 1
  ) {
    throw new Error('commit SSH signature payload is invalid');
  }
  const state = { offset: magic.length + 4 };
  const keyBlob = readString(blob, state);
  const keyState = { offset: 0 };
  const algorithm = readString(keyBlob, keyState).toString('ascii');
  const rawKey = readString(keyBlob, keyState);
  if (algorithm !== 'ssh-ed25519' || rawKey.length !== 32 || keyState.offset !== keyBlob.length) {
    throw new Error('commit signer key is not canonical Ed25519');
  }
  return rawKey;
}

function commitSignature(root, commit) {
  const raw = runGit(root, ['cat-file', 'commit', commit], { binary: true });
  const blob = extractSignatureBlob(raw);
  const rawKey = signerKey(blob);
  return { blob, spki: Buffer.concat([spkiPrefix, rawKey]) };
}

export function signerFromCommit(root, commit, keyId, principalId) {
  const { spki } = commitSignature(root, commit);
  return { keyId, principalId, publicKeySpki: spki };
}

export function commitSignaturePolicy(signers) {
  const observedAt = Math.floor(Date.now() / 1_000);
  const commitSigners = signers
    .map((signer) => ({
      capability: 'SIGN_D0_COMMIT',
      key_id: signer.keyId,
      principal_id: signer.principalId,
      program_instance: 'new-aria-autonomous-engineering:D0:2026-09-01',
      public_key_spki_base64: signer.publicKeySpki.toString('base64'),
      public_key_sha256: sha256(signer.publicKeySpki),
      repository_slug: 'Okan-wqm/aquaculture_platform',
      revocation_epoch: 1,
      status: 'ACTIVE',
      valid_from: instant(observedAt - 31_536_000),
      valid_until: instant(observedAt + 31_536_000),
    }))
    .sort((left, right) => left.public_key_sha256.localeCompare(right.public_key_sha256));
  return {
    schema_version: '1.0.0',
    kind: 'new-aria-d0-commit-signature-policy',
    requirement: 'EVERY_INTRODUCED_COMMIT',
    algorithm: 'ssh-ed25519',
    current_revocation_epoch: 1,
    namespace: 'git',
    operator_observed_at: instant(observedAt),
    program_instance: 'new-aria-autonomous-engineering:D0:2026-09-01',
    repository_slug: 'Okan-wqm/aquaculture_platform',
    hash_algorithms: ['sha512'],
    commit_signers: commitSigners,
  };
}

export function expectedCommitSignatureFacts(root, base, head) {
  const commits = runGit(root, ['rev-list', `${base}..${head}`])
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
  const records = commits.map((commit_sha) => {
    const { blob, spki } = commitSignature(root, commit_sha);
    return {
      commit_sha,
      signature_sha256: sha256(blob),
      signer_key_sha256: sha256(spki),
    };
  });
  return { records, digest: sha256(Buffer.from(canonicalJson(records))) };
}
