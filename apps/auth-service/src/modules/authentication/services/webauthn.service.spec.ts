/**
 * WebAuthnService security-ceremony unit tests (AUDIT-HIGH-009).
 *
 * Pins the NON-cryptographic security invariants of the passkey ceremony that are
 * this service's own responsibility (the signature/attestation crypto is a
 * separate integration concern): challenge issuance + single-use + TTL type/user
 * binding, RP-ID binding, the origin allowlist, the per-user credential cap, and
 * duplicate-credential rejection. A Map-backed Redis mock gives a real, in-memory
 * challenge store so the full register ceremony runs end-to-end without crypto.
 */
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RedisService } from '@aquaculture/backend-common/redis';

import { AuditLogService } from '../../../audit/audit-log.service';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';
import { User } from '../entities/user.entity';
import { TokenService } from './token.service';
import { WebAuthnService } from './webauthn.service';

const RP_ORIGIN = 'http://localhost:3000'; // in the default WEBAUTHN_ALLOWED_ORIGINS

function clientData(type: string, challenge: string, origin: string): string {
  return Buffer.from(JSON.stringify({ type, challenge, origin })).toString('base64url');
}

describe('WebAuthnService security ceremony (AUDIT-HIGH-009)', () => {
  let service: WebAuthnService;
  const userRepo = { findOne: jest.fn() };
  const credRepo = {
    findOne: jest.fn(),
    count: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
  const auditLog = { log: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Map-backed Redis so the challenge store is real + single-use is exercised,
    // and the constructor takes the Redis path (no in-memory setInterval leak).
    const store = new Map<string, string>();
    const redis = {
      get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      set: jest.fn((k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve();
      }),
      del: jest.fn((k: string) => {
        store.delete(k);
        return Promise.resolve();
      }),
      delete: jest.fn((k: string) => {
        store.delete(k);
        return Promise.resolve();
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebAuthnService,
        { provide: getRepositoryToken(WebAuthnCredential), useValue: credRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: ConfigService, useValue: { get: jest.fn((_k: string, def?: unknown) => def) } },
        { provide: AuditLogService, useValue: auditLog },
        { provide: TokenService, useValue: { generateTokens: jest.fn() } },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get(WebAuthnService);
  });

  describe('generateRegistrationChallenge', () => {
    it('rejects an unknown user', async () => {
      userRepo.findOne.mockResolvedValue(null);
      await expect(service.generateRegistrationChallenge('nobody')).rejects.toThrow(
        'User not found',
      );
    });

    it('enforces the per-user credential cap', async () => {
      userRepo.findOne.mockResolvedValue({ id: 'u1', getDisplayName: () => 'U One' });
      credRepo.count.mockResolvedValue(10);
      await expect(service.generateRegistrationChallenge('u1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('issues a challenge bound to the RP id', async () => {
      userRepo.findOne.mockResolvedValue({ id: 'u1', getDisplayName: () => 'U One' });
      credRepo.count.mockResolvedValue(0);
      const res = await service.generateRegistrationChallenge('u1');
      expect(typeof res.challenge).toBe('string');
      expect(res.challenge.length).toBeGreaterThan(20);
      expect(res.rpId).toBe('localhost'); // WEBAUTHN_RP_ID default
      expect(res.userId).toBe('u1');
    });
  });

  describe('registerCredential', () => {
    async function issueChallenge(): Promise<string> {
      userRepo.findOne.mockResolvedValue({ id: 'u1', getDisplayName: () => 'U One' });
      credRepo.count.mockResolvedValue(0);
      return (await service.generateRegistrationChallenge('u1')).challenge;
    }

    it('rejects an unknown / expired challenge', async () => {
      await expect(
        service.registerCredential('u1', {
          challenge: 'never-issued',
          credentialId: 'c1',
          clientDataJSON: clientData('webauthn.create', 'never-issued', RP_ORIGIN),
          publicKey: 'pk',
          origin: RP_ORIGIN,
        }),
      ).rejects.toThrow('Invalid or expired challenge');
    });

    it('rejects an origin that is not in the allowlist', async () => {
      const challenge = await issueChallenge();
      await expect(
        service.registerCredential('u1', {
          challenge,
          credentialId: 'c1',
          clientDataJSON: clientData('webauthn.create', challenge, 'https://evil.example'),
          publicKey: 'pk',
          origin: RP_ORIGIN,
        }),
      ).rejects.toThrow('Origin not allowed');
    });

    it('rejects a clientData type that is not webauthn.create', async () => {
      const challenge = await issueChallenge();
      await expect(
        service.registerCredential('u1', {
          challenge,
          credentialId: 'c1',
          clientDataJSON: clientData('webauthn.get', challenge, RP_ORIGIN),
          publicKey: 'pk',
          origin: RP_ORIGIN,
        }),
      ).rejects.toThrow('Invalid clientData type');
    });

    it('rejects a duplicate credential id', async () => {
      const challenge = await issueChallenge();
      credRepo.findOne.mockResolvedValue({ id: 'existing' });
      await expect(
        service.registerCredential('u1', {
          challenge,
          credentialId: 'dup',
          clientDataJSON: clientData('webauthn.create', challenge, RP_ORIGIN),
          publicKey: 'pk',
          origin: RP_ORIGIN,
        }),
      ).rejects.toThrow('Credential already registered');
    });

    it('persists a new credential and burns the challenge (single-use)', async () => {
      const challenge = await issueChallenge();
      credRepo.findOne.mockResolvedValue(null);
      credRepo.create.mockImplementation((c: Record<string, unknown>) => ({ id: 'new', ...c }));
      credRepo.save.mockResolvedValue(undefined);

      const input = {
        challenge,
        credentialId: 'c-new',
        clientDataJSON: clientData('webauthn.create', challenge, RP_ORIGIN),
        publicKey: 'pk',
        origin: RP_ORIGIN,
      };
      const res = await service.registerCredential('u1', input);

      expect(res.success).toBe(true);
      expect(credRepo.save).toHaveBeenCalledTimes(1);
      expect(credRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', credentialId: 'c-new', counter: 0 }),
      );
      // Single-use: replaying the same challenge now fails.
      await expect(service.registerCredential('u1', input)).rejects.toThrow(
        'Invalid or expired challenge',
      );
    });
  });

  describe('verifyLogin', () => {
    it('rejects an unknown / expired authentication challenge before any credential lookup', async () => {
      await expect(
        service.verifyLogin({
          challenge: 'never-issued',
          credentialId: 'c1',
          clientDataJSON: clientData('webauthn.get', 'never-issued', RP_ORIGIN),
          authenticatorData: '',
          signature: '',
          origin: RP_ORIGIN,
        }),
      ).rejects.toThrow('Invalid or expired challenge');
      expect(credRepo.findOne).not.toHaveBeenCalled();
    });
  });
});
