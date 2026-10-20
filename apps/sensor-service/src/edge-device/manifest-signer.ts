import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'crypto';

import {
  canonicalJsonBytes,
  CLOUD_SIGNED_STATEMENTS,
  type CloudSigningPurpose,
  type DsseEnvelope,
  pae,
  payloadTypeOf,
  type SignedStatement,
  type StatementBodies,
  statementDigest,
  type StatementsByPurpose,
} from './edge-contract';

/**
 * The cloud's signers for the Suderra edge contract (ADR-048 DEC-3.2,
 * DEC-3.3, DEC-3.9): DSSE v1 over the exact payload bytes, Ed25519, one key
 * per purpose. A statement is signed over `PAE(payloadType, payload)` and the
 * payload bytes are kept as they were signed — nothing downstream
 * re-serializes them, so the digest another statement names and the bytes a
 * device verifies are the same bytes.
 *
 * Keys come from service secrets until the P2 KMS signer replaces
 * {@link Ed25519SigningKey} behind {@link StatementSigningKey}; that window is
 * the accepted risk EDGE-HIGH-119.
 */

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SEED_HEX = /^[0-9a-f]{64}$/;
/** Group order of edwards25519; a signature with S >= L is malleable. */
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

/** A signing key of one purpose and epoch: the seam a KMS signer replaces (P2). */
export interface StatementSigningKey<P extends CloudSigningPurpose = CloudSigningPurpose> {
  readonly purpose: P;
  readonly epoch: number;
  /** Lowercase hex SHA-256 of the raw 32-byte public key (statements.json `dsse.keyid`). */
  readonly keyid: string;
  /** Raw 32-byte Ed25519 public key. */
  readonly publicKey: Buffer;
  sign(message: Buffer): Buffer;
}

/** A key from a secret: `ed25519:<epoch>:<64 lowercase hex seed>`. */
export class Ed25519SigningKey<P extends CloudSigningPurpose = CloudSigningPurpose>
  implements StatementSigningKey<P>
{
  readonly keyid: string;
  readonly publicKey: Buffer;
  private readonly privateKey: KeyObject;

  private constructor(
    readonly purpose: P,
    readonly epoch: number,
    seed: Buffer,
  ) {
    this.privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const spki = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' });
    this.publicKey = Buffer.from(spki.subarray(ED25519_SPKI_PREFIX.length));
    this.keyid = createHash('sha256').update(this.publicKey).digest('hex');
  }

  static fromSeed<P extends CloudSigningPurpose>(
    purpose: P,
    epoch: number,
    seed: Buffer,
  ): Ed25519SigningKey<P> {
    if (seed.length !== 32) {
      throw new SigningKeyFormatError(purpose, 'the seed is not 32 bytes');
    }
    if (!Number.isInteger(epoch) || epoch < 1 || epoch > 65535) {
      throw new SigningKeyFormatError(purpose, `epoch ${epoch} is outside 1..65535`);
    }
    return new Ed25519SigningKey(purpose, epoch, seed);
  }

  /** Parses the secret value `ed25519:<epoch>:<seed hex>`. */
  static fromSecret<P extends CloudSigningPurpose>(
    purpose: P,
    secret: string,
  ): Ed25519SigningKey<P> {
    const parts = secret.trim().split(':');
    const [algorithm, epochText, seedHex] = parts;
    if (parts.length !== 3 || algorithm !== 'ed25519' || seedHex === undefined) {
      throw new SigningKeyFormatError(purpose, 'expected ed25519:<epoch>:<64 hex seed>');
    }
    if (!/^[1-9][0-9]{0,4}$/.test(epochText ?? '')) {
      throw new SigningKeyFormatError(purpose, 'the epoch is not a decimal integer');
    }
    if (!SEED_HEX.test(seedHex)) {
      throw new SigningKeyFormatError(purpose, 'the seed is not 64 lowercase hex characters');
    }
    return Ed25519SigningKey.fromSeed(purpose, Number(epochText), Buffer.from(seedHex, 'hex'));
  }

  sign(message: Buffer): Buffer {
    return sign(null, message, this.privateKey);
  }
}

/** A malformed signing-key secret; the service refuses to boot with one. */
export class SigningKeyFormatError extends Error {
  constructor(purpose: CloudSigningPurpose, reason: string) {
    // The secret's value is never part of the message.
    super(`The ${purpose} signing key secret is malformed: ${reason}`);
    this.name = 'SigningKeyFormatError';
  }
}

