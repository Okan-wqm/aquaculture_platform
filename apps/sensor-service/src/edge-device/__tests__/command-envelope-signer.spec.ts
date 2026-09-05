import { createHash } from 'crypto';

import {
  CommandEnvelopeSignerService,
  canonicalParamsBytes,
  envelopeCanonicalBytes,
} from '../command-envelope-signer.service';

describe('CommandEnvelopeSignerService (SEC-MEDIUM-105 — 2026-08-23 scan №50)', () => {
  // 32-byte all-zero seed: deterministic for tests, never used in production
  const TEST_SEED = '0'.repeat(64);
  const config = { get: (_k: string, d?: string) => d ?? '' };

  const makeSigner = (seed: string): CommandEnvelopeSignerService =>
    new CommandEnvelopeSignerService({ get: (_k: string, _d?: string) => seed });

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

  describe('sign', () => {
    it('produces a deterministic wire envelope with 64-byte signature', () => {
      const signer = makeSigner(TEST_SEED);
      const envelope = signer.sign({
        cmd: 'write_modbus',
        params: { register: 40001, value: 1234 },
        actorUuid: '01234567-89ab-4def-8abc-0123456789ab',
        tenantUuid: 'fedcba98-7654-3210-fedc-ba9876543210',
        validitySecs: 60,
      });

      expect(envelope).not.toBeNull();
      expect(envelope!.signature).toHaveLength(64);
      expect(envelope!.cmd_hash).toHaveLength(32);
      expect(envelope!.actor).toHaveLength(16);
      expect(envelope!.tenant_id).toHaveLength(16);
      expect(envelope!.exp_unix_secs - envelope!.iat_unix_secs).toBe(60);
      expect(envelope!.co_approver_actor).toBeNull();
      expect(envelope!.co_approver_signature).toBeNull();
    });

    it('returns null when no seed is configured (unsigned deploy)', () => {
      const signer = new CommandEnvelopeSignerService(config);
      expect(
        signer.sign({
          cmd: 'ping',
          params: {},
          actorUuid: '01234567-89ab-4def-8abc-0123456789ab',
          tenantUuid: 'fedcba98-7654-3210-fedc-ba9876543210',
        }),
      ).toBeNull();
      expect(signer.isSigningEnabled).toBe(false);
    });

    it('co-approver presence byte = 1 when provided', () => {
      const signer = makeSigner(TEST_SEED);
      const envelope = signer.sign({
        cmd: 'force_value',
        params: { tag: 'pump_1', value: 42 },
        actorUuid: '01234567-89ab-4def-8abc-0123456789ab',
        tenantUuid: 'fedcba98-7654-3210-fedc-ba9876543210',
        coApproverActorUuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      });
      expect(envelope!.co_approver_actor).toHaveLength(16);
      expect(envelope!.co_approver_actor![0]).toBe(255);
    });

    it('throws on malformed UUID', () => {
      const signer = makeSigner(TEST_SEED);
      expect(() =>
        signer.sign({
          cmd: 'ping',
          params: {},
          actorUuid: 'not-a-uuid',
          tenantUuid: 'fedcba98-7654-3210-fedc-ba9876543210',
        }),
      ).toThrow(/Invalid UUID/);
    });

    it('rejects bad seed format', () => {
      expect(() => new CommandEnvelopeSignerService({ get: () => 'xyz' })).toThrow(
        /64 lowercase hex/,
      );
    });
  });
});
