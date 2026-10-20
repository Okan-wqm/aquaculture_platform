import { createPublicKey, verify } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  CommandEnvelopeSigner,
  CommandParamsEncodingError,
  canonicalParamsBytes,
  envelopeCanonicalBytes,
} from '../command-envelope-signer.service';
import { Ed25519SigningKey } from '../manifest-signer';

/**
 * The cross-language vector (ADR-048 DEC-9.2): written from the Rust layout by
 * scripts/edge/command_envelope_vector.py, verified by the agent in
 * sens-api-gateway/src/command_envelope/cloud_signer_vector.rs. The cloud
 * signer must reproduce every byte of it.
 */
interface CommandEnvelopeVector {
  readonly seed_hex: string;
  readonly public_key_hex: string;
  readonly inputs: {
    readonly cmd: string;
    readonly params: Record<string, unknown>;
    readonly actor: string;
    readonly tenant: string;
    readonly iat_unix_secs: number;
    readonly exp_unix_secs: number;
    readonly claimed_policy_version: number;
    readonly jti: string;
    readonly nonce: string;
  };
  readonly canonical_params_hex: string;
  readonly cmd_hash_hex: string;
  readonly envelope_canonical_bytes_hex: string;
  readonly signature_hex: string;
  readonly wire: string;
}

const VECTOR = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../../../sens-api-gateway/tests/fixtures/command-envelope-v3/platform-command.json',
    ),
    'utf8',
  ),
) as CommandEnvelopeVector;

describe('the cloud signer reproduces the cross-language CommandEnvelope v3 vector', () => {
  const key = Ed25519SigningKey.fromSeed('command', 1, Buffer.from(VECTOR.seed_hex, 'hex'));
  const { inputs } = VECTOR;
  const envelope = new CommandEnvelopeSigner(key).sign({
    cmd: inputs.cmd,
    params: inputs.params,
    actorUuid: inputs.actor,
    tenantUuid: inputs.tenant,
    claimedPolicyVersion: inputs.claimed_policy_version,
    jti: inputs.jti,
    nonce: inputs.nonce,
    now: new Date(inputs.iat_unix_secs * 1000),
    validitySecs: inputs.exp_unix_secs - inputs.iat_unix_secs,
  });

  it('derives the same key from the TEST-ONLY seed', () => {
    expect(key.publicKey.toString('hex')).toBe(VECTOR.public_key_hex);
  });

  it('writes the canonical params, cmd_hash and transcript byte for byte', () => {
    expect(canonicalParamsBytes(inputs.cmd, inputs.params).toString('hex')).toBe(
      VECTOR.canonical_params_hex,
    );
    expect(Buffer.from(envelope.cmd_hash).toString('hex')).toBe(VECTOR.cmd_hash_hex);
    const transcript = envelopeCanonicalBytes({
      cmd: envelope.cmd,
      params: envelope.params,
      actor: Buffer.from(envelope.actor),
      tenantId: Buffer.from(envelope.tenant_id),
      iat: envelope.iat_unix_secs,
      exp: envelope.exp_unix_secs,
      claimedPolicyVersion: envelope.claimed_policy_version,
      coApproverActor: null,
      jti: envelope.jti,
      nonce: envelope.nonce,
      cmdHash: Buffer.from(envelope.cmd_hash),
    });
    expect(transcript.toString('hex')).toBe(VECTOR.envelope_canonical_bytes_hex);
  });

  it('signs it with the same deterministic Ed25519 signature', () => {
    expect(Buffer.from(envelope.signature).toString('hex')).toBe(VECTOR.signature_hex);
  });

  it('publishes the wire envelope the agent parses: the same members, shapes and values', () => {
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(JSON.parse(VECTOR.wire));
  });
});