/**
 * Signs the statements of exactly one purpose. The type parameter ties a
 * signer to the statement types its purpose may sign (StatementsByPurpose),
 * so a statement signed with another purpose's key — which every verifier
 * rejects as key-purpose-mismatch — does not compile.
 */
export class ManifestSigner<P extends Exclude<CloudSigningPurpose, 'command'>> {
  constructor(private readonly key: StatementSigningKey<P>) {}

  get purpose(): P {
    return this.key.purpose;
  }

  get keyid(): string {
    return this.key.keyid;
  }

  get epoch(): number {
    return this.key.epoch;
  }

  get publicKey(): Buffer {
    return this.key.publicKey;
  }

  sign<T extends StatementsByPurpose[P]>(type: T, body: StatementBodies[T]): SignedStatement<T> {
    const allowed: readonly string[] = CLOUD_SIGNED_STATEMENTS[this.key.purpose];
    if (!allowed.includes(type) || body._type !== type) {
      // Unreachable through the types; kept because a wrong-purpose
      // signature is a statement every device refuses.
      throw new Error(`${this.key.purpose} does not sign ${type}`);
    }
    const payloadType = payloadTypeOf(type);
    const payloadBytes = canonicalJsonBytes(body);
    const sig = this.key.sign(pae(payloadType, payloadBytes));
    const envelope: DsseEnvelope = {
      payloadType,
      payload: payloadBytes.toString('base64'),
      signatures: [{ keyid: this.key.keyid, sig: sig.toString('base64') }],
    };
    return { type, body, payloadBytes, digest: statementDigest(payloadBytes), envelope };
  }
}

// ---------------------------------------------------------------- verification

/** A public key the cloud checks a statement it did not sign against. */
export interface VerificationKey {
  readonly purpose: string;
  readonly epoch: number;
  readonly keyid: string;
  readonly publicKey: Buffer;
}

export function keyidOf(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex');
}

/** Why the cloud refused a statement it was handed (a bundle, a release). */
export class StatementAdmissionError extends Error {
  constructor(what: string, reason: string) {
    super(`${what} was refused: ${reason}`);
    this.name = 'StatementAdmissionError';
  }
}

/**
 * Checks a DSSE envelope the cloud forwards but did not sign — the fleet-root
 * trust-anchors bundle and the edge-release statement — before it names it in
 * a manifest. This is admission, not authority: the device runs the full
 * contract verifier itself (statements.json). It checks the payload type, a
 * single signature from a key of the expected purpose, a canonical S and the
 * Ed25519 equation over PAE, and returns the signed payload bytes.
 */
export function admitEnvelope(
  what: string,
  envelope: DsseEnvelope,
  expectedPayloadType: string,
  purpose: string,
  keys: readonly VerificationKey[],
): Buffer {
  if (envelope.payloadType !== expectedPayloadType) {
    throw new StatementAdmissionError(what, `payloadType ${envelope.payloadType}`);
  }
  if (envelope.signatures.length !== 1) {
    throw new StatementAdmissionError(what, 'it does not carry exactly one signature');
  }
  const [signature] = envelope.signatures;
  const key = keys.find((k) => k.keyid === signature.keyid);
  if (key === undefined) {
    throw new StatementAdmissionError(what, `keyid ${signature.keyid} is unknown`);
  }
  if (key.purpose !== purpose) {
    throw new StatementAdmissionError(what, `keyid ${signature.keyid} is a ${key.purpose} key`);
  }
  const payloadBytes = Buffer.from(envelope.payload, 'base64');
  if (payloadBytes.toString('base64') !== envelope.payload) {
    throw new StatementAdmissionError(what, 'the payload is not canonical base64');
  }
  const sig = Buffer.from(signature.sig, 'base64');
  if (sig.length !== 64 || sig.toString('base64') !== signature.sig) {
    throw new StatementAdmissionError(what, 'the signature is not canonical base64 of 64 bytes');
  }
  let s = 0n;
  for (let i = 63; i >= 32; i -= 1) s = (s << 8n) | BigInt(sig[i] ?? 0);
  if (s >= ED25519_L) {
    throw new StatementAdmissionError(what, 'the signature is malleable (S >= L)');
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, key.publicKey]),
    format: 'der',
    type: 'spki',
  });
  if (!verify(null, pae(envelope.payloadType, payloadBytes), publicKey, sig)) {
    throw new StatementAdmissionError(what, 'the signature does not verify');
  }
  return payloadBytes;
}
