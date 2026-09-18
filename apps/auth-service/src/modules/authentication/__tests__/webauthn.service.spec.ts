import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { RedisService } from '@aquaculture/backend-common/redis';

import { AuditLogService } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { Tenant, TenantStatus } from '../../tenant/entities/tenant.entity';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';
import { User } from '../entities/user.entity';
import { WebAuthnRegisterCredentialInput, WebAuthnVerifyLoginInput } from '../dto/webauthn.dto';
import { TokenService } from '../services/token.service';
import { WebAuthnService } from '../services/webauthn.service';

jest.mock('@simplewebauthn/server', () => ({
  verifyRegistrationResponse: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
}));

// ============================================================================
// Mock Helpers
// ============================================================================

const CHALLENGE = 'c2hhbGxlbmdlLXZhbHVlLWNoYWxsZW5nZQ';

const createMockUser = (overrides: Partial<User> = {}): User => {
  const user = new User();
  Object.assign(user, {
    id: 'user-uuid-1',
    email: 'user@example.com',
    tenantId: 'tenant-uuid-1',
    isActive: true,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: null,
    lastLoginIp: null,
    verifyPasswordAndSignalMigration: jest
      .fn()
      .mockResolvedValue({ matched: true, shouldMigrate: false }),
    getDisplayName: jest.fn().mockReturnValue('Test User'),
    isLocked: jest.fn().mockReturnValue(false),
    ...overrides,
  });
  return user;
};

const createMockCredential = (overrides: Partial<WebAuthnCredential> = {}): WebAuthnCredential => {
  const credential = new WebAuthnCredential();
  Object.assign(credential, {
    id: 'cred-row-1',
    userId: 'user-uuid-1',
    credentialId: 'cred-id-1',
    // COSE key bytes, base64url-encoded (what the library stores)
    publicKey: Buffer.from([0xa5, 0x01, 0x02]).toString('base64url'),
    counter: 3,
    transports: ['internal'],
    deviceName: 'Phone',
    lastUsedAt: null,
    ...overrides,
  });
  return credential;
};

const createMockTenant = (status: Tenant['status']): Tenant => {
  const tenant = new Tenant();
  tenant.id = 'tenant-uuid-1';
  tenant.status = status;
  return tenant;
};

const registrationInput = (
  overrides: Partial<WebAuthnRegisterCredentialInput> = {},
): WebAuthnRegisterCredentialInput => ({
  credentialId: 'cred-id-1',
  attestationObject: Buffer.from('attestation').toString('base64url'),
  clientDataJSON: Buffer.from('{"type":"webauthn.create"}').toString('base64url'),
  publicKeyAlgorithm: -7,
  challenge: CHALLENGE,
  currentPassword: 'correct-horse',
  deviceName: 'Phone',
  transports: ['internal'],
  ...overrides,
});

const loginInput = (
  overrides: Partial<WebAuthnVerifyLoginInput> = {},
): WebAuthnVerifyLoginInput => ({
  credentialId: 'cred-id-1',
  authenticatorData: Buffer.from('authData').toString('base64url'),
  clientDataJSON: Buffer.from('{"type":"webauthn.get"}').toString('base64url'),
  signature: Buffer.from('sig').toString('base64url'),
  challenge: CHALLENGE,
  ...overrides,
});

// ============================================================================
// Mock Setup
// ============================================================================

const mockCredentialRepository = {
  findOne: jest.fn(),
  find: jest.fn(),
  count: jest.fn(),
  create: jest.fn((x: WebAuthnCredential) => x),
  save: jest.fn(async (x: WebAuthnCredential) => x),
  remove: jest.fn(),
};

const mockUserRepository = {
  findOne: jest.fn(),
  save: jest.fn(async (x: User) => x),
};

const mockTenantRepository = {
  findOne: jest.fn(),
};

const mockRedis = {
  set: jest.fn(),
  getdel: jest.fn(),
  del: jest.fn(),
};

const mockAuditLog = { log: jest.fn().mockResolvedValue(undefined) };
const mockGenerateTokens = jest.fn().mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' });

// ============================================================================
// Tests
// ============================================================================

