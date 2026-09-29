import * as crypto from 'crypto';

import { Role } from '@aquaculture/backend-common/decorators';
import { BadRequestException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { User } from '../entities/user.entity';
import { CredentialProof } from '../services/credential-proof';
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';
import { UserAccountStore } from '../services/user-account.store';
import { UserMfaStateStore } from '../services/user-mfa-state.store';
import {
  makeUserAccountStoreDouble,
  makeUserMfaStateStoreDouble,
} from './support/auth-store.doubles';

// ORPHAN-HIGH-811/812: the column-scoped writers, as London-school doubles.
const userAccountStore = makeUserAccountStoreDouble();
const mfaStateStore = makeUserMfaStateStoreDouble();

// ============================================================================
// Mock Helpers
// ============================================================================

const createMockUser = (overrides: Partial<User> = {}): User => {
  const user = new User();
  Object.assign(user, {
    id: 'user-uuid-123',
    email: 'test@example.com',
    password: '$2a$12$hashedpassword',
    firstName: 'Test',
    lastName: 'User',
    role: Role.MODULE_USER,
    tenantId: '11111111-1111-4111-8111-111111111111',
    isActive: true,
    isEmailVerified: true,
    // The database-owned anchor every proof is taken from (ORPHAN-HIGH-811).
    credentialVersion: 1,
    mfaEnabled: false,
    mfaSecret: null,
    mfaRecoveryCodes: null,
    mfaFailedAttempts: 0,
    mfaLockedUntil: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return user;
};

// ============================================================================
// Mock Setup
// ============================================================================

// The one-time TOTP consume (SEC-HIGH-001) is the store's conditional UPDATE
// (`mfaStateStore.consumeTotpStep`, true on first use, false on a replay);
// MfaService itself only reads the user row.
const mockUserRepository = {
  findOne: jest.fn(),
  save: jest.fn((user: User) => Promise.resolve(user)),
};

const mockJwtService = {
  sign: jest.fn().mockReturnValue('mock-mfa-token'),
  // SEC-LOW-001(a): a valid MFA-challenge token now carries the canonical
  // type:'mfa_challenge' discriminator; verifyMfaLogin positively requires it.
  verify: jest.fn().mockReturnValue({
    sub: 'mfa:user-uuid-123',
    type: 'mfa_challenge',
    userId: 'user-uuid-123',
    purpose: 'mfa_verification',
    jti: 'mock-jti',
  }),
};

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const config: Record<string, any> = {
      // 64-char hex key so MfaService doesn't disable itself
      MFA_ENCRYPTION_KEY: 'a'.repeat(64),
      MFA_ISSUER_NAME: 'TestApp',
      NODE_ENV: 'test',
    };
    return config[key] ?? defaultValue;
  }),
};

const mockAuditLogService = {
  log: jest.fn().mockResolvedValue(undefined),
};

// The mint and its bookkeeping run in one transaction; the manager is opaque
// to MfaService (it only hands it to the TokenService/store doubles).
const mockTransactionManager = {};
const mockDataSource = {
  transaction: jest.fn(
    <T>(work: (manager: object) => Promise<T>): Promise<T> => work(mockTransactionManager),
  ),
};

const mockTokenService = {
  generateTokens: jest.fn().mockResolvedValue({
    accessToken: 'full-access-token',
    refreshToken: 'full-refresh-token',
    user: createMockUser({ mfaEnabled: true }),
    expiresIn: 900,
    tokenType: 'Bearer',
    redirectUrl: '/tenant',
  }),
};

// ============================================================================
// Tests
// ============================================================================

/**
 * MfaService through the DI container with every collaborator doubled — no
 * casts; `config` stands in for ConfigService so availability tests can vary
 * the environment.
 */
/** The one ConfigService method MfaService reads, as a structural reader. */
interface ConfigReader {
  get(key: string, defaultValue?: unknown): unknown;
}

