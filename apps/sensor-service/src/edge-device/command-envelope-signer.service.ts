import { createHash, createPrivateKey, sign as cryptoSign, randomUUID } from 'crypto';

/**
 * Cloud-side ed25519 command-envelope signer (SEC-MEDIUM-105 — 2026-08-23
 * scan №50).
 *
 * Produces wire-compatible CommandEnvelope v3 payloads for the Rust edge
 * agent's `SignatureMode::Enforcing` verification path. The canonical-bytes
 * transcript is BYTE-IDENTICAL to `envelope_canonical_bytes` +
 * `canonical_params` in `sens-api-gateway/src/command_envelope/` — the
 * cross-language test vector in `__tests__/command-envelope-signer.spec.ts`
 * pins that equivalence with a shared seed + fixed inputs.
 *
 * Wire format (all integers big-endian):
 *   canonical_params: u32 cmd_len + cmd + sorted-JSON(params) + "command-envelope-v1"
 *   envelope: u32 cmd_len + cmd + u32 params_len + canonical_params
 *             + 16 actor + 16 tenant
 *             + i64 iat + i64 exp + u64 policy_version
 *             + u8 co_approver_presence + (16 co_approver | nothing)
 *             + u32 jti_len + jti + u32 nonce_len + nonce
 *             + 32 cmd_hash + "command-envelope-sig-v3"
 *
 * Key material: `SENSOR_COMMAND_SIGNING_KEY_SEED_HEX` (32-byte ed25519 seed,
 * hex). Unset ⇒ signCommandEnvelope returns the envelope unsigned (edge
 * warns under Permissive; Enforcing rejects — the operator's rollout
 * discipline per plan §2 HC-6).
 */

const DOMAIN_TAG_PARAMS = Buffer.from('command-envelope-v1', 'ascii');
const DOMAIN_TAG_ENVELOPE = Buffer.from('command-envelope-sig-v3', 'ascii');

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SEED_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface EnvelopeCommandParams {
  cmd: string;
  params: Record<string, unknown>;
  actorUuid: string;
  tenantUuid: string;
  /** Seconds from now until expiry (default 300). */
  validitySecs?: number;
  /** Monotonic policy version the envelope claims (default 1). */
  claimedPolicyVersion?: number;
  coApproverActorUuid?: string | null;
}

export interface SignedCommandEnvelope {
  cmd: string;
  params: Record<string, unknown>;
  actor: number[];
  tenant_id: number[];
  iat_unix_secs: number;
  exp_unix_secs: number;
  claimed_policy_version: number;
  jti: string;
  nonce: string;
  cmd_hash: number[];
  signature: number[] | null;
  co_approver_actor: number[] | null;
  co_approver_signature: number[] | null;
}

function uuidTo16Bytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Deterministic JSON serialization matching serde_json::to_vec on a
 * BTreeMap<String, Value>: lexicographically-sorted keys, no spaces,
 * standard JSON value encoding. Nested objects are rejected (matching the
 * Rust canonical_params gate).
 */
function canonicalJsonParams(params: Record<string, unknown>): Buffer {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      throw new Error(
        `Nested objects are not supported in command params (key: ${key}) — the canonical format rejects them for determinism`,
      );
    }
    sorted[key] = value;
  }
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

/**
 * Mirrors `canonical_params(cmd, params)` in canonical.rs — the cmd_hash input.
 */
export function canonicalParamsBytes(cmd: string, params: Record<string, unknown>): Buffer {
  if (!cmd) {
    throw new Error('cmd must be non-empty');
  }
  const cmdBytes = Buffer.from(cmd, 'utf8');
  const paramsBytes = canonicalJsonParams(params);
  const cmdLen = Buffer.alloc(4);
  cmdLen.writeUInt32BE(cmdBytes.length, 0);
  return Buffer.concat([cmdLen, cmdBytes, paramsBytes, DOMAIN_TAG_PARAMS]);
}

/**
 * Mirrors `envelope_canonical_bytes(env)` in envelope.rs — the signature input.
 */
