import { createHash, randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';

import { type StatementSigningKey } from './manifest-signer';
import { RbacManifestService } from './rbac-manifest.service';
import { SuderraEdgeConfig } from './suderra-edge.config';

/**
 * Cloud-side ed25519 command-envelope signer (SEC-MEDIUM-105 — 2026-08-23
 * scan №50).
 *
 * Produces wire-compatible CommandEnvelope v3 payloads for the Rust edge
 * agent's `SignatureMode::Enforcing` verification path. The canonical-bytes
 * transcript must be byte-identical to `envelope_canonical_bytes` +
 * `canonical_params` in `sens-api-gateway/src/command_envelope/`. One fixed
 * vector pins that across the two languages:
 * `sens-api-gateway/tests/fixtures/command-envelope-v3/platform-command.json`
 * (seed, inputs, canonical params, cmd_hash, transcript, signature and the
 * wire JSON), produced by `scripts/edge/command_envelope_vector.py` from the
 * Rust layout. `__tests__/command-envelope-signer.spec.ts` asserts this
 * signer reproduces it byte for byte; the agent's
 * `command_envelope/cloud_signer_vector.rs` parses the wire JSON, recomputes
 * every byte and verifies the signature as Enforcing mode does.
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
 * Key material: the Suderra edge channel's `command` key
 * (SUDERRA_EDGE_COMMAND_SIGNING_KEY, ADR-048 DEC-3.3), anchored for the
 * device in the trust-anchors bundle and named by the RBAC manifest as the
 * platform actor's key. Nothing here publishes unsigned: a device that
 * needs a signature gets one or no command (EdgeCommandPublisher).
 */

const DOMAIN_TAG_PARAMS = Buffer.from('command-envelope-v1', 'ascii');
const DOMAIN_TAG_ENVELOPE = Buffer.from('command-envelope-sig-v3', 'ascii');

export interface EnvelopeCommandParams {
  cmd: string;
  params: Record<string, unknown>;
  actorUuid: string;
  tenantUuid: string;
  /** Monotonic policy version the envelope claims. */
  claimedPolicyVersion: number;
  /** The command's correlation id; the agent reports its result under it. */
  jti: string;
  /** Seconds from now until expiry (default 300). */
  validitySecs?: number;
  /** Signing instant (default: now). */
  now?: Date;
  /** Operator-visible correlator (default: a fresh random value per envelope). */
  nonce?: string;
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
  /** The cloud signs every envelope it produces. */
  signature: number[];
  /** Never present: one platform key cannot be two persons (DEC-9.4). */
  co_approver_actor: null;
  co_approver_signature: null;
}

function uuidTo16Bytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * A command parameter the agent would canonicalize differently from the
 * cloud, so its cmd_hash would never match: refused before anything is
 * signed or published.
 */
export class CommandParamsEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandParamsEncodingError';
  }
}

/**
 * The smallest magnitude of a non-integer whose shortest round-trip form is
 * the same plain decimal in JavaScript and in the agent's serde_json: below
 * it serde_json writes an exponent (`5e-6`) where JavaScript still writes
 * `0.000005`. Every non-integer is below 2^53, where both write plain
 * decimals again.
 */
const MIN_PLAIN_DECIMAL = 1e-5;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Orders keys as Rust's BTreeMap<String, _> does: by UTF-8 bytes, i.e. by code point. */
function byCodePoint(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function encodeString(text: string, where: string): string {
  if (LONE_SURROGATE.test(text)) {
    throw new CommandParamsEncodingError(`${where} holds an unpaired UTF-16 surrogate`);
  }
  // JSON.stringify escapes exactly what serde_json escapes: `"`, `\`, the
  // short forms \b \t \n \f \r and every other control character as a
  // lowercase \u00XX; everything else, non-ASCII included, is raw UTF-8.
  return JSON.stringify(text);
}

/**
 * One value as serde_json writes the agent's parse of it. serde_json's map
 * is a BTreeMap (the crate does not enable `preserve_order`), so an object
 * at any depth is written with its keys in code-point order.
 */
function encodeParamValue(value: unknown, where: string): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CommandParamsEncodingError(`${where} is ${value}, which JSON cannot carry`);
    }
    if (
      Number.isInteger(value) ? !Number.isSafeInteger(value) : Math.abs(value) < MIN_PLAIN_DECIMAL
    ) {
      throw new CommandParamsEncodingError(
        `${where} is ${value}; the agent would write it in another form than the cloud signs`,
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return encodeString(value, where);
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encodeParamValue(item, `${where}[${index}]`)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const members = Object.keys(value)
      .sort(byCodePoint)
      .map(
        (key) =>
          `${encodeString(key, `${where} key`)}:${encodeParamValue(value[key], `${where}.${key}`)}`,
      );
    return `{${members.join(',')}}`;
  }
  throw new CommandParamsEncodingError(`${where} is a ${typeof value}, which JSON cannot carry`);
}

