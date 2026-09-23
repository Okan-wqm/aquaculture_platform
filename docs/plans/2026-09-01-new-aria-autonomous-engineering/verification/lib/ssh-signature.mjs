import { createHash, createPublicKey, verify } from 'node:crypto';

const magic = Buffer.from('SSHSIG', 'ascii');
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const begin = '-----BEGIN SSH SIGNATURE-----';
const end = '-----END SSH SIGNATURE-----';

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function sshString(value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint32(bytes.length), bytes]);
}

function readUint32(bytes, state, label) {
  if (state.offset + 4 > bytes.length) throw new Error(`${label}: truncated uint32`);
  const value = bytes.readUInt32BE(state.offset);
  state.offset += 4;
  return value;
}

function readString(bytes, state, label) {
  const length = readUint32(bytes, state, label);
  if (length > bytes.length - state.offset) throw new Error(`${label}: truncated string`);
  const value = bytes.subarray(state.offset, state.offset + length);
  state.offset += length;
  return value;
}

function finished(bytes, state, label) {
  if (state.offset !== bytes.length) throw new Error(`${label}: trailing bytes`);
}

function ascii(bytes, label) {
  const value = bytes.toString('ascii');
  if (!Buffer.from(value, 'ascii').equals(bytes)) throw new Error(`${label}: non-ASCII value`);
  return value;
}

function parseArmor(lines) {
  if (lines.length < 3 || lines[0] !== begin || lines.at(-1) !== end) {
    throw new Error('commit SSH signature armor is invalid');
  }
  const encoded = lines.slice(1, -1);
  if (
    encoded.some(
      (line, index) =>
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(line) ||
        line.length === 0 ||
        line.length > 70 ||
        (index < encoded.length - 1 && line.length !== 70),
    )
  ) {
    throw new Error('commit SSH signature armor is not canonical');
  }
  const base64 = encoded.join('');
  const blob = Buffer.from(base64, 'base64');
  if (blob.toString('base64') !== base64) {
    throw new Error('commit SSH signature base64 is not canonical');
  }
  return blob;
}

function extractSignatureHeader(lines) {
  let signature = null;
  const retained = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('gpgsig ')) {
      if (signature) throw new Error('commit must contain exactly one SSH signature');
      signature = [line.slice('gpgsig '.length)];
      while (lines[index + 1]?.startsWith(' ')) {
        index += 1;
        signature.push(lines[index].slice(1));
      }
    } else {
      if (line.startsWith('gpgsig')) throw new Error('unsupported commit signature header');
      retained.push(line);
    }
  }
  if (!signature) throw new Error('commit SSH signature is missing');
  return { retained, signature };
}

function splitSignedCommit(rawCommit) {
  if (!Buffer.isBuffer(rawCommit) || rawCommit.length === 0) {
    throw new Error('commit object bytes are required');
  }
  const separator = rawCommit.indexOf('\n\n');
  if (separator < 0) throw new Error('commit object header terminator is missing');
  const headers = new TextDecoder('utf-8', { fatal: true }).decode(
    rawCommit.subarray(0, separator),
  );
  const { retained, signature } = extractSignatureHeader(headers.split('\n'));
  const unsigned = Buffer.concat([
    Buffer.from(retained.join('\n'), 'utf8'),
    Buffer.from('\n\n'),
    rawCommit.subarray(separator + 2),
  ]);
  return { signatureBlob: parseArmor(signature), unsigned };
}

function parsePublicKey(blob) {
  const state = { offset: 0 };
  const algorithm = ascii(readString(blob, state, 'SSH public key'), 'SSH public key algorithm');
  const key = readString(blob, state, 'SSH public key');
  finished(blob, state, 'SSH public key');
  if (algorithm !== 'ssh-ed25519' || key.length !== 32) {
    throw new Error('commit signer key must be ssh-ed25519');
  }
  return key;
}

function parseSignature(blob) {
  const state = { offset: 0 };
  const algorithm = ascii(readString(blob, state, 'SSH signature'), 'SSH signature algorithm');
  const signature = readString(blob, state, 'SSH signature');
  finished(blob, state, 'SSH signature');
  if (algorithm !== 'ssh-ed25519' || signature.length !== 64) {
    throw new Error('commit signature must be ssh-ed25519');
  }
  return signature;
}

function parseSshsig(blob, allowedHashes) {
  if (!blob.subarray(0, magic.length).equals(magic)) throw new Error('SSHSIG magic mismatch');
  const state = { offset: magic.length };
  if (readUint32(blob, state, 'SSHSIG') !== 1) throw new Error('SSHSIG version must be 1');
  const publicKey = parsePublicKey(readString(blob, state, 'SSHSIG'));
  const namespace = ascii(readString(blob, state, 'SSHSIG'), 'SSHSIG namespace');
  const reserved = readString(blob, state, 'SSHSIG');
  const hashAlgorithm = ascii(readString(blob, state, 'SSHSIG'), 'SSHSIG hash algorithm');
  const signature = parseSignature(readString(blob, state, 'SSHSIG'));
  finished(blob, state, 'SSHSIG');
  if (namespace !== 'git' || reserved.length !== 0) {
    throw new Error('SSHSIG namespace or reserved field mismatch');
  }
  if (!allowedHashes.includes(hashAlgorithm)) throw new Error('SSHSIG hash algorithm is denied');
  return { hashAlgorithm, publicKey, signature };
}

function ed25519Key(spkiBase64) {
  const bytes = Buffer.from(spkiBase64, 'base64');
  if (
    bytes.toString('base64') !== spkiBase64 ||
    !bytes.subarray(0, spkiPrefix.length).equals(spkiPrefix)
  ) {
    throw new Error('commit signer SPKI is not canonical Ed25519');
  }
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  const canonical = key.export({ format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519' || !canonical.equals(bytes) || bytes.length !== 44) {
    throw new Error('commit signer SPKI is not canonical Ed25519');
  }
  return { key, raw: bytes.subarray(spkiPrefix.length), spki: bytes };
}

function signedData(unsigned, hashAlgorithm) {
  const digest = createHash(hashAlgorithm).update(unsigned).digest();
  return Buffer.concat([
    magic,
    sshString(Buffer.from('git')),
    sshString(Buffer.alloc(0)),
    sshString(Buffer.from(hashAlgorithm)),
    sshString(digest),
  ]);
}

export function inspectCommitSshSignature(rawCommit, allowedHashes) {
  const { signatureBlob } = splitSignedCommit(rawCommit);
  const parsed = parseSshsig(signatureBlob, allowedHashes);
  return {
    signatureBlob,
    signerSpki: Buffer.concat([spkiPrefix, parsed.publicKey]),
  };
}

export function verifyCommitSshSignature(rawCommit, signer, allowedHashes) {
  const { signatureBlob, unsigned } = splitSignedCommit(rawCommit);
  const parsed = parseSshsig(signatureBlob, allowedHashes);
  const authorized = ed25519Key(signer.public_key_spki_base64);
  if (!parsed.publicKey.equals(authorized.raw))
    throw new Error('commit signer key is unauthorized');
  if (!verify(null, signedData(unsigned, parsed.hashAlgorithm), authorized.key, parsed.signature)) {
    throw new Error('commit SSH signature is invalid');
  }
  return { signatureBlob, signerSpki: authorized.spki };
}
