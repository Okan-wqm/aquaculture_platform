import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { RedisService } from '@aquaculture/backend-common/redis';
import { Role } from '@aquaculture/backend-common/decorators';
import { DataSource, EntityManager } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { Tenant, TenantStatus } from '../../tenant/entities/tenant.entity';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';
import { User } from '../entities/user.entity';
import { WebAuthnRegisterCredentialInput, WebAuthnVerifyLoginInput } from '../dto/webauthn.dto';
import { TokenService, type OriginatingAccessSession } from '../services/token.service';
import { WebAuthnService } from '../services/webauthn.service';

jest.mock('@simplewebauthn/server', () => ({
  verifyRegistrationResponse: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
}));

// ============================================================================
// Mock Helpers
// ============================================================================

const CHALLENGE = 'c2hhbGxlbmdlLXZhbHVlLWNoYWxsZW5nZQ';
const origin: OriginatingAccessSession = {
  sub: 'user-uuid-1', role: Role.MODULE_USER, tenantId: 'tenant-uuid-1', jti: 'session-jti', iat: 1, exp: 4_000_000_000,
};

const createMockUser = (overrides: Partial<User> = {}): User => {
  const user = new User();
  Object.assign(user, {
    id: 'user-uuid-1',
    email: 'user@example.com',
    tenantId: 'tenant-uuid-1',
    isActive: true,
    credentialVersion: 1,
    role: Role.MODULE_USER,
    mfaLockedUntil: null,
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

const registrationResult = (): Awaited<ReturnType<typeof verifyRegistrationResponse>> => ({
  verified: true,
  registrationInfo: {
    fmt: 'none', aaguid: '00000000-0000-0000-0000-000000000000',
    credential: { id: 'cred-id-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
    credentialType: 'public-key', attestationObject: new Uint8Array(), userVerified: true,
    credentialDeviceType: 'singleDevice', credentialBackedUp: false,
    origin: 'http://localhost:5173', rpID: 'localhost',
  },
});
const authenticationResult = (newCounter: number): Awaited<ReturnType<typeof verifyAuthenticationResponse>> => ({
  verified: true,
  authenticationInfo: {
    credentialID: 'cred-id-1', newCounter, userVerified: true,
    credentialDeviceType: 'singleDevice', credentialBackedUp: false,
    origin: 'http://localhost:5173', rpID: 'localhost',
  },
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
const mockAssertOriginatingSession = jest.fn().mockResolvedValue(undefined);
const mockGenerateTokens = jest.fn().mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' });

const mockManager = new EntityManager(new DataSource({ type: 'postgres' }));
Object.defineProperty(mockManager, 'queryRunner', { value: { isTransactionActive: true } });
const mockDataSource = {
  transaction: jest.fn(async (operation: (manager: EntityManager) => Promise<unknown>) => operation(mockManager)),
};

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
    mockCredentialRepository.count.mockResolvedValue(0);
    jest.spyOn(mockManager, 'findOne').mockImplementation(async (target) => {
      if (target === User) return mockUserRepository.findOne();
      if (target === Tenant) return mockTenantRepository.findOne();
      return mockCredentialRepository.findOne();
    });
    jest.spyOn(mockManager, 'count').mockImplementation(async () => mockCredentialRepository.count());
    jest.spyOn(mockManager, 'insert').mockResolvedValue({ identifiers: [], generatedMaps: [], raw: [] });
    jest.spyOn(mockManager, 'update').mockResolvedValue({ affected: 1, generatedMaps: [], raw: [] });
    jest.spyOn(mockManager, 'delete').mockResolvedValue({ affected: 1, raw: [] });
    jest.mocked(verifyRegistrationResponse).mockResolvedValue(registrationResult());
    jest.mocked(verifyAuthenticationResponse).mockResolvedValue(authenticationResult(4));
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
        { provide: TokenService, useValue: { generateTokensInContext: mockGenerateTokens, assertOriginatingSessionInContext: mockAssertOriginatingSession } },
        { provide: DataSource, useValue: mockDataSource },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    service = moduleRef.get(WebAuthnService);
  });

  it('rejects registration when password credentials changed during attestation verification', async () => {
    jest.mocked(verifyRegistrationResponse).mockImplementationOnce(async () => {
      user.credentialVersion += 1;
      return registrationResult();
    });
    await expect(service.registerCredential(origin, registrationInput())).rejects.toThrow(ForbiddenException);
    expect(mockManager.insert).not.toHaveBeenCalled();
  });

  it('rejects login when a verified credential was removed before the User lock', async () => {
    const credential = createMockCredential();
    mockCredentialRepository.findOne.mockResolvedValue(credential);
    mockCredentialRepository.findOne.mockResolvedValueOnce(credential).mockResolvedValueOnce(null);
    jest.mocked(verifyAuthenticationResponse).mockResolvedValue(authenticationResult(4));
    mockRedis.getdel.mockResolvedValue(storedChallenge('authentication'));
    await expect(service.verifyLogin(loginInput())).rejects.toThrow(UnauthorizedException);
    expect(mockManager.update).not.toHaveBeenCalled();
    expect(mockGenerateTokens).not.toHaveBeenCalled();
  });

  it('checks the credential cap again inside registration after the ceremony', async () => {
    mockCredentialRepository.count.mockResolvedValue(10);
    await expect(service.registerCredential(origin, registrationInput())).rejects.toThrow('Maximum 10 biometric credentials per user');
    expect(verifyRegistrationResponse).toHaveBeenCalled();
    expect(mockManager.insert).not.toHaveBeenCalled();
  });

  it('allows a legitimate zero-counter authenticator without resurrecting a credential', async () => {
    mockCredentialRepository.findOne.mockResolvedValue(createMockCredential({ counter: 0 }));
    mockRedis.getdel.mockResolvedValue(storedChallenge('authentication'));
    jest.mocked(verifyAuthenticationResponse).mockResolvedValue(authenticationResult(0));
    await service.verifyLogin(loginInput());
    expect(mockManager.update).toHaveBeenCalledWith(WebAuthnCredential, expect.anything(), expect.objectContaining({ counter: 0 }));
    expect(mockCredentialRepository.save).not.toHaveBeenCalled();
    expect(mockManager.insert).not.toHaveBeenCalled();
  });

  it('rejects a nonzero counter that was advanced by another login before locking', async () => {
    const credential = createMockCredential({ counter: 3 });
    mockCredentialRepository.findOne.mockResolvedValueOnce(credential)
      .mockResolvedValueOnce(createMockCredential({ counter: 5 }));
    mockRedis.getdel.mockResolvedValue(storedChallenge('authentication'));
    jest.mocked(verifyAuthenticationResponse).mockResolvedValue(authenticationResult(4));
    await expect(service.verifyLogin(loginInput())).rejects.toThrow('Authenticator security check failed');
    expect(mockManager.update).not.toHaveBeenCalled();
    expect(mockGenerateTokens).not.toHaveBeenCalled();
  });

  it('uses the same transaction manager for successful credential and audit writes', async () => {
    await service.registerCredential(origin, registrationInput());
    expect(mockManager.insert).toHaveBeenCalledTimes(1);
    expect(mockAuditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'WEBAUTHN_CREDENTIAL_REGISTERED' }), mockManager);
    expect(mockCredentialRepository.save).not.toHaveBeenCalled();
  });

  it('rejects credential removal when its originating access session was revoked', async () => {
    mockAssertOriginatingSession.mockRejectedValueOnce(new ForbiddenException('Originating session is no longer valid'));
    await expect(service.removeCredential(origin, 'cred-id-1')).rejects.toThrow(ForbiddenException);
    expect(mockManager.delete).not.toHaveBeenCalled();
  });

  // ── Registration: step-up (SEC-CRITICAL-002 №38a) ────────────────────────

  it('rejects registration when the password re-authentication fails', async () => {
    user.verifyPasswordAndSignalMigration = jest
      .fn()
      .mockResolvedValue({ matched: false, shouldMigrate: false });

    await expect(service.registerCredential(origin, registrationInput())).rejects.toThrow(
      UnauthorizedException,
    );
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
    expect(mockAuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WEBAUTHN_REGISTRATION_REAUTH_FAILED',
        severity: AuditLogSeverity.WARNING,
      }), undefined,
    );
  });

  // ── Registration: atomic single-use challenge (№40) ──────────────────────

  it('rejects registration when the challenge was already consumed (GETDEL returns null)', async () => {
    mockRedis.getdel.mockResolvedValue(null);

    await expect(service.registerCredential(origin, registrationInput())).rejects.toThrow(
      BadRequestException,
    );
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('rejects a registration challenge issued to a different user', async () => {
    mockRedis.getdel.mockResolvedValue(storedChallenge('registration', 'user-uuid-OTHER'));

    await expect(service.registerCredential(origin, registrationInput())).rejects.toThrow(
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

    await service.registerCredential(origin, registrationInput());

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

    await service.registerCredential(origin, registrationInput());

    expect(mockManager.insert).toHaveBeenCalledWith(
      WebAuthnCredential, expect.objectContaining({
        publicKey: Buffer.from(derivedKey).toString('base64url'),
        counter: 7,
        credentialId: 'cred-id-1',
      }),
    );
  });

  it('audits and rejects when attestation verification fails', async () => {
    jest.mocked(verifyRegistrationResponse).mockRejectedValue(new Error('origin mismatch'));

    await expect(service.registerCredential(origin, registrationInput())).rejects.toThrow(
      BadRequestException,
    );
    expect(mockManager.insert).not.toHaveBeenCalled();
    expect(mockAuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WEBAUTHN_REGISTRATION_REJECTED',
        severity: AuditLogSeverity.WARNING,
      }), undefined,
    );
  });

  it('passes requireUserVerification and the RP/origin allowlist to the library', async () => {
    jest.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: false,
    });

    await expect(service.registerCredential(origin, registrationInput())).rejects.toThrow(
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
          tenantId: user.tenantId,
          severity: AuditLogSeverity.WARNING,
        }), undefined,
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
          tenantId: user.tenantId,
          severity: AuditLogSeverity.CRITICAL,
        }), mockManager,
      );
    });

    it('blocks login when the tenant status does not allow login (SEC-CRITICAL-002 №38c)', async () => {
      mockTenantRepository.findOne.mockResolvedValue(createMockTenant(TenantStatus.SUSPENDED));

      await expect(service.verifyLogin(loginInput())).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockGenerateTokens).not.toHaveBeenCalled();
      expect(mockAuditLog.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'WEBAUTHN_LOGIN_SUCCESS' }), expect.anything());
    });

    it('issues tokens and advances the counter on a successful assertion', async () => {
      const result = await service.verifyLogin(loginInput(), '10.0.0.1', 'jest');

      expect(mockGenerateTokens).toHaveBeenCalledWith(expect.objectContaining({ user, manager: mockManager }), '10.0.0.1', 'jest', { mfaVerified: true });
      expect(result).toEqual({ accessToken: 'at', refreshToken: 'rt' });
      expect(mockAuditLog.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'WEBAUTHN_LOGIN_SUCCESS', tenantId: user.tenantId,
        performedBy: user.id, entityId: user.id,
      }), mockManager);
      expect(mockManager.update).toHaveBeenCalledWith(
        WebAuthnCredential, expect.objectContaining({ id: credential.id, userId: user.id }),
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