/**
 * Deterministic JSON serialization matching serde_json::to_vec on the
 * agent's BTreeMap<String, Value> of the params it received: keys in
 * code-point order at every depth, no spaces, and only values both sides
 * write identically. A nested object as a top-level value is rejected,
 * matching the Rust canonical_params gate (SENSOR-HIGH-209).
 */
function canonicalJsonParams(params: Readonly<Record<string, unknown>>): Buffer {
  const members = Object.keys(params)
    .sort(byCodePoint)
    .map((key) => {
      const value = params[key];
      if (isPlainObject(value)) {
        throw new CommandParamsEncodingError(
          `Nested objects are not supported in command params (key: ${key}) — the canonical format rejects them for determinism`,
        );
      }
      return `${encodeString(key, 'params key')}:${encodeParamValue(value, `params.${key}`)}`;
    });
  return Buffer.from(`{${members.join(',')}}`, 'utf8');
}

/**
 * Mirrors `canonical_params(cmd, params)` in canonical.rs — the cmd_hash input.
 */
export function canonicalParamsBytes(cmd: string, params: Record<string, unknown>): Buffer {
  if (!cmd) {
    throw new CommandParamsEncodingError('cmd must be non-empty');
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

/**
 * Signs command envelopes with one key of the `command` purpose. Pure: the
 * key, the actor and the policy version are its inputs; the clock is read
 * once per envelope. There is no co-approver input: until operator keys and
 * two-person co-signing arrive (DEC-9.4 P2, EDGE-MEDIUM-121) a second
 * signature from the same platform key would only imitate two-person
 * integrity, so the device keeps refusing that command class fail-closed.
 */
export class CommandEnvelopeSigner {
  constructor(private readonly key: StatementSigningKey<'command'>) {}

  sign(input: EnvelopeCommandParams): SignedCommandEnvelope {
    const actor = uuidTo16Bytes(input.actorUuid);
    const tenantId = uuidTo16Bytes(input.tenantUuid);

    const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
    const exp = iat + (input.validitySecs ?? 300);
    const nonce = input.nonce ?? randomUUID().replace(/-/g, '');

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
      claimedPolicyVersion: input.claimedPolicyVersion,
      coApproverActor: null,
      jti: input.jti,
      nonce,
      cmdHash,
    });
    const signature = this.key.sign(canonicalBytes);

    return {
      cmd: input.cmd,
      params: input.params,
      actor: Array.from(actor),
      tenant_id: Array.from(tenantId),
      iat_unix_secs: iat,
      exp_unix_secs: exp,
      claimed_policy_version: input.claimedPolicyVersion,
      jti: input.jti,
      nonce,
      cmd_hash: Array.from(cmdHash),
      signature: Array.from(signature),
      co_approver_actor: null,
      co_approver_signature: null,
    };
  }
}

/**
 * The cloud's platform-actor command signer (ADR-048 DEC-9.2, DEC-9.4): the
 * key is the channel's `command` key, the actor the RBAC manifest's platform
 * actor and the claimed policy_version the manifest's (the agent refuses a
 * claim below the installed manifest). Used only through
 * EdgeCommandPublisher, the single command publish path.
 */
@Injectable()
export class CommandEnvelopeSignerService {
  constructor(
    private readonly config: SuderraEdgeConfig,
    private readonly rbac: RbacManifestService,
  ) {}

  /** True when this deployment holds the channel's command key. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  signPlatformCommand(command: {
    readonly cmd: string;
    readonly params: Record<string, unknown>;
    readonly tenantId: string;
    readonly jti: string;
  }): SignedCommandEnvelope {
    return new CommandEnvelopeSigner(this.config.settings.keys.command).sign({
      cmd: command.cmd,
      params: command.params,
      actorUuid: this.rbac.platformActorId,
      tenantUuid: command.tenantId,
      claimedPolicyVersion: this.rbac.policyVersion,
      jti: command.jti,
    });
  }
}