async function buildMfaService(config: ConfigReader): Promise<MfaService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      MfaService,
      { provide: getRepositoryToken(User), useValue: mockUserRepository },
      { provide: JwtService, useValue: mockJwtService },
      { provide: ConfigService, useValue: config },
      { provide: AuditLogService, useValue: mockAuditLogService },
      { provide: TokenService, useValue: mockTokenService },
      { provide: DataSource, useValue: mockDataSource },
      { provide: UserAccountStore, useValue: userAccountStore },
      { provide: UserMfaStateStore, useValue: mfaStateStore },
    ],
  }).compile();
  return module.get<MfaService>(MfaService);
}

describe('MfaService', () => {
  let service: MfaService;

  beforeEach(async () => {
    jest.clearAllMocks();

    service = await buildMfaService(mockConfigService);
  });

  describe('availability', () => {
    const createServiceWithConfig = (config: Record<string, string | undefined>) =>
      buildMfaService({
        get: jest.fn((key: string, defaultValue?: string) => config[key] ?? defaultValue),
      });

    it('throws during production startup when MFA_ENCRYPTION_KEY is missing', async () => {
      await expect(createServiceWithConfig({ NODE_ENV: 'production' })).rejects.toThrow(
        'MFA_ENCRYPTION_KEY',
      );
    });

    it('throws during production startup when MFA_ENCRYPTION_KEY is malformed', async () => {
      await expect(
        createServiceWithConfig({
          NODE_ENV: 'production',
          MFA_ENCRYPTION_KEY: 'not-a-hex-key',
        }),
      ).rejects.toThrow('64-character hex');
    });

    it('throws during staging startup when MFA_ENCRYPTION_KEY is malformed', async () => {
      await expect(
        createServiceWithConfig({
          NODE_ENV: 'development',
          AQUA_ENV: 'staging',
          MFA_ENCRYPTION_KEY: 'not-a-hex-key',
        }),
      ).rejects.toThrow('64-character hex');
    });

    it('disables MFA outside production when MFA_ENCRYPTION_KEY is missing', async () => {
      const unavailableService = await createServiceWithConfig({ NODE_ENV: 'test' });

      expect(unavailableService.isMfaAvailable()).toBe(false);
      expect(unavailableService.getMfaUnavailableReason()).toBe(
        'MFA_ENCRYPTION_KEY is not configured',
      );
    });

    it('derives a development-only key for malformed non-production MFA_ENCRYPTION_KEY', async () => {
      const devService = await createServiceWithConfig({
        NODE_ENV: 'development',
        MFA_ENCRYPTION_KEY: 'local-dev-key',
      });

      expect(devService.isMfaAvailable()).toBe(true);
      expect(devService.getMfaUnavailableReason()).toBeNull();
    });
  });

  // ==========================================================================
  // setupMfa
  // ==========================================================================
  describe('setupMfa', () => {
    it('should generate TOTP secret, QR code URI, and recovery codes', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);

      const result = await service.setupMfa('user-uuid-123');

      // Should return secret in base32
      expect(result.secret).toBeDefined();
      expect(result.secret).toMatch(/^[A-Z2-7]+$/); // Base32 charset

      // Should return otpauth URI
      expect(result.qrCodeUri).toBeDefined();
      expect(result.qrCodeUri).toContain('otpauth://totp/');
      expect(result.qrCodeUri).toContain('secret=');
      expect(result.qrCodeUri).toContain('issuer=TestApp');
      expect(result.qrCodeUri).toContain('test%40example.com');

      // Should return 8 recovery codes
      expect(result.recoveryCodes).toHaveLength(8);
      result.recoveryCodes.forEach((code: string) => {
        expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/); // XXXXX-XXXXX format
      });
    });

    it('should store encrypted/plain secret and hashed recovery codes in user', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);

      await service.setupMfa('user-uuid-123');

      // One column-scoped enrollment write — never a whole-User save.
      expect(mfaStateStore.beginEnrollment).toHaveBeenCalledTimes(1);
      expect(mockUserRepository.save).not.toHaveBeenCalled();
      const [userId, storedSecret, storedCodes] = mfaStateStore.beginEnrollment.mock.calls[0]!;
      expect(userId).toBe('user-uuid-123');

      // Secret should be stored (in test mode, it's plaintext base32)
      expect(storedSecret.length).toBeGreaterThan(0);

      // Recovery codes should be stored as comma-separated SHA-256 hashes
      const hashes = storedCodes.split(',');
      expect(hashes).toHaveLength(8);
      hashes.forEach((hash: string) => {
        expect(hash).toHaveLength(64); // SHA-256 hex
      });

      // MFA is not enabled until a code verifies it.
      expect(mfaStateStore.enable).not.toHaveBeenCalled();
    });

    it('should throw if MFA is already enabled', async () => {
      const user = createMockUser({ mfaEnabled: true });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.setupMfa('user-uuid-123')).rejects.toThrow(BadRequestException);
    });

    it('should throw if user not found', async () => {
      mockUserRepository.findOne.mockResolvedValue(null);

      await expect(service.setupMfa('nonexistent')).rejects.toThrow(UnauthorizedException);
    });
  });

  // ==========================================================================
  // verifyMfaSetup
  // ==========================================================================
  describe('verifyMfaSetup', () => {
    it('should enable MFA when valid TOTP code is provided', async () => {
      // We need a user with a known secret to generate a valid code
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);

      // First setup MFA to get the secret
      const setupResult = await service.setupMfa('user-uuid-123');

      // Now generate a valid TOTP code from the secret
      const secretBuffer = base32Decode(setupResult.secret);
      const validCode = generateTestTOTP(secretBuffer);

      // Reset mocks after setup
      jest.clearAllMocks();
      mockUserRepository.findOne.mockResolvedValue({
        ...user,
        mfaSecret: setupResult.secret, // In test mode, stored as plain base32
      });

      const result = await service.verifyMfaSetup('user-uuid-123', validCode);

      expect(result.success).toBe(true);
      expect(mfaStateStore.enable).toHaveBeenCalledWith('user-uuid-123');
      expect(mockUserRepository.save).not.toHaveBeenCalled();
    });

    it('should reject invalid TOTP code', async () => {
      const user = createMockUser({
        mfaSecret: 'JBSWY3DPEHPK3PXP', // Known test secret (plain, no encryption)
      });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.verifyMfaSetup('user-uuid-123', '000000')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw if MFA setup not initiated', async () => {
      const user = createMockUser({ mfaSecret: null });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.verifyMfaSetup('user-uuid-123', '123456')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ==========================================================================
  // disableMfa
  // ==========================================================================
  describe('disableMfa', () => {
    it('should throw if MFA is not enabled', async () => {
      const user = createMockUser({ mfaEnabled: false });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.disableMfa('user-uuid-123', 'password', '123456')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw if password is invalid', async () => {
      const user = createMockUser({ mfaEnabled: true, mfaSecret: 'JBSWY3DPEHPK3PXP' });
      user.validatePassword = jest.fn().mockResolvedValue(false);
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.disableMfa('user-uuid-123', 'wrong-password', '123456')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ==========================================================================
  // generateMfaChallenge
  // ==========================================================================
  describe('generateMfaChallenge', () => {
    it('should return mfaRequired=true and a signed mfaToken', () => {
      const user = createMockUser({ mfaEnabled: true });

      const result = service.generateMfaChallenge(
        CredentialProof.ofAuthenticatedPrincipal(user),
        false,
      );

      expect(result.mfaRequired).toBe(true);
      expect(result.mfaToken).toBe('mock-mfa-token');
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'mfa:user-uuid-123',
          purpose: 'mfa_verification',
          userId: 'user-uuid-123',
          // ORPHAN-LOW-135: the rememberMe choice is embedded in the signed challenge.
          rememberMe: false,
        }),
        { expiresIn: 300 },
      );
    });

    it('SEC-LOW-001(a): mints the canonical type:mfa_challenge discriminator', () => {
      const user = createMockUser({ mfaEnabled: true });

      service.generateMfaChallenge(CredentialProof.ofAuthenticatedPrincipal(user), false);

      // The `type` claim is the load-bearing discriminator that keeps the MFA
      // token from being replayed as a bearer token (enforceAccessTokenType
      // rejects type !== 'access') and that verifyMfaLogin now positively
      // requires. Use the canonical 'mfa_challenge' union member, NOT 'mfa'.
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'mfa_challenge' }),
        { expiresIn: 300 },
      );
    });
  });

  // ==========================================================================
  // verifyMfaLogin
  // ==========================================================================
  describe('verifyMfaLogin', () => {
    it('should throw if mfaToken is invalid', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('invalid token');
      });

      await expect(service.verifyMfaLogin('bad-token', '123456')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw if mfaToken has wrong purpose', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'user-uuid-123',
        purpose: 'not_mfa',
        userId: 'user-uuid-123',
      });

      await expect(service.verifyMfaLogin('wrong-purpose-token', '123456')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('SEC-LOW-001(a): rejects an access token replayed at the MFA-verify endpoint', async () => {
      // Correct purpose + sub-prefix but type:'access' — i.e. a bearer token
      // signed by the same keypair. The new positive type check must reject it
      // so a non-MFA token can never be exchanged for full auth tokens here.
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'access',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });

      await expect(service.verifyMfaLogin('access-token', '123456')).rejects.toThrow(
        UnauthorizedException,
      );
      // Must reject before any token minting.
      expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
    });

    it('SEC-LOW-001(a): rejects an MFA token missing the type claim entirely', async () => {
      // A legacy/forged token with correct purpose + sub-prefix but no type
      // claim must fail the positive type check.
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });

      await expect(service.verifyMfaLogin('typeless-token', '123456')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
    });

    it('SEC-LOW-001(a): a freshly minted mfa_challenge token round-trips through verify', async () => {
      // Round-trip: mint via generateMfaChallenge, capture the signed payload,
      // feed it back through verify so verifyMfaLogin sees the real shape and
      // proceeds to verification (here a valid TOTP code yields full tokens).
      const mintUser = createMockUser({ mfaEnabled: true });
      // ORPHAN-LOW-135: mint with rememberMe=true so the round-trip proves the
      // choice survives challenge → verify and reaches generateTokens.
      service.generateMfaChallenge(CredentialProof.ofAuthenticatedPrincipal(mintUser), true);
      const mintedPayload = mockJwtService.sign.mock.calls[0]![0];
      expect(mintedPayload.type).toBe('mfa_challenge');
      expect(mintedPayload.rememberMe).toBe(true);

      mockJwtService.verify.mockReturnValue(mintedPayload);

      const secretBase32 = 'JBSWY3DPEHPK3PXP';
      const validCode = generateTestTOTP(base32Decode(secretBase32));
      const user = createMockUser({ mfaEnabled: true, mfaSecret: secretBase32 });
      mockUserRepository.findOne.mockResolvedValue(user);

      const result = await service.verifyMfaLogin('round-trip-token', validCode, '127.0.0.1');

      expect(result.accessToken).toBe('full-access-token');
      // the rememberMe carried in the signed token reaches token issuance
      expect(mockTokenService.generateTokens).toHaveBeenCalledWith(
        expect.anything(),
        '127.0.0.1',
        undefined,
        expect.objectContaining({ mfaVerified: true, rememberMe: true }),
      );
    });

    it('should lock out after max failed attempts', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });

      const user = createMockUser({
        mfaEnabled: true,
        mfaSecret: 'JBSWY3DPEHPK3PXP',
        mfaFailedAttempts: 4, // One more and it locks
      });
      mockUserRepository.findOne.mockResolvedValue(user);
      // The database counts the attempt and locks at the threshold in one
      // statement; this is what that statement returns on the 5th failure.
      mfaStateStore.recordSecondFactorFailure.mockResolvedValueOnce({
        failedAttempts: 5,
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
      });

      await expect(service.verifyMfaLogin('valid-mfa-token', '000000')).rejects.toThrow(
        ForbiddenException,
      );

      expect(mfaStateStore.recordSecondFactorFailure).toHaveBeenCalledWith(
        'user-uuid-123',
        5,
        expect.any(Date),
      );
      const lockoutUntil = mfaStateStore.recordSecondFactorFailure.mock.calls[0]![2];
      expect(lockoutUntil.getTime()).toBeGreaterThan(Date.now());
      expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
    });

    it('a wrong code below the threshold is refused as Unauthorized, counted by the database', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });
      mockUserRepository.findOne.mockResolvedValue(
        createMockUser({ mfaEnabled: true, mfaSecret: 'JBSWY3DPEHPK3PXP' }),
      );

      await expect(service.verifyMfaLogin('valid-mfa-token', '000000')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mfaStateStore.recordSecondFactorFailure).toHaveBeenCalledTimes(1);
      expect(mockUserRepository.save).not.toHaveBeenCalled();
    });

    it('should reject if account is locked out', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });

      const user = createMockUser({
        mfaEnabled: true,
        mfaSecret: 'JBSWY3DPEHPK3PXP',
        mfaLockedUntil: new Date(Date.now() + 15 * 60 * 1000), // locked for 15 minutes
      });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.verifyMfaLogin('valid-mfa-token', '123456')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should return full auth tokens on valid TOTP code', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });

      // Setup a user with known secret
      const secretBase32 = 'JBSWY3DPEHPK3PXP';
      const secretBuffer = base32Decode(secretBase32);
      const validCode = generateTestTOTP(secretBuffer);

      const user = createMockUser({
        mfaEnabled: true,
        mfaSecret: secretBase32, // Plain in test mode (no encryption key)
        mfaFailedAttempts: 2, // Should reset on success
      });
      mockUserRepository.findOne.mockResolvedValue(user);

      const result = await service.verifyMfaLogin('valid-mfa-token', validCode, '127.0.0.1');

      expect(result.accessToken).toBe('full-access-token');
      expect(mockTokenService.generateTokens).toHaveBeenCalledWith(
        // ORPHAN-HIGH-811: fenced on the version the password step signed.
        expect.objectContaining({ userId: 'user-uuid-123', credentialVersion: 1 }),
        '127.0.0.1',
        undefined,
        // ORPHAN-LOW-135: this challenge token carries no rememberMe claim → defaults false.
        { mfaVerified: true, rememberMe: false, manager: mockTransactionManager },
      );

      // The counter reset and lastLoginAt commit in the minting transaction.
      expect(mfaStateStore.resetSecondFactorFailures).toHaveBeenCalledWith(
        mockTransactionManager,
        'user-uuid-123',
      );
      expect(userAccountStore.recordSignInCompleted).toHaveBeenCalledWith(
        mockTransactionManager,
        'user-uuid-123',
        undefined,
      );
      // The bookkeeping precedes the mint, so the principal the mint returns
      // already carries this sign-in's lastLoginAt.
      const [bookkeepingOrder] = userAccountStore.recordSignInCompleted.mock.invocationCallOrder;
      const [mintOrder] = mockTokenService.generateTokens.mock.invocationCallOrder;
      if (bookkeepingOrder === undefined || mintOrder === undefined) {
        throw new Error('expected one bookkeeping write and one mint');
      }
      expect(bookkeepingOrder).toBeLessThan(mintOrder);
      expect(mockUserRepository.save).not.toHaveBeenCalled();
    });

    it('ORPHAN-HIGH-811: a challenge whose credential moved on is refused before any code is consumed', async () => {
      // The password step proved version 1. If the account moved to 3 before
      // the second factor (a reset, a role change), this challenge can never
      // mint — so it must not burn the TOTP step or a recovery code on the way
      // to that refusal, and the user is told to sign in again.
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });
      const secretBase32 = 'JBSWY3DPEHPK3PXP';
      mockUserRepository.findOne.mockResolvedValue(
        createMockUser({ mfaEnabled: true, mfaSecret: secretBase32, credentialVersion: 3 }),
      );

      await expect(
        service.verifyMfaLogin('valid-mfa-token', generateTestTOTP(base32Decode(secretBase32))),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(mfaStateStore.consumeTotpStep).not.toHaveBeenCalled();
      expect(mfaStateStore.consumeRecoveryCode).not.toHaveBeenCalled();
      expect(mfaStateStore.recordSecondFactorFailure).not.toHaveBeenCalled();
      expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
    });

    it('ORPHAN-HIGH-811: a challenge without a signed credential version is refused before any code is consumed', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
      });
      const secretBase32 = 'JBSWY3DPEHPK3PXP';
      mockUserRepository.findOne.mockResolvedValue(
        createMockUser({ mfaEnabled: true, mfaSecret: secretBase32 }),
      );

      // An expired session (the claim predates the deploy), not a server fault.
      await expect(
        service.verifyMfaLogin('valid-mfa-token', generateTestTOTP(base32Decode(secretBase32))),
      ).rejects.toThrow(new UnauthorizedException('MFA session has expired. Please login again.'));

      expect(mfaStateStore.consumeTotpStep).not.toHaveBeenCalled();
      expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
    });

    it('SEC-HIGH-001: rejects a TOTP code REPLAYED within its validity window', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });

      const secretBase32 = 'JBSWY3DPEHPK3PXP';
      const validCode = generateTestTOTP(base32Decode(secretBase32));
      const user = createMockUser({ mfaEnabled: true, mfaSecret: secretBase32 });
      mockUserRepository.findOne.mockResolvedValue(user);

      // WHY false: the store's conditional UPDATE consumes the step on first
      // use; a replay of the SAME code computes the same step, the WHERE clause
      // (step > lastUsedTotpStep) matches no row → rejected even though the
      // code is still inside its ±window TOTP validity.
      mfaStateStore.consumeTotpStep.mockResolvedValueOnce(false);

      await expect(
        service.verifyMfaLogin('valid-mfa-token', validCode, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);

      // The replayed code must NOT mint tokens.
      expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
    });

    it('SEC-HIGH-001: verification persists the matched TOTP step (one-time consume)', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });

      const secretBase32 = 'JBSWY3DPEHPK3PXP';
      const validCode = generateTestTOTP(base32Decode(secretBase32));
      const user = createMockUser({ mfaEnabled: true, mfaSecret: secretBase32 });
      mockUserRepository.findOne.mockResolvedValue(user);

      await service.verifyMfaLogin('valid-mfa-token', validCode, '127.0.0.1');

      // The matched step (a large positive epoch/period counter) is consumed
      // through the store's monotonic conditional UPDATE (its SQL is pinned in
      // user-stores.spec.ts, its race on real Postgres).
      expect(mfaStateStore.consumeTotpStep).toHaveBeenCalledWith(
        'user-uuid-123',
        expect.any(Number),
      );
      const [consumeCall] = mfaStateStore.consumeTotpStep.mock.calls;
      expect(consumeCall?.[1]).toBeGreaterThan(50_000_000);
    });

    it('should accept recovery code and consume it', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });

      // Create a known recovery code and its hash
      const recoveryCode = 'ABCDE-FGHIJ';
      const codeHash = crypto.createHash('sha256').update(recoveryCode).digest('hex');
      const otherHash = crypto.createHash('sha256').update('ZZZZZ-ZZZZZ').digest('hex');

      const user = createMockUser({
        mfaEnabled: true,
        mfaSecret: 'JBSWY3DPEHPK3PXP',
        mfaRecoveryCodes: `${codeHash},${otherHash}`,
      });
      mockUserRepository.findOne.mockResolvedValue(user);

      const result = await service.verifyMfaLogin('valid-mfa-token', recoveryCode);

      expect(result.accessToken).toBe('full-access-token');

      // Exactly the matched hash is removed, and only while still stored.
      expect(mfaStateStore.consumeRecoveryCode).toHaveBeenCalledWith('user-uuid-123', codeHash);
      expect(mockUserRepository.save).not.toHaveBeenCalled();
    });

    it('a recovery code consumed by a concurrent request is refused (one-time use under a race)', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });
      const recoveryCode = 'ABCDE-FGHIJ';
      const codeHash = crypto.createHash('sha256').update(recoveryCode).digest('hex');
      mockUserRepository.findOne.mockResolvedValue(
        createMockUser({
          mfaEnabled: true,
          mfaSecret: 'JBSWY3DPEHPK3PXP',
          mfaRecoveryCodes: codeHash,
        }),
      );
      // The other request's compare-and-set committed first.
      mfaStateStore.consumeRecoveryCode.mockResolvedValueOnce(false);

      await expect(service.verifyMfaLogin('valid-mfa-token', recoveryCode)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
    });

    it('SEC-LOW-001(b): a corrupted stored hash does NOT throw on a non-matching code', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });

      // 'zzzz' (non-hex) and 'abc' (odd-length) both decode via
      // Buffer.from(...,'hex') to a byte length != 32. Pre-fix, timingSafeEqual
      // on such a buffer threw ERR_CRYPTO_TIMING_SAFE_EQUAL_DATA_TYPE_OR_LENGTH
      // and 500'd the verify. The length guard must skip them and return no-match
      // (here UnauthorizedException 'Invalid MFA code', NOT a 500/throw from crypto).
      const validHash = crypto.createHash('sha256').update('ABCDE-FGHIJ').digest('hex');
      const user = createMockUser({
        mfaEnabled: true,
        mfaSecret: 'JBSWY3DPEHPK3PXP',
        mfaRecoveryCodes: `zzzz,abc,${validHash}`,
      });
      mockUserRepository.findOne.mockResolvedValue(user);

      // Supply a code that matches NEITHER the valid hash nor the corrupt entries.
      await expect(service.verifyMfaLogin('valid-mfa-token', 'WRONG-CODES')).rejects.toThrow(
        UnauthorizedException,
      );
      // Crucially it must be the clean no-match path, never a crypto throw.
      expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
    });

    it('SEC-LOW-001(b): a valid code still matches when a corrupted hash is present', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
        credentialVersion: 1,
      });

      const recoveryCode = 'ABCDE-FGHIJ';
      const validHash = crypto.createHash('sha256').update(recoveryCode).digest('hex');
      const user = createMockUser({
        mfaEnabled: true,
        mfaSecret: 'JBSWY3DPEHPK3PXP',
        // Corrupt entries surrounding the valid hash must be skipped, not block it.
        mfaRecoveryCodes: `zzzz,${validHash},abc`,
      });
      mockUserRepository.findOne.mockResolvedValue(user);

      const result = await service.verifyMfaLogin('valid-mfa-token', recoveryCode);

      expect(result.accessToken).toBe('full-access-token');
    });
  });

  // ==========================================================================
  // regenerateRecoveryCodes
  // ==========================================================================
  describe('regenerateRecoveryCodes', () => {
    it('should generate new recovery codes and invalidate old ones', async () => {
      const secretBase32 = 'JBSWY3DPEHPK3PXP';
      const secretBuffer = base32Decode(secretBase32);
      const validCode = generateTestTOTP(secretBuffer);

      const user = createMockUser({
        mfaEnabled: true,
        mfaSecret: secretBase32,
        mfaRecoveryCodes: 'old-hash-1,old-hash-2',
      });
      mockUserRepository.findOne.mockResolvedValue(user);

      const result = await service.regenerateRecoveryCodes('user-uuid-123', validCode);

      expect(result.recoveryCodes).toHaveLength(8);
      result.recoveryCodes.forEach((code: string) => {
        expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      });

      // Verify old codes are replaced
      expect(mfaStateStore.replaceRecoveryCodes).toHaveBeenCalledWith(
        'user-uuid-123',
        expect.not.stringContaining('old-hash-1'),
      );
    });

    it('should reject if TOTP code is invalid', async () => {
      const user = createMockUser({
        mfaEnabled: true,
        mfaSecret: 'JBSWY3DPEHPK3PXP',
      });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.regenerateRecoveryCodes('user-uuid-123', '000000')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ==========================================================================
  // hashRecoveryCodes write-time invariant (SEC-LOW-001(b))
  // ==========================================================================
  describe('hashRecoveryCodes write-time invariant', () => {
    it('every emitted recovery-code hash is exactly 64-char lowercase hex', async () => {
      // The helper is private; assert its invariant through its only observable
      // output — the comma-separated hashes persisted by setupMfa. A SHA-256 hex
      // digest is structurally /^[0-9a-f]{64}$/, so the write path is correct by
      // construction and the regex assertion in hashRecoveryCodes guards it.
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);

      await service.setupMfa('user-uuid-123');

      const storedCodes = mfaStateStore.beginEnrollment.mock.calls[0]![2];
      const hashes = storedCodes.split(',');
      expect(hashes).toHaveLength(8);
      hashes.forEach((hash: string) => {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      });
    });

    it('throws at write time if a non-hex digest is ever produced', async () => {
      // Tier-1 make-it-impossible: force the digest output to a non-hex value to
      // prove the regex guard fails fast at write time rather than persisting a
      // corrupt hash that would later throw at verify. Stubbing digest() (not
      // casting types) exercises the exact branch a future regression would hit.
      const realDigest = crypto.Hash.prototype.digest;
      const digestSpy = jest.spyOn(crypto.Hash.prototype, 'digest').mockImplementation(function (
        this: crypto.Hash,
        encoding?: crypto.BinaryToTextEncoding,
      ): string {
        // Only corrupt the hex-string recovery-code hashing; delegate any other
        // (e.g. encryption-key derivation) digest call to the real impl.
        if (encoding === 'hex') {
          return 'not-a-valid-hex-digest';
        }
        return realDigest.call(this, encoding ?? 'hex');
      });

      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);

      try {
        await expect(service.setupMfa('user-uuid-123')).rejects.toThrow(
          '64-character lowercase hex digest',
        );
      } finally {
        digestSpy.mockRestore();
      }
    });
  });
});

// ============================================================================
// Test Helpers: TOTP generation (matches the service's implementation)
// ============================================================================

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(encoded: string): Buffer {
  const cleanInput = encoded.replace(/[=\s]/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (let i = 0; i < cleanInput.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleanInput[i]!);
    if (idx === -1) throw new Error(`Invalid base32 char: ${cleanInput[i]}`);
    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function generateTestTOTP(secret: Buffer, time?: number): string {
  const now = time ?? Math.floor(Date.now() / 1000);
  const counter = BigInt(Math.floor(now / 30));

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(counterBuffer);
  const hash = hmac.digest();

  const offset = hash[hash.length - 1]! & 0x0f;
  const binary =
    ((hash[offset]! & 0x7f) << 24) |
    ((hash[offset + 1]! & 0xff) << 16) |
    ((hash[offset + 2]! & 0xff) << 8) |
    (hash[offset + 3]! & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, '0');
}
