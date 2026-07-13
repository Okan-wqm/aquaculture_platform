 
 
 
 
 
 
 
 
 
import * as crypto from 'crypto';

import { Role } from '@aquaculture/backend-common/decorators';
import { BadRequestException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { User } from '../entities/user.entity';
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';

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
    tenantId: 'tenant-uuid-123',
    isActive: true,
    isEmailVerified: true,
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

// WHY a shared builder with a default affected=1: the one-time-use consume
// (SEC-HIGH-001) runs a conditional UPDATE via createQueryBuilder and reads
// result.affected — affected=1 means "step consumed (first use)", affected=0
// means "already consumed (replay)". Replay tests override execute to 0.
const mockTotpConsumeBuilder = {
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  execute: jest.fn().mockResolvedValue({ affected: 1 }),
};

const mockUserRepository = {
  findOne: jest.fn(),
  save: jest.fn((user: User) => Promise.resolve(user)),
  createQueryBuilder: jest.fn(() => mockTotpConsumeBuilder),
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

describe('MfaService', () => {
  let service: MfaService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MfaService,
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: TokenService, useValue: mockTokenService },
      ],
    }).compile();

    service = module.get<MfaService>(MfaService);
  });

  describe('availability', () => {
    const createServiceWithConfig = (config: Record<string, string | undefined>) =>
      new MfaService(
        mockUserRepository as any,
        mockJwtService as any,
        {
          get: jest.fn((key: string, defaultValue?: string) => config[key] ?? defaultValue),
        } as unknown as ConfigService,
        mockAuditLogService as any,
        mockTokenService as any,
      );

    it('throws during production startup when MFA_ENCRYPTION_KEY is missing', () => {
      expect(() => createServiceWithConfig({ NODE_ENV: 'production' })).toThrow('MFA_ENCRYPTION_KEY');
    });

    it('throws during production startup when MFA_ENCRYPTION_KEY is malformed', () => {
      expect(() =>
        createServiceWithConfig({
          NODE_ENV: 'production',
          MFA_ENCRYPTION_KEY: 'not-a-hex-key',
        }),
      ).toThrow('64-character hex');
    });

    it('throws during staging startup when MFA_ENCRYPTION_KEY is malformed', () => {
      expect(() =>
        createServiceWithConfig({
          NODE_ENV: 'development',
          AQUA_ENV: 'staging',
          MFA_ENCRYPTION_KEY: 'not-a-hex-key',
        }),
      ).toThrow('64-character hex');
    });

    it('disables MFA outside production when MFA_ENCRYPTION_KEY is missing', () => {
      const unavailableService = createServiceWithConfig({ NODE_ENV: 'test' });

      expect(unavailableService.isMfaAvailable()).toBe(false);
      expect(unavailableService.getMfaUnavailableReason()).toBe('MFA_ENCRYPTION_KEY is not configured');
    });

    it('derives a development-only key for malformed non-production MFA_ENCRYPTION_KEY', () => {
      const devService = createServiceWithConfig({
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

      expect(mockUserRepository.save).toHaveBeenCalledTimes(1);
      const savedUser = mockUserRepository.save.mock.calls[0]![0];

      // Secret should be stored (in test mode, it's plaintext base32)
      expect(savedUser.mfaSecret).toBeDefined();
      expect(savedUser.mfaSecret!.length).toBeGreaterThan(0);

      // Recovery codes should be stored as comma-separated SHA-256 hashes
      expect(savedUser.mfaRecoveryCodes).toBeDefined();
      const hashes = savedUser.mfaRecoveryCodes!.split(',');
      expect(hashes).toHaveLength(8);
      hashes.forEach((hash: string) => {
        expect(hash).toHaveLength(64); // SHA-256 hex
      });

      // mfaEnabled should still be false (not yet verified)
      expect(savedUser.mfaEnabled).toBe(false);
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
      expect(mockUserRepository.save).toHaveBeenCalledTimes(1);
      const savedUser = mockUserRepository.save.mock.calls[0]![0];
      expect(savedUser.mfaEnabled).toBe(true);
    });

    it('should reject invalid TOTP code', async () => {
      const user = createMockUser({
        mfaSecret: 'JBSWY3DPEHPK3PXP', // Known test secret (plain, no encryption)
      });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(
        service.verifyMfaSetup('user-uuid-123', '000000'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if MFA setup not initiated', async () => {
      const user = createMockUser({ mfaSecret: null });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(
        service.verifyMfaSetup('user-uuid-123', '123456'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ==========================================================================
  // disableMfa
  // ==========================================================================
  describe('disableMfa', () => {
    it('should throw if MFA is not enabled', async () => {
      const user = createMockUser({ mfaEnabled: false });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(
        service.disableMfa('user-uuid-123', 'password', '123456'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if password is invalid', async () => {
      const user = createMockUser({ mfaEnabled: true, mfaSecret: 'JBSWY3DPEHPK3PXP' });
      user.validatePassword = jest.fn().mockResolvedValue(false);
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(
        service.disableMfa('user-uuid-123', 'wrong-password', '123456'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ==========================================================================
  // generateMfaChallenge
  // ==========================================================================
  describe('generateMfaChallenge', () => {
    it('should return mfaRequired=true and a signed mfaToken', () => {
      const user = createMockUser({ mfaEnabled: true });

      const result = service.generateMfaChallenge(user, false);

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

      service.generateMfaChallenge(user, false);

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

      await expect(
        service.verifyMfaLogin('bad-token', '123456'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw if mfaToken has wrong purpose', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'user-uuid-123',
        purpose: 'not_mfa',
        userId: 'user-uuid-123',
      });

      await expect(
        service.verifyMfaLogin('wrong-purpose-token', '123456'),
      ).rejects.toThrow(UnauthorizedException);
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
      });

      await expect(
        service.verifyMfaLogin('access-token', '123456'),
      ).rejects.toThrow(UnauthorizedException);
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
      });

      await expect(
        service.verifyMfaLogin('typeless-token', '123456'),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
    });

    it('SEC-LOW-001(a): a freshly minted mfa_challenge token round-trips through verify', async () => {
      // Round-trip: mint via generateMfaChallenge, capture the signed payload,
      // feed it back through verify so verifyMfaLogin sees the real shape and
      // proceeds to verification (here a valid TOTP code yields full tokens).
      const mintUser = createMockUser({ mfaEnabled: true });
      // ORPHAN-LOW-135: mint with rememberMe=true so the round-trip proves the
      // choice survives challenge → verify and reaches generateTokens.
      service.generateMfaChallenge(mintUser, true);
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
      });

      const user = createMockUser({
        mfaEnabled: true,
        mfaSecret: 'JBSWY3DPEHPK3PXP',
        mfaFailedAttempts: 4, // One more and it locks
      });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(
        service.verifyMfaLogin('valid-mfa-token', '000000'),
      ).rejects.toThrow(ForbiddenException);

      const savedUser = mockUserRepository.save.mock.calls[0]![0];
      expect(savedUser.mfaLockedUntil).toBeInstanceOf(Date);
      expect((savedUser.mfaLockedUntil as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it('should reject if account is locked out', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
      });

      const user = createMockUser({
        mfaEnabled: true,
        mfaSecret: 'JBSWY3DPEHPK3PXP',
        mfaLockedUntil: new Date(Date.now() + 15 * 60 * 1000), // locked for 15 minutes
      });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(
        service.verifyMfaLogin('valid-mfa-token', '123456'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return full auth tokens on valid TOTP code', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
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
        expect.objectContaining({ id: 'user-uuid-123' }),
        '127.0.0.1',
        undefined,
        // ORPHAN-LOW-135: this challenge token carries no rememberMe claim → defaults false.
        { mfaVerified: true, rememberMe: false },
      );

      // Failed attempts should be reset
      const savedUser = mockUserRepository.save.mock.calls[0]![0];
      expect(savedUser.mfaFailedAttempts).toBe(0);
      expect(savedUser.mfaLockedUntil).toBeNull();
    });

    it('SEC-HIGH-001: rejects a TOTP code REPLAYED within its validity window', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
      });

      const secretBase32 = 'JBSWY3DPEHPK3PXP';
      const validCode = generateTestTOTP(base32Decode(secretBase32));
      const user = createMockUser({ mfaEnabled: true, mfaSecret: secretBase32 });
      mockUserRepository.findOne.mockResolvedValue(user);

      // WHY affected=0: the conditional UPDATE consumes the step on first use;
      // a replay of the SAME code computes the same step, the WHERE clause
      // (step > lastUsedTotpStep) matches no row, affected=0 → rejected even
      // though the code is still inside its ±window TOTP validity.
      mockTotpConsumeBuilder.execute.mockResolvedValueOnce({ affected: 0 });

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
      });

      const secretBase32 = 'JBSWY3DPEHPK3PXP';
      const validCode = generateTestTOTP(base32Decode(secretBase32));
      const user = createMockUser({ mfaEnabled: true, mfaSecret: secretBase32 });
      mockUserRepository.findOne.mockResolvedValue(user);

      await service.verifyMfaLogin('valid-mfa-token', validCode, '127.0.0.1');

      // The consume UPDATE must have set lastUsedTotpStep to the matched step
      // (a large positive epoch/period counter) and guarded with the
      // monotonic WHERE clause.
      expect(mockTotpConsumeBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastUsedTotpStep: expect.any(String) }),
      );
      expect(mockTotpConsumeBuilder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('lastUsedTotpStep'),
        expect.objectContaining({ step: expect.any(String) }),
      );
    });

    it('should accept recovery code and consume it', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
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

      // Recovery code should be consumed — only otherHash should remain
      // save is called twice: once by verifyAndConsumeRecoveryCode, once by verifyMfaLogin
      const lastSave = mockUserRepository.save.mock.calls;
      const codeConsumedSave = lastSave.find(
        (call: any) => call[0].mfaRecoveryCodes === otherHash,
      );
      expect(codeConsumedSave).toBeDefined();
    });

    it('SEC-LOW-001(b): a corrupted stored hash does NOT throw on a non-matching code', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        userId: 'user-uuid-123',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
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
      await expect(
        service.verifyMfaLogin('valid-mfa-token', 'WRONG-CODES'),
      ).rejects.toThrow(UnauthorizedException);
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
  // verifyStepUp — ADR-042: mints through the generateTokens chokepoint, so the
  // tenant session-timeout clamp is applied automatically (no policy threaded).
  // ==========================================================================
  describe('verifyStepUp', () => {
    it('mints an elevated token through generateTokens (clamp resolved inside the chokepoint)', async () => {
      const secretBase32 = 'JBSWY3DPEHPK3PXP';
      const validCode = generateTestTOTP(base32Decode(secretBase32));
      const user = createMockUser({ mfaEnabled: true, mfaSecret: secretBase32 });
      mockUserRepository.findOne.mockResolvedValue(user);

      const result = await service.verifyStepUp('user-uuid-123', validCode, '127.0.0.1');

      expect(result.accessToken).toBe('full-access-token');
      // Routes through the single mint chokepoint with mfaVerified. No
      // sessionTimeoutMinutes is threaded — the clamp is resolved INSIDE
      // generateTokens from the user's tenant, so the step-up mint is clamped
      // like every other path.
      expect(mockTokenService.generateTokens).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-uuid-123' }),
        '127.0.0.1',
        undefined,
        { mfaVerified: true },
      );
    });

    it('rejects an invalid step-up code without minting', async () => {
      const user = createMockUser({ mfaEnabled: true, mfaSecret: 'JBSWY3DPEHPK3PXP' });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(
        service.verifyStepUp('user-uuid-123', '000000', '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
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
      const savedUser = mockUserRepository.save.mock.calls[0]![0];
      expect(savedUser.mfaRecoveryCodes).not.toContain('old-hash-1');
    });

    it('should reject if TOTP code is invalid', async () => {
      const user = createMockUser({
        mfaEnabled: true,
        mfaSecret: 'JBSWY3DPEHPK3PXP',
      });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(
        service.regenerateRecoveryCodes('user-uuid-123', '000000'),
      ).rejects.toThrow(BadRequestException);
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

      const savedUser = mockUserRepository.save.mock.calls[0]![0];
      const hashes = savedUser.mfaRecoveryCodes!.split(',');
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
      const digestSpy = jest
        .spyOn(crypto.Hash.prototype, 'digest')
        .mockImplementation(function (
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