describe('command envelope signer (SEC-MEDIUM-105; ADR-048 DEC-9.2)', () => {
  describe('canonicalParamsBytes', () => {
    it('is deterministic regardless of key insertion order', () => {
      const a = canonicalParamsBytes('ping', { zeta: 1, alpha: 2, mid: 'x' });
      const b = canonicalParamsBytes('ping', { mid: 'x', zeta: 1, alpha: 2 });
      expect(a.equals(b)).toBe(true);
    });

    it('starts with u32 BE cmd length + cmd bytes', () => {
      const bytes = canonicalParamsBytes('reboot', {});
      expect(bytes.readUInt32BE(0)).toBe(6);
      expect(bytes.slice(4, 10).toString('ascii')).toBe('reboot');
    });

    it('ends with the command-envelope-v1 domain tag', () => {
      const bytes = canonicalParamsBytes('ping', {});
      expect(bytes.slice(-19).toString('ascii')).toBe('command-envelope-v1');
    });

    it('rejects nested objects (determinism gate)', () => {
      expect(() => canonicalParamsBytes('ping', { nested: { inner: 1 } })).toThrow(
        /Nested objects/,
      );
    });

    it('rejects empty cmd', () => {
      expect(() => canonicalParamsBytes('', {})).toThrow(/non-empty/);
    });

    it('orders keys by code point at every depth, as the agent BTreeMap does', () => {
      const bytes = canonicalParamsBytes('ping', {
        b: [{ z: 1, A: 2, a: [{ y: 0, x: 0 }] }],
        '\u{1F41F}': 1,
        '\uFFFF': 2,
        B: 3,
      });
      const json = bytes.subarray(8, bytes.length - 19).toString('utf8');
      expect(json).toBe('{"B":3,"b":[{"A":2,"a":[{"x":0,"y":0}],"z":1}],"\uFFFF":2,"\u{1F41F}":1}');
    });

    it.each<[string, unknown]>([
      ['a non-integer the agent writes with an exponent', 0.000005],
      ['an integer beyond 2^53', 2 ** 60],
      ['a non-finite number', Number.NaN],
      ['an unpaired surrogate', 'broken \uD800 text'],
      ['a value JSON cannot carry', undefined],
      ['an object that is not plain JSON', new Date(0)],
      ['a nested value the agent would write differently', [{ deep: [1e-7] }]],
    ])('refuses %s before signing', (_case, value) => {
      expect(() => canonicalParamsBytes('ping', { value })).toThrow(CommandParamsEncodingError);
    });
  });

  describe('envelopeCanonicalBytes', () => {
    it('ends with the command-envelope-sig-v3 domain tag', () => {
      const bytes = envelopeCanonicalBytes({
        cmd: 'ping',
        params: {},
        actor: Buffer.alloc(16),
        tenantId: Buffer.alloc(16),
        iat: 100,
        exp: 200,
        claimedPolicyVersion: 1,
        coApproverActor: null,
        jti: 'test-jti',
        nonce: 'test-nonce',
        cmdHash: Buffer.alloc(32),
      });
      expect(bytes.slice(-23).toString('ascii')).toBe('command-envelope-sig-v3');
    });
  });

  describe('CommandEnvelopeSigner.sign', () => {
    // 32-byte all-zero seed: deterministic for tests, never used in production
    const key = Ed25519SigningKey.fromSeed('command', 1, Buffer.alloc(32));
    const signer = new CommandEnvelopeSigner(key);
    const input = {
      cmd: 'write_modbus',
      params: { register: 40001, value: 1234 },
      actorUuid: '01234567-89ab-4def-8abc-0123456789ab',
      tenantUuid: 'fedcba98-7654-3210-fedc-ba9876543210',
      claimedPolicyVersion: 3,
      jti: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
      validitySecs: 60,
      now: new Date('2026-10-20T12:00:00Z'),
    };

    it("signs the v3 transcript with the command key, under the caller's jti", () => {
      const envelope = signer.sign(input);
      expect(envelope.jti).toBe(input.jti);
      expect(envelope.claimed_policy_version).toBe(3);
      expect(envelope.iat_unix_secs).toBe(1792497600);
      expect(envelope.exp_unix_secs - envelope.iat_unix_secs).toBe(60);
      expect(envelope.cmd_hash).toHaveLength(32);
      expect(envelope.signature).toHaveLength(64);

      const transcript = envelopeCanonicalBytes({
        cmd: envelope.cmd,
        params: envelope.params,
        actor: Buffer.from(envelope.actor),
        tenantId: Buffer.from(envelope.tenant_id),
        iat: envelope.iat_unix_secs,
        exp: envelope.exp_unix_secs,
        claimedPolicyVersion: envelope.claimed_policy_version,
        coApproverActor: null,
        jti: envelope.jti,
        nonce: envelope.nonce,
        cmdHash: Buffer.from(envelope.cmd_hash),
      });
      const publicKey = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.publicKey]),
        format: 'der',
        type: 'spki',
      });
      expect(verify(null, transcript, publicKey, Buffer.from(envelope.signature))).toBe(true);
    });

    it('never produces a co-approver: one platform key cannot be two persons (DEC-9.4)', () => {
      const envelope = signer.sign(input);
      expect(envelope.co_approver_actor).toBeNull();
      expect(envelope.co_approver_signature).toBeNull();
    });

    it('uses a fresh nonce for every envelope', () => {
      expect(signer.sign(input).nonce).not.toBe(signer.sign(input).nonce);
    });

    it('throws on malformed UUID', () => {
      expect(() => signer.sign({ ...input, actorUuid: 'not-a-uuid' })).toThrow(/Invalid UUID/);
    });

    it('refuses nested params (the v3 canonical form cannot carry them; SENSOR-HIGH-209)', () => {
      expect(() => signer.sign({ ...input, params: { meta: { a: 1 } } })).toThrow(/Nested objects/);
    });
  });
});