describe('WebAuthnService (SEC-CRITICAL-001/002 — №37-№40)', () => {
  let service: WebAuthnService;
  let user: User;

  const storedChallenge = (
    type: 'registration' | 'authentication',
    userId = 'user-uuid-1',
  ): string => JSON.stringify({ challenge: CHALLENGE, userId, type, createdAt: Date.now() });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Fresh user per test: the step-up test REPLACES verifyPassword on the
    // instance, which must not leak into the next test's shared object.
    user = createMockUser();
    mockUserRepository.findOne.mockResolvedValue(user);
    mockCredentialRepository.findOne.mockResolvedValue(null);
    mockTenantRepository.findOne.mockResolvedValue(createMockTenant(TenantStatus.ACTIVE));
    mockRedis.getdel.mockResolvedValue(storedChallenge('registration'));
    mockAuditLog.log.mockResolvedValue(undefined);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WebAuthnService,
        { provide: getRepositoryToken(WebAuthnCredential), useValue: mockCredentialRepository },
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepository },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: string): string =>
              key === 'WEBAUTHN_RP_ID' ? 'localhost' : (defaultValue ?? ''),
          },
        },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: TokenService, useValue: { generateTokens: mockGenerateTokens } },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    service = moduleRef.get(WebAuthnService);
  });

  // ── Registration: step-up (SEC-CRITICAL-002 №38a) ────────────────────────

  it('rejects registration when the password re-authentication fails', async () => {
    user.verifyPasswordAndSignalMigration = jest
      .fn()
      .mockResolvedValue({ matched: false, shouldMigrate: false });

    await expect(service.registerCredential('user-uuid-1', registrationInput())).rejects.toThrow(
      UnauthorizedException,
    );
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
    expect(mockAuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WEBAUTHN_REGISTRATION_REAUTH_FAILED',
        severity: AuditLogSeverity.WARNING,
      }),
    );
  });

  // ── Registration: atomic single-use challenge (№40) ──────────────────────

  it('rejects registration when the challenge was already consumed (GETDEL returns null)', async () => {
    mockRedis.getdel.mockResolvedValue(null);

    await expect(service.registerCredential('user-uuid-1', registrationInput())).rejects.toThrow(
      BadRequestException,
    );
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('rejects a registration challenge issued to a different user', async () => {
    mockRedis.getdel.mockResolvedValue(storedChallenge('registration', 'user-uuid-OTHER'));

    await expect(service.registerCredential('user-uuid-1', registrationInput())).rejects.toThrow(
      'Challenge does not match user',
    );
  });

  it('consumes the challenge with a single atomic GETDEL call', async () => {
    jest.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: '00000000-0000-0000-0000-000000000000',
        credential: {
          id: 'cred-id-1',
          publicKey: new Uint8Array([0x01, 0x02, 0x03]),
          counter: 0,
          transports: ['internal'],
        },
        credentialType: 'public-key',
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'http://localhost:5173',
        rpID: 'localhost',
      },
    });

    await service.registerCredential('user-uuid-1', registrationInput());

    expect(mockRedis.getdel).toHaveBeenCalledTimes(1);
    expect(mockRedis.getdel).toHaveBeenCalledWith(`webauthn:challenge:${CHALLENGE}`);
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  // ── Registration: library-derived key (SEC-CRITICAL-001 №37) ─────────────

  it('stores the COSE key derived from the attestation, never client input', async () => {
    const derivedKey = new Uint8Array([0xaa, 0xbb, 0xcc]);
    jest.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: '00000000-0000-0000-0000-000000000000',
        credential: { id: 'cred-id-1', publicKey: derivedKey, counter: 7 },
        credentialType: 'public-key',
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'http://localhost:5173',
        rpID: 'localhost',
      },
    });

    await service.registerCredential('user-uuid-1', registrationInput());

    expect(mockCredentialRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: Buffer.from(derivedKey).toString('base64url'),
        counter: 7,
        credentialId: 'cred-id-1',
      }),
    );
  });

  it('audits and rejects when attestation verification fails', async () => {
    jest.mocked(verifyRegistrationResponse).mockRejectedValue(new Error('origin mismatch'));

    await expect(service.registerCredential('user-uuid-1', registrationInput())).rejects.toThrow(
      BadRequestException,
    );
    expect(mockCredentialRepository.save).not.toHaveBeenCalled();
    expect(mockAuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WEBAUTHN_REGISTRATION_REJECTED',
        severity: AuditLogSeverity.WARNING,
      }),
    );
  });

  it('passes requireUserVerification and the RP/origin allowlist to the library', async () => {
    jest.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: false,
    });

    await expect(service.registerCredential('user-uuid-1', registrationInput())).rejects.toThrow(
      BadRequestException,
    );

    const calls = jest.mocked(verifyRegistrationResponse).mock.calls;
    const [firstCall] = calls;
    if (!firstCall) {
      throw new Error('verifyRegistrationResponse was not called');
    }
    const opts = firstCall[0];
    expect(opts.requireUserVerification).toBe(true);
    expect(opts.expectedRPID).toBe('localhost');
    expect(opts.expectedOrigin).toEqual(expect.arrayContaining(['http://localhost:5173']));
  });

  // ── Credential cap (carried over from the superseded AUDIT-HIGH-009 spec) ─

  it('refuses to issue a registration challenge beyond the per-user credential cap', async () => {
    mockCredentialRepository.count.mockResolvedValue(10);

    await expect(service.generateRegistrationChallenge('user-uuid-1')).rejects.toThrow(
      'Maximum 10 biometric credentials per user',
    );
  });

  // ── Login (№39/№40) ───────────────────────────────────────────────────────

  describe('verifyLogin', () => {
    let credential: WebAuthnCredential;

    beforeEach(() => {
      // Fresh credential per test: verifyLogin mutates counter in place,
      // which must not leak into the next test's shared object.
      credential = createMockCredential();
      mockRedis.getdel.mockResolvedValue(storedChallenge('authentication'));
      mockCredentialRepository.findOne.mockResolvedValue(credential);
      mockCredentialRepository.save.mockResolvedValue(credential);
      jest.mocked(verifyAuthenticationResponse).mockResolvedValue({
        verified: true,
        authenticationInfo: {
          credentialID: 'cred-id-1',
          newCounter: 4,
          userVerified: true,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          origin: 'http://localhost:5173',
          rpID: 'localhost',
        },
      });
    });

    it('rejects when the assertion fails library verification (UP/UV, rpIdHash, signature)', async () => {
      jest.mocked(verifyAuthenticationResponse).mockResolvedValue({
        verified: false,
        authenticationInfo: {
          credentialID: 'cred-id-1',
          newCounter: 4,
          userVerified: false,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          origin: 'http://localhost:5173',
          rpID: 'localhost',
        },
      });

      await expect(service.verifyLogin(loginInput())).rejects.toThrow(UnauthorizedException);
      expect(mockGenerateTokens).not.toHaveBeenCalled();
      expect(mockAuditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'WEBAUTHN_LOGIN_FAILED',
          severity: AuditLogSeverity.WARNING,
        }),
      );
    });

    it('rejects counter rollback with a CRITICAL audit (clone detection)', async () => {
      // stored counter = 3; assertion reports 3 (no progress) → rollback
      jest.mocked(verifyAuthenticationResponse).mockResolvedValue({
        verified: true,
        authenticationInfo: {
          credentialID: 'cred-id-1',
          newCounter: 3,
          userVerified: true,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          origin: 'http://localhost:5173',
          rpID: 'localhost',
        },
      });

      await expect(service.verifyLogin(loginInput())).rejects.toThrow(
        'Authenticator security check failed',
      );
      expect(mockAuditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'WEBAUTHN_COUNTER_ROLLBACK',
          severity: AuditLogSeverity.CRITICAL,
        }),
      );
    });

    it('blocks login when the tenant status does not allow login (SEC-CRITICAL-002 №38c)', async () => {
      mockTenantRepository.findOne.mockResolvedValue(createMockTenant(TenantStatus.SUSPENDED));

      await expect(service.verifyLogin(loginInput())).rejects.toThrow(
        'Biometric login not available',
      );
      expect(mockGenerateTokens).not.toHaveBeenCalled();
      expect(mockAuditLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'WEBAUTHN_LOGIN_TENANT_BLOCKED',
          severity: AuditLogSeverity.WARNING,
        }),
      );
    });

    it('issues tokens and advances the counter on a successful assertion', async () => {
      const result = await service.verifyLogin(loginInput(), '10.0.0.1', 'jest');

      expect(mockGenerateTokens).toHaveBeenCalledWith(user, '10.0.0.1', 'jest');
      expect(result).toEqual({ accessToken: 'at', refreshToken: 'rt' });
      expect(mockCredentialRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ counter: 4 }),
      );
    });

    it('rejects an assertion whose credential belongs to another user', async () => {
      mockCredentialRepository.findOne.mockResolvedValue(
        createMockCredential({ userId: 'user-uuid-OTHER' }),
      );

      await expect(service.verifyLogin(loginInput())).rejects.toThrow(
        'Credential does not match user',
      );
    });
  });
});