export function envelopeCanonicalBytes(env: {
  cmd: string;
  params: Record<string, unknown>;
  actor: Buffer;
  tenantId: Buffer;
  iat: number;
  exp: number;
  claimedPolicyVersion: number;
  coApproverActor: Buffer | null;
  jti: string;
  nonce: string;
  cmdHash: Buffer;
}): Buffer {
  const cmdBytes = Buffer.from(env.cmd, 'utf8');
  const paramsBytes = canonicalParamsBytes(env.cmd, env.params);
  const cmdLen = Buffer.alloc(4);
  cmdLen.writeUInt32BE(cmdBytes.length, 0);
  const paramsLen = Buffer.alloc(4);
  paramsLen.writeUInt32BE(paramsBytes.length, 0);

  const iat = Buffer.alloc(8);
  iat.writeBigInt64BE(BigInt(env.iat), 0);
  const exp = Buffer.alloc(8);
  exp.writeBigInt64BE(BigInt(env.exp), 0);
  const policy = Buffer.alloc(8);
  policy.writeBigUInt64BE(BigInt(env.claimedPolicyVersion), 0);

  const jtiBytes = Buffer.from(env.jti, 'utf8');
  const jtiLen = Buffer.alloc(4);
  jtiLen.writeUInt32BE(jtiBytes.length, 0);

  const nonceBytes = Buffer.from(env.nonce, 'utf8');
  const nonceLen = Buffer.alloc(4);
  nonceLen.writeUInt32BE(nonceBytes.length, 0);

  const coApprover = env.coApproverActor
    ? Buffer.concat([Buffer.from([1]), env.coApproverActor])
    : Buffer.from([0]);

  return Buffer.concat([
    cmdLen,
    cmdBytes,
    paramsLen,
    paramsBytes,
    env.actor,
    env.tenantId,
    iat,
    exp,
    policy,
    coApprover,
    jtiLen,
    jtiBytes,
    nonceLen,
    nonceBytes,
    env.cmdHash,
    DOMAIN_TAG_ENVELOPE,
  ]);
}

export interface CommandSignerConfig {
  get(key: string, defaultValue?: string): string | undefined;
}

export class CommandEnvelopeSignerService {
  private seed: Buffer | null = null;

  constructor(config: CommandSignerConfig) {
    const seedHex = config.get('SENSOR_COMMAND_SIGNING_KEY_SEED_HEX', '');
    if (seedHex && SEED_HEX_PATTERN.test(seedHex)) {
      this.seed = Buffer.from(seedHex, 'hex');
    } else if (seedHex) {
      throw new Error(
        'SENSOR_COMMAND_SIGNING_KEY_SEED_HEX must be 64 lowercase hex chars (32-byte ed25519 seed)',
      );
    }
  }

  get isSigningEnabled(): boolean {
    return this.seed !== null;
  }

  /**
   * Build + sign a v3 CommandEnvelope. Returns null when signing is not
   * configured (the caller publishes unsigned — the edge's rollout mode
   * decides acceptance).
   */
  sign(input: EnvelopeCommandParams): SignedCommandEnvelope | null {
    if (!this.seed) {
      return null;
    }

    const actor = uuidTo16Bytes(input.actorUuid);
    const tenantId = uuidTo16Bytes(input.tenantUuid);
    const coApprover = input.coApproverActorUuid ? uuidTo16Bytes(input.coApproverActorUuid) : null;

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + (input.validitySecs ?? 300);
    const claimedPolicyVersion = input.claimedPolicyVersion ?? 1;
    const jti = randomUUID();
    const nonce = randomUUID().replace(/-/g, '');

    const cmdHash = createHash('sha256')
      .update(canonicalParamsBytes(input.cmd, input.params))
      .digest();

    const canonicalBytes = envelopeCanonicalBytes({
      cmd: input.cmd,
      params: input.params,
      actor,
      tenantId,
      iat,
      exp,
      claimedPolicyVersion,
      coApproverActor: coApprover,
      jti,
      nonce,
      cmdHash,
    });

    // ed25519 seed → PKCS8 DER → sign (same wrapping as DeploySigningService)
    const pkcs8Der = Buffer.concat([ED25519_PKCS8_SEED_PREFIX, this.seed]);
    const privateKey = createPrivateKey({
      key: pkcs8Der,
      format: 'der',
      type: 'pkcs8',
    });
    const signature = cryptoSign(null, canonicalBytes, privateKey);

    return {
      cmd: input.cmd,
      params: input.params,
      actor: Array.from(actor),
      tenant_id: Array.from(tenantId),
      iat_unix_secs: iat,
      exp_unix_secs: exp,
      claimed_policy_version: claimedPolicyVersion,
      jti,
      nonce,
      cmd_hash: Array.from(cmdHash),
      signature: Array.from(signature),
      co_approver_actor: coApprover ? Array.from(coApprover) : null,
      co_approver_signature: null,
    };
  }
}
