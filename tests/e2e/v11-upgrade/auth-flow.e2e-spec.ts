/**
 * Auth-Service NestJS v11 Upgrade E2E Validation
 *
 * Validates auth-service functionality during the NestJS v11 upgrade.
 * Tests are designed to pass on v10 as baseline and catch regressions
 * introduced by v11 (Express v5, path-to-regexp v8, etc.).
 *
 * Covers:
 *   1. JWT Authentication Flow (login, validate, refresh, logout, revoke)
 *   2. Cross-Version JWT Compatibility (v10 -> v11 claim preservation)
 *   3. Passport Strategy Verification (JWT guard, local auth)
 *   4. GDPR Consent Resolver req.ip Handling (proxy trust, graceful fallback)
 *
 * Run:
 *   npx jest tests/e2e/v11-upgrade/auth-flow.e2e-spec.ts \
 *     --config tests/e2e/v11-upgrade/jest.config.ts
 */
import * as crypto from 'crypto';

import { UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtModule } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Reflector } from '@nestjs/core';
import { Role, IS_PUBLIC_KEY } from '@aquaculture/backend-common/decorators';
import {
  TimingSafeService,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
} from '@aquaculture/backend-common/security';
import { DataSource, Repository } from 'typeorm';

import { AuditLogService } from '../../../apps/auth-service/src/audit/audit-log.service';
import { SECURITY_CONSTANTS } from '../../../apps/auth-service/src/constants/auth.constants';
import { AuthenticationService } from '../../../apps/auth-service/src/modules/authentication/services/authentication.service';
import {
  TokenService,
  JwtPayload,
  parseExpiresIn,
} from '../../../apps/auth-service/src/modules/authentication/services/token.service';
import { MfaService } from '../../../apps/auth-service/src/modules/authentication/services/mfa.service';
import { JwtAuthGuard } from '../../../apps/auth-service/src/modules/authentication/guards/jwt-auth.guard';
import { User } from '../../../apps/auth-service/src/modules/authentication/entities/user.entity';
import { RefreshToken } from '../../../apps/auth-service/src/modules/authentication/entities/refresh-token.entity';
import { Invitation } from '../../../apps/auth-service/src/modules/authentication/entities/invitation.entity';
import { UserModuleAssignment } from '../../../apps/auth-service/src/modules/authentication/entities/user-module-assignment.entity';
import { Tenant } from '../../../apps/auth-service/src/modules/tenant/entities/tenant.entity';
import { UserConsentResolver } from '../../../apps/auth-service/src/modules/gdpr/resolvers/user-consent.resolver';
import { UserConsentService } from '../../../apps/auth-service/src/modules/gdpr/services/user-consent.service';

// ============================================================================
// Type Definitions
// ============================================================================

/** Mock repository interface for TypeORM Repository<T> */
interface MockRepository<T> {
  findOne: jest.Mock;
  find: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  createQueryBuilder: jest.Mock;
  manager: { query: jest.Mock };
}

/** Config map with string keys and typed values */
interface ConfigMap {
  [key: string]: string | number | boolean;
}

/** GraphQL request shape for GDPR resolver tests */
interface MockGraphQLRequest {
  ip?: string;
  headers?: {
    'user-agent'?: string;
    'x-forwarded-for'?: string;
  };
  connection?: {
    remoteAddress?: string;
  };
}

/** Token blacklist mock interface matching ITokenBlacklist */
interface MockTokenBlacklist {
  add: jest.Mock;
  isBlacklisted: jest.Mock;
  isValidToken: jest.Mock;
  isUserBlacklisted: jest.Mock;
  blacklistUserTokens: jest.Mock;
}

/** Session manager mock interface matching ISessionManager */
interface MockSessionManager {
  createSession: jest.Mock;
  revokeAllSessions: jest.Mock;
  enforceSessionLimit: jest.Mock;
}

/**
 * Simplified HTTP request mock for JwtAuthGuard tests.
 * Avoids Partial<Request> type conflicts with Express v5 Headers class.
 */
interface MockHttpRequest {
  headers: Record<string, string>;
  user?: JwtPayload;
}

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_JWT_SECRET = 'e2e-test-jwt-secret-key-at-least-32-chars-long';
const TEST_JWT_AUDIENCE = 'aquaculture-platform-e2e';

const TEST_CONFIG: ConfigMap = {
  JWT_SECRET: TEST_JWT_SECRET,
  JWT_EXPIRES_IN: '15m',
  JWT_AUDIENCE: TEST_JWT_AUDIENCE,
  MIN_LOGIN_DURATION_MS: 0,
  MAX_FAILED_ATTEMPTS: 5,
  LOCKOUT_DURATION_MINUTES: 30,
  REFRESH_TOKEN_EXPIRY_DAYS: 7,
  MAX_SESSIONS_PER_USER: 5,
  HASH_REFRESH_TOKENS: false,
  NODE_ENV: 'test',
  REGISTRATION_ENABLED: 'true',
};

/**
 * Create a properly typed mock User entity with bcrypt-hashed password.
 */
function createMockUser(overrides: Partial<User> = {}): User {
  const user = new User();
  Object.assign(user, {
    id: crypto.randomUUID(),
    email: 'testuser@aquaculture.io',
    // Pre-hashed password for 'TestPassword123!'
    // bcrypt hash of 'TestPassword123!' with 12 rounds
    password: '$2a$12$LJ3m4ys4Fp1JWeQEQTlGJeFwXhLVFrPJJC.ybGHN8x0yIlBpN0aPC',
    firstName: 'Test',
    lastName: 'User',
    role: Role.TENANT_ADMIN,
    tenantId: crypto.randomUUID(),
    isActive: true,
    isEmailVerified: true,
    failedLoginAttempts: 0,
    lockedUntil: null,
    mfaEnabled: false,
    mfaSecret: null,
    mfaRecoveryCodes: null,
    mfaFailedAttempts: 0,
    mfaLockedUntil: null,
    lastLoginAt: null,
    lastLoginIp: null,
    invitationToken: null,
    invitationExpiresAt: null,
    passwordResetToken: null,
    passwordResetExpires: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  // Bind entity methods (TypeORM entities are plain objects when mocked)
  user.validatePassword = User.prototype.validatePassword.bind(user);
  user.isLocked = User.prototype.isLocked.bind(user);
  user.isPendingInvitation = User.prototype.isPendingInvitation.bind(user);
  user.isInvitationExpired = User.prototype.isInvitationExpired.bind(user);
  user.isSuperAdmin = User.prototype.isSuperAdmin.bind(user);
  user.isTenantAdmin = User.prototype.isTenantAdmin.bind(user);
  user.hasRoleOrHigher = User.prototype.hasRoleOrHigher.bind(user);
  user.getDisplayName = User.prototype.getDisplayName.bind(user);
  return user;
}

function createMockRepository<T>(): MockRepository<T> {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
    manager: { query: jest.fn() },
  };
}

function createMockConfigService(config: ConfigMap = TEST_CONFIG): { get: jest.Mock } {
  return {
    get: jest.fn((key: string, defaultValue?: string | number | boolean) => {
      return key in config ? config[key] : defaultValue;
    }),
  };
}

function createMockTokenBlacklist(): MockTokenBlacklist {
  return {
    add: jest.fn().mockResolvedValue(undefined),
    isBlacklisted: jest.fn().mockResolvedValue(false),
    isValidToken: jest.fn().mockResolvedValue(true),
    isUserBlacklisted: jest.fn().mockResolvedValue(false),
    blacklistUserTokens: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockSessionManager(): MockSessionManager {
  return {
    createSession: jest.fn().mockResolvedValue(undefined),
    revokeAllSessions: jest.fn().mockResolvedValue(undefined),
    enforceSessionLimit: jest.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// 1. JWT Authentication Flow
// ============================================================================

describe('JWT Authentication Flow (v11 upgrade)', () => {
  let authService: AuthenticationService;
  let tokenService: TokenService;
  let jwtService: JwtService;
  let userRepo: MockRepository<User>;
  let refreshTokenRepo: MockRepository<RefreshToken>;
  let tokenBlacklist: MockTokenBlacklist;
  let sessionManager: MockSessionManager;
  let mockDataSource: { transaction: jest.Mock; query: jest.Mock };

  beforeEach(async () => {
    userRepo = createMockRepository<User>();
    refreshTokenRepo = createMockRepository<RefreshToken>();
    tokenBlacklist = createMockTokenBlacklist();
    sessionManager = createMockSessionManager();
    mockDataSource = {
      transaction: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '15m', audience: TEST_JWT_AUDIENCE },
        }),
      ],
      providers: [
        TokenService,
        MfaService,
        AuthenticationService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokenRepo },
        { provide: getRepositoryToken(Invitation), useValue: createMockRepository<Invitation>() },
        {
          provide: getRepositoryToken(UserModuleAssignment),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: getRepositoryToken(Tenant), useValue: createMockRepository<Tenant>() },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ConfigService, useValue: createMockConfigService() },
        { provide: 'EVENT_BUS', useValue: { publish: jest.fn().mockResolvedValue(undefined) } },
        { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: TimingSafeService,
          useValue: { ensureMinDuration: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: SESSION_MANAGER, useValue: sessionManager },
        { provide: TOKEN_BLACKLIST, useValue: tokenBlacklist },
      ],
    }).compile();

    authService = module.get<AuthenticationService>(AuthenticationService);
    tokenService = module.get<TokenService>(TokenService);
    jwtService = module.get<JwtService>(JwtService);
  });

  describe('Login with valid credentials -> receive access + refresh tokens', () => {
    it('should return accessToken, refreshToken, user, and tokenType on successful login', async () => {
      const testUser = createMockUser();
      // Mock bcrypt.compare to return true for valid password
      testUser.validatePassword = jest.fn().mockResolvedValue(true);

      userRepo.findOne.mockResolvedValue(testUser);
      userRepo.save.mockResolvedValue(testUser);
      refreshTokenRepo.create.mockImplementation((data: Partial<RefreshToken>) => data);
      refreshTokenRepo.save.mockImplementation((data: Partial<RefreshToken>) =>
        Promise.resolve({ id: crypto.randomUUID(), ...data }),
      );

      const result = await authService.login(
        { email: testUser.email, password: 'TestPassword123!' },
        '192.168.1.1',
        'jest-e2e-agent',
      );

      expect(result.accessToken).toBeTruthy();
      expect(typeof result.accessToken).toBe('string');
      expect(result.refreshToken).toBeTruthy();
      expect(typeof result.refreshToken).toBe('string');
      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBeGreaterThan(0);
      expect(result.user.id).toBe(testUser.id);
      expect(result.user.email).toBe(testUser.email);
      expect(result.redirectUrl).toBeTruthy();
    });

    it('should generate a JWT with correct claims structure', async () => {
      const testUser = createMockUser({
        role: Role.TENANT_ADMIN,
        tenantId: 'tenant-abc-123',
      });
      testUser.validatePassword = jest.fn().mockResolvedValue(true);

      userRepo.findOne.mockResolvedValue(testUser);
      userRepo.save.mockResolvedValue(testUser);
      refreshTokenRepo.create.mockImplementation((data: Partial<RefreshToken>) => data);
      refreshTokenRepo.save.mockImplementation((data: Partial<RefreshToken>) =>
        Promise.resolve({ id: crypto.randomUUID(), ...data }),
      );

      const result = await authService.login(
        { email: testUser.email, password: 'TestPassword123!' },
        '10.0.0.1',
      );

      // Decode and verify the JWT payload
      const decoded = jwtService.decode(result.accessToken) as JwtPayload;

      expect(decoded.sub).toBe(testUser.id);
      expect(decoded.email).toBe(testUser.email);
      expect(decoded.role).toBe(Role.TENANT_ADMIN);
      expect(decoded.roles).toEqual([Role.TENANT_ADMIN]);
      expect(decoded.tenantId).toBe('tenant-abc-123');
      expect(decoded.jti).toBeTruthy();
      expect(decoded.iat).toBeDefined();
      expect(decoded.exp).toBeDefined();
      expect(decoded.exp!).toBeGreaterThan(decoded.iat!);
    });
  });

  describe('Validate access token -> 200 OK with user payload', () => {
    it('should validate a freshly issued token and return user payload', async () => {
      const testUser = createMockUser();
      testUser.validatePassword = jest.fn().mockResolvedValue(true);

      userRepo.findOne.mockResolvedValue(testUser);
      userRepo.save.mockResolvedValue(testUser);
      refreshTokenRepo.create.mockImplementation((data: Partial<RefreshToken>) => data);
      refreshTokenRepo.save.mockImplementation((data: Partial<RefreshToken>) =>
        Promise.resolve({ id: crypto.randomUUID(), ...data }),
      );

      const loginResult = await authService.login({
        email: testUser.email,
        password: 'TestPassword123!',
      });

      const validation = await authService.validateToken(loginResult.accessToken);

      expect(validation.valid).toBe(true);
      expect(validation.payload).toBeDefined();
      expect(validation.payload!.sub).toBe(testUser.id);
      expect(validation.payload!.email).toBe(testUser.email);
      expect(validation.payload!.role).toBe(testUser.role);
      expect(validation.payload!.tenantId).toBe(testUser.tenantId);
    });

    it('should reject a tampered token', async () => {
      const testUser = createMockUser();
      testUser.validatePassword = jest.fn().mockResolvedValue(true);

      userRepo.findOne.mockResolvedValue(testUser);
      userRepo.save.mockResolvedValue(testUser);
      refreshTokenRepo.create.mockImplementation((data: Partial<RefreshToken>) => data);
      refreshTokenRepo.save.mockImplementation((data: Partial<RefreshToken>) =>
        Promise.resolve({ id: crypto.randomUUID(), ...data }),
      );

      const loginResult = await authService.login({
        email: testUser.email,
        password: 'TestPassword123!',
      });

      // Tamper with the token by changing a character in the signature
      const parts = loginResult.accessToken.split('.');
      const tamperedSignature = parts[2]!.slice(0, -2) + 'XX';
      const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSignature}`;

      const validation = await authService.validateToken(tamperedToken);
      expect(validation.valid).toBe(false);
      expect(validation.payload).toBeUndefined();
    });

    it('should reject an expired token', async () => {
      // Sign a token that expires immediately
      const expiredPayload: JwtPayload = {
        sub: crypto.randomUUID(),
        email: 'expired@test.com',
        role: Role.MODULE_USER,
        roles: [Role.MODULE_USER],
        tenantId: null,
        type: 'access',
        jti: crypto.randomUUID(),
      };

      const expiredToken = await jwtService.signAsync(expiredPayload, {
        expiresIn: '0s',
      });

      // Wait a tick for expiration
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const validation = await authService.validateToken(expiredToken);
      expect(validation.valid).toBe(false);
    });
  });

  describe('Refresh token -> receive new access token', () => {
    it('should issue a new access token with valid refresh token (unhashed mode)', async () => {
      const testUser = createMockUser();
      const storedRefreshToken: Partial<RefreshToken> = {
        id: crypto.randomUUID(),
        token: 'valid-refresh-token-hex',
        userId: testUser.id,
        tenantId: testUser.tenantId ?? null,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        ipAddress: '192.168.1.1',
        userAgent: 'jest-e2e',
        createdAt: new Date(),
      };

      // Mock transaction flow for unhashed refresh
      mockDataSource.transaction.mockImplementation(
        async <T>(
          fn: (manager: {
            getRepository: (entity: { name: string }) => {
              createQueryBuilder: jest.Mock;
              save: jest.Mock;
              findOne: jest.Mock;
            };
          }) => Promise<T>,
        ): Promise<T> => {
          const mockQueryBuilder = {
            setLock: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(storedRefreshToken),
          };

          const mockManager = {
            getRepository: (entity: { name: string }) => {
              if (entity.name === 'RefreshToken' || entity === RefreshToken) {
                return {
                  createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
                  save: jest.fn().mockResolvedValue(storedRefreshToken),
                  findOne: jest.fn(),
                };
              }
              // User repository
              return {
                createQueryBuilder: jest.fn(),
                save: jest.fn(),
                findOne: jest.fn().mockResolvedValue(testUser),
              };
            },
          };

          // generateTokens is called inside the transaction callback result
          refreshTokenRepo.create.mockImplementation((data: Partial<RefreshToken>) => data);
          refreshTokenRepo.save.mockImplementation((data: Partial<RefreshToken>) =>
            Promise.resolve({ id: crypto.randomUUID(), ...data }),
          );

          return fn(mockManager);
        },
      );

      const result = await authService.refreshToken('valid-refresh-token-hex');

      expect(result.accessToken).toBeTruthy();
      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBeGreaterThan(0);
      expect(result.user.id).toBe(testUser.id);
    });

    it('should reject a revoked refresh token', async () => {
      mockDataSource.transaction.mockImplementation(
        async <T>(
          fn: (manager: {
            getRepository: (entity: { name: string }) => {
              createQueryBuilder: jest.Mock;
            };
          }) => Promise<T>,
        ): Promise<T> => {
          const mockQueryBuilder = {
            setLock: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(null), // No valid token found
          };

          const mockManager = {
            getRepository: () => ({
              createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
            }),
          };

          return fn(mockManager);
        },
      );

      await expect(authService.refreshToken('revoked-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('Logout -> invalidate tokens', () => {
    it('should revoke all refresh tokens and blacklist access token on logout', async () => {
      const userId = crypto.randomUUID();
      const jti = crypto.randomUUID();
      const expiry = new Date(Date.now() + 15 * 60 * 1000);

      refreshTokenRepo.update.mockResolvedValue({ affected: 2 });

      const result = await authService.logout(userId, jti, expiry);

      expect(result).toBe(true);
      expect(refreshTokenRepo.update).toHaveBeenCalledWith(
        { userId, isRevoked: false },
        expect.objectContaining({
          isRevoked: true,
          revokedReason: 'User logged out',
        }),
      );
      expect(tokenBlacklist.add).toHaveBeenCalledWith(jti, expiry, 'user_logout');
      expect(sessionManager.revokeAllSessions).toHaveBeenCalledWith(userId);
    });

    it('should handle logout gracefully when no jti is provided', async () => {
      const userId = crypto.randomUUID();

      refreshTokenRepo.update.mockResolvedValue({ affected: 1 });

      const result = await authService.logout(userId);

      expect(result).toBe(true);
      expect(refreshTokenRepo.update).toHaveBeenCalled();
      // Token blacklist should NOT be called without jti
      expect(tokenBlacklist.add).not.toHaveBeenCalled();
    });
  });

  describe('Use invalidated token -> 401 Unauthorized', () => {
    it('should reject a blacklisted token during validation', async () => {
      const testUser = createMockUser();
      testUser.validatePassword = jest.fn().mockResolvedValue(true);

      userRepo.findOne.mockResolvedValue(testUser);
      userRepo.save.mockResolvedValue(testUser);
      refreshTokenRepo.create.mockImplementation((data: Partial<RefreshToken>) => data);
      refreshTokenRepo.save.mockImplementation((data: Partial<RefreshToken>) =>
        Promise.resolve({ id: crypto.randomUUID(), ...data }),
      );

      const loginResult = await authService.login({
        email: testUser.email,
        password: 'TestPassword123!',
      });

      // Decode to get jti
      const decoded = jwtService.decode(loginResult.accessToken) as JwtPayload;

      // Simulate blacklisting
      tokenBlacklist.isBlacklisted.mockResolvedValue(true);

      const validation = await authService.validateToken(loginResult.accessToken);
      expect(validation.valid).toBe(false);

      // Verify the blacklist was checked
      expect(tokenBlacklist.isBlacklisted).toHaveBeenCalledWith(decoded.jti);
    });

    it('should reject a user-level blacklisted token', async () => {
      const testUser = createMockUser();
      testUser.validatePassword = jest.fn().mockResolvedValue(true);

      userRepo.findOne.mockResolvedValue(testUser);
      userRepo.save.mockResolvedValue(testUser);
      refreshTokenRepo.create.mockImplementation((data: Partial<RefreshToken>) => data);
      refreshTokenRepo.save.mockImplementation((data: Partial<RefreshToken>) =>
        Promise.resolve({ id: crypto.randomUUID(), ...data }),
      );

      const loginResult = await authService.login({
        email: testUser.email,
        password: 'TestPassword123!',
      });

      // Per-JTI blacklist returns false, but user-level blacklist returns true
      tokenBlacklist.isBlacklisted.mockResolvedValue(false);
      tokenBlacklist.isUserBlacklisted.mockResolvedValue(true);

      const validation = await authService.validateToken(loginResult.accessToken);
      expect(validation.valid).toBe(false);
    });
  });
});

// ============================================================================
// 2. Cross-Version JWT Compatibility
// ============================================================================

describe('Cross-Version JWT Compatibility (v10 <-> v11)', () => {
  let jwtService: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '1h', audience: TEST_JWT_AUDIENCE },
        }),
      ],
    }).compile();

    jwtService = module.get<JwtService>(JwtService);
  });

  it('should preserve all standard JWT claims through sign/verify cycle', async () => {
    const originalPayload: JwtPayload = {
      sub: crypto.randomUUID(),
      email: 'crossversion@aquaculture.io',
      role: Role.TENANT_ADMIN,
      roles: [Role.TENANT_ADMIN],
      tenantId: crypto.randomUUID(),
      modules: ['sensor', 'farm', 'hydroponics'],
      resourcePermissions: ['read:sensor', 'write:farm'],
      firstName: 'Cross',
      lastName: 'Version',
      type: 'access',
      jti: crypto.randomUUID(),
    };

    // Simulate v10 signing
    const token = await jwtService.signAsync(originalPayload, {
      audience: TEST_JWT_AUDIENCE,
    });

    // Simulate v11 verification
    const verified = await jwtService.verifyAsync<JwtPayload>(token, {
      audience: TEST_JWT_AUDIENCE,
    });

    // Assert all claims are preserved
    expect(verified.sub).toBe(originalPayload.sub);
    expect(verified.email).toBe(originalPayload.email);
    expect(verified.role).toBe(originalPayload.role);
    expect(verified.roles).toEqual(originalPayload.roles);
    expect(verified.tenantId).toBe(originalPayload.tenantId);
    expect(verified.modules).toEqual(originalPayload.modules);
    expect(verified.resourcePermissions).toEqual(originalPayload.resourcePermissions);
    expect(verified.firstName).toBe(originalPayload.firstName);
    expect(verified.lastName).toBe(originalPayload.lastName);
    expect(verified.type).toBe('access');
    expect(verified.jti).toBe(originalPayload.jti);
  });

  it('should preserve iat and exp claims with correct temporal ordering', async () => {
    const payload: JwtPayload = {
      sub: crypto.randomUUID(),
      email: 'temporal@aquaculture.io',
      role: Role.MODULE_USER,
      roles: [Role.MODULE_USER],
      tenantId: crypto.randomUUID(),
      type: 'access',
      jti: crypto.randomUUID(),
    };

    const beforeSign = Math.floor(Date.now() / 1000);
    const token = await jwtService.signAsync(payload);
    const afterSign = Math.floor(Date.now() / 1000);

    const decoded = jwtService.decode(token) as JwtPayload;

    // iat should be within the signing window
    expect(decoded.iat).toBeDefined();
    expect(decoded.iat!).toBeGreaterThanOrEqual(beforeSign);
    expect(decoded.iat!).toBeLessThanOrEqual(afterSign);

    // exp should be iat + 3600 (1h)
    expect(decoded.exp).toBeDefined();
    expect(decoded.exp!).toBe(decoded.iat! + 3600);

    // Temporal ordering: iat < exp
    expect(decoded.exp!).toBeGreaterThan(decoded.iat!);
  });

  it('should handle null tenantId (SUPER_ADMIN case)', async () => {
    const superAdminPayload: JwtPayload = {
      sub: crypto.randomUUID(),
      email: 'superadmin@aquaculture.io',
      role: Role.SUPER_ADMIN,
      roles: [Role.SUPER_ADMIN],
      tenantId: null,
      type: 'access',
      jti: crypto.randomUUID(),
    };

    const token = await jwtService.signAsync(superAdminPayload);
    const verified = await jwtService.verifyAsync<JwtPayload>(token);

    // null should be preserved (not turned into undefined or string "null")
    expect(verified.tenantId).toBeNull();
    expect(verified.role).toBe(Role.SUPER_ADMIN);
  });

  it('should handle optional fields being undefined vs absent', async () => {
    const minimalPayload: JwtPayload = {
      sub: crypto.randomUUID(),
      email: 'minimal@aquaculture.io',
      role: Role.MODULE_USER,
      roles: [Role.MODULE_USER],
      tenantId: crypto.randomUUID(),
      type: 'access',
    };

    const token = await jwtService.signAsync(minimalPayload);
    const verified = await jwtService.verifyAsync<JwtPayload>(token);

    // Optional fields should not appear in the verified payload
    expect(verified.modules).toBeUndefined();
    expect(verified.resourcePermissions).toBeUndefined();
    expect(verified.firstName).toBeUndefined();
    expect(verified.lastName).toBeUndefined();
    // jti is not set in the payload, so it should be undefined
    expect(verified.jti).toBeUndefined();
  });

  it('should reject tokens signed with a different secret', async () => {
    const payload: JwtPayload = {
      sub: crypto.randomUUID(),
      email: 'wrongsecret@aquaculture.io',
      role: Role.MODULE_USER,
      roles: [Role.MODULE_USER],
      tenantId: null,
      type: 'access',
    };

    // Create a separate JwtService with a different secret
    const otherModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: 'completely-different-secret-key-for-another-service-12345',
          signOptions: { expiresIn: '1h' },
        }),
      ],
    }).compile();

    const otherJwtService = otherModule.get<JwtService>(JwtService);
    const foreignToken = await otherJwtService.signAsync(payload);

    // Should fail verification with our secret
    await expect(jwtService.verifyAsync(foreignToken)).rejects.toThrow();

    await otherModule.close();
  });

  it('should enforce audience claim validation', async () => {
    const payload: JwtPayload = {
      sub: crypto.randomUUID(),
      email: 'audience@aquaculture.io',
      role: Role.TENANT_ADMIN,
      roles: [Role.TENANT_ADMIN],
      tenantId: null,
      type: 'access',
    };

    const token = await jwtService.signAsync(payload, {
      audience: 'wrong-audience',
    });

    await expect(jwtService.verifyAsync(token, { audience: TEST_JWT_AUDIENCE })).rejects.toThrow();
  });
});

// ============================================================================
// 3. Passport Strategy Verification
// ============================================================================

describe('Passport Strategy Verification (v11)', () => {
  let jwtAuthGuard: JwtAuthGuard;
  let jwtService: JwtService;
  let reflector: Reflector;
  let tokenBlacklist: MockTokenBlacklist;

  beforeEach(async () => {
    tokenBlacklist = createMockTokenBlacklist();

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '15m', audience: TEST_JWT_AUDIENCE },
        }),
      ],
      providers: [
        JwtAuthGuard,
        Reflector,
        { provide: ConfigService, useValue: createMockConfigService() },
        { provide: TOKEN_BLACKLIST, useValue: tokenBlacklist },
      ],
    }).compile();

    jwtAuthGuard = module.get<JwtAuthGuard>(JwtAuthGuard);
    jwtService = module.get<JwtService>(JwtService);
    reflector = module.get<Reflector>(Reflector);
  });

  describe('JWT Strategy', () => {
    it('should allow access with a valid JWT Bearer token', async () => {
      const payload: JwtPayload = {
        sub: crypto.randomUUID(),
        email: 'guard-test@aquaculture.io',
        role: Role.TENANT_ADMIN,
        roles: [Role.TENANT_ADMIN],
        tenantId: crypto.randomUUID(),
        type: 'access',
        jti: crypto.randomUUID(),
      };

      const token = await jwtService.signAsync(payload, {
        audience: TEST_JWT_AUDIENCE,
      });

      const mockRequest: MockHttpRequest = {
        headers: {
          authorization: `Bearer ${token}`,
        },
      };

      const mockContext = createMockExecutionContext(mockRequest, false);

      const result = await jwtAuthGuard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(mockRequest.user).toBeDefined();
      expect(mockRequest.user!.sub).toBe(payload.sub);
      expect(mockRequest.user!.email).toBe(payload.email);
      expect(mockRequest.user!.role).toBe(Role.TENANT_ADMIN);
    });

    it('should reject request without Authorization header', async () => {
      const mockRequest = {
        headers: {},
      };

      const mockContext = createMockExecutionContext(mockRequest, false);

      await expect(jwtAuthGuard.canActivate(mockContext)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject request with invalid token format', async () => {
      const mockRequest = {
        headers: {
          authorization: 'Bearer invalid.token.here',
        },
      };

      const mockContext = createMockExecutionContext(mockRequest, false);

      await expect(jwtAuthGuard.canActivate(mockContext)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject request with non-Bearer scheme', async () => {
      const token = await jwtService.signAsync({
        sub: crypto.randomUUID(),
        email: 'test@test.com',
        role: Role.MODULE_USER,
        roles: [Role.MODULE_USER],
        tenantId: null,
      });

      const mockRequest = {
        headers: {
          authorization: `Basic ${token}`,
        },
      };

      const mockContext = createMockExecutionContext(mockRequest, false);

      await expect(jwtAuthGuard.canActivate(mockContext)).rejects.toThrow(UnauthorizedException);
    });

    it('should allow public endpoints without authentication', async () => {
      const mockRequest = {
        headers: {},
      };

      const mockContext = createMockExecutionContext(mockRequest, true);

      const result = await jwtAuthGuard.canActivate(mockContext);
      expect(result).toBe(true);
    });

    it('should check token blacklist for JTI-based revocation', async () => {
      const jti = crypto.randomUUID();
      const sub = crypto.randomUUID();
      const payload: JwtPayload = {
        sub,
        email: 'blacklist@aquaculture.io',
        role: Role.MODULE_USER,
        roles: [Role.MODULE_USER],
        tenantId: null,
        type: 'access',
        jti,
      };

      const token = await jwtService.signAsync(payload, {
        audience: TEST_JWT_AUDIENCE,
      });

      // Mark token as blacklisted
      tokenBlacklist.isValidToken.mockResolvedValue(false);

      const mockRequest = {
        headers: {
          authorization: `Bearer ${token}`,
        },
      };

      const mockContext = createMockExecutionContext(mockRequest, false);

      await expect(jwtAuthGuard.canActivate(mockContext)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('Local Strategy (password validation)', () => {
    it('should authenticate user with correct email and password via AuthenticationService', async () => {
      const authModule: TestingModule = await Test.createTestingModule({
        imports: [
          JwtModule.register({
            secret: TEST_JWT_SECRET,
            signOptions: { expiresIn: '15m', audience: TEST_JWT_AUDIENCE },
          }),
        ],
        providers: [
          TokenService,
          MfaService,
          AuthenticationService,
          { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
          {
            provide: getRepositoryToken(RefreshToken),
            useValue: createMockRepository<RefreshToken>(),
          },
          { provide: getRepositoryToken(Invitation), useValue: createMockRepository<Invitation>() },
          {
            provide: getRepositoryToken(UserModuleAssignment),
            useValue: { find: jest.fn().mockResolvedValue([]) },
          },
          { provide: getRepositoryToken(Tenant), useValue: createMockRepository<Tenant>() },
          {
            provide: DataSource,
            useValue: { transaction: jest.fn(), query: jest.fn().mockResolvedValue([]) },
          },
          { provide: ConfigService, useValue: createMockConfigService() },
          { provide: 'EVENT_BUS', useValue: { publish: jest.fn().mockResolvedValue(undefined) } },
          { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
          {
            provide: TimingSafeService,
            useValue: { ensureMinDuration: jest.fn().mockResolvedValue(undefined) },
          },
          { provide: SESSION_MANAGER, useValue: createMockSessionManager() },
          { provide: TOKEN_BLACKLIST, useValue: createMockTokenBlacklist() },
        ],
      }).compile();

      const localAuthService = authModule.get<AuthenticationService>(AuthenticationService);
      const localUserRepo = authModule.get<Repository<User>>(getRepositoryToken(User));
      const localRefreshRepo = authModule.get<Repository<RefreshToken>>(
        getRepositoryToken(RefreshToken),
      );

      const testUser = createMockUser();
      testUser.validatePassword = jest.fn().mockResolvedValue(true);

      jest.spyOn(localUserRepo, 'findOne').mockResolvedValue(testUser);
      jest.spyOn(localUserRepo, 'save').mockResolvedValue(testUser);
      jest.spyOn(localRefreshRepo, 'create').mockImplementation((data) => data as RefreshToken);
      jest
        .spyOn(localRefreshRepo, 'save')
        .mockImplementation((data) =>
          Promise.resolve({ id: crypto.randomUUID(), ...data } as RefreshToken),
        );

      const result = await localAuthService.login({
        email: testUser.email,
        password: 'ValidPassword123!',
      });

      expect(result.accessToken).toBeTruthy();
      expect(result.user.email).toBe(testUser.email);

      await authModule.close();
    });

    it('should reject authentication with wrong password', async () => {
      const authModule: TestingModule = await Test.createTestingModule({
        imports: [
          JwtModule.register({
            secret: TEST_JWT_SECRET,
            signOptions: { expiresIn: '15m', audience: TEST_JWT_AUDIENCE },
          }),
        ],
        providers: [
          TokenService,
          MfaService,
          AuthenticationService,
          { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
          {
            provide: getRepositoryToken(RefreshToken),
            useValue: createMockRepository<RefreshToken>(),
          },
          { provide: getRepositoryToken(Invitation), useValue: createMockRepository<Invitation>() },
          {
            provide: getRepositoryToken(UserModuleAssignment),
            useValue: { find: jest.fn().mockResolvedValue([]) },
          },
          { provide: getRepositoryToken(Tenant), useValue: createMockRepository<Tenant>() },
          {
            provide: DataSource,
            useValue: { transaction: jest.fn(), query: jest.fn().mockResolvedValue([]) },
          },
          { provide: ConfigService, useValue: createMockConfigService() },
          { provide: 'EVENT_BUS', useValue: { publish: jest.fn().mockResolvedValue(undefined) } },
          { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
          {
            provide: TimingSafeService,
            useValue: { ensureMinDuration: jest.fn().mockResolvedValue(undefined) },
          },
          { provide: SESSION_MANAGER, useValue: createMockSessionManager() },
          { provide: TOKEN_BLACKLIST, useValue: createMockTokenBlacklist() },
        ],
      }).compile();

      const localAuthService = authModule.get<AuthenticationService>(AuthenticationService);
      const localUserRepo = authModule.get<Repository<User>>(getRepositoryToken(User));

      const testUser = createMockUser();
      testUser.validatePassword = jest.fn().mockResolvedValue(false);

      jest.spyOn(localUserRepo, 'findOne').mockResolvedValue(testUser);
      jest.spyOn(localUserRepo, 'save').mockResolvedValue(testUser);

      await expect(
        localAuthService.login({ email: testUser.email, password: 'WrongPassword!' }),
      ).rejects.toThrow(UnauthorizedException);

      await authModule.close();
    });

    it('should reject authentication for non-existent user', async () => {
      const authModule: TestingModule = await Test.createTestingModule({
        imports: [
          JwtModule.register({
            secret: TEST_JWT_SECRET,
            signOptions: { expiresIn: '15m', audience: TEST_JWT_AUDIENCE },
          }),
        ],
        providers: [
          TokenService,
          MfaService,
          AuthenticationService,
          { provide: getRepositoryToken(User), useValue: createMockRepository<User>() },
          {
            provide: getRepositoryToken(RefreshToken),
            useValue: createMockRepository<RefreshToken>(),
          },
          { provide: getRepositoryToken(Invitation), useValue: createMockRepository<Invitation>() },
          {
            provide: getRepositoryToken(UserModuleAssignment),
            useValue: { find: jest.fn().mockResolvedValue([]) },
          },
          { provide: getRepositoryToken(Tenant), useValue: createMockRepository<Tenant>() },
          {
            provide: DataSource,
            useValue: { transaction: jest.fn(), query: jest.fn().mockResolvedValue([]) },
          },
          { provide: ConfigService, useValue: createMockConfigService() },
          { provide: 'EVENT_BUS', useValue: { publish: jest.fn().mockResolvedValue(undefined) } },
          { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
          {
            provide: TimingSafeService,
            useValue: { ensureMinDuration: jest.fn().mockResolvedValue(undefined) },
          },
          { provide: SESSION_MANAGER, useValue: createMockSessionManager() },
          { provide: TOKEN_BLACKLIST, useValue: createMockTokenBlacklist() },
        ],
      }).compile();

      const localAuthService = authModule.get<AuthenticationService>(AuthenticationService);
      const localUserRepo = authModule.get<Repository<User>>(getRepositoryToken(User));

      jest.spyOn(localUserRepo, 'findOne').mockResolvedValue(null);

      await expect(
        localAuthService.login({ email: 'ghost@aquaculture.io', password: 'AnyPassword!' }),
      ).rejects.toThrow(UnauthorizedException);

      await authModule.close();
    });
  });
});

// ============================================================================
// 4. GDPR Consent Resolver req.ip Handling
// ============================================================================

describe('GDPR Consent Resolver req.ip Handling (v11)', () => {
  let resolver: UserConsentResolver;
  let consentService: { recordConsent: jest.Mock; getConsentStatus: jest.Mock };

  beforeEach(async () => {
    consentService = {
      recordConsent: jest.fn().mockResolvedValue({
        success: true,
        consentId: crypto.randomUUID(),
      }),
      getConsentStatus: jest.fn().mockResolvedValue({
        userId: 'user-1',
        consents: [],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UserConsentResolver, { provide: UserConsentService, useValue: consentService }],
    }).compile();

    resolver = module.get<UserConsentResolver>(UserConsentResolver);
  });

  describe('Request with valid IP', () => {
    it('should capture req.ip correctly when present', async () => {
      const userId = crypto.randomUUID();
      const tenantId = crypto.randomUUID();
      const mockReq: MockGraphQLRequest = {
        ip: '203.0.113.45',
        headers: {
          'user-agent': 'Mozilla/5.0 E2E-Test',
        },
      };

      await resolver.recordConsent(
        userId,
        tenantId,
        { consentType: 'PRIVACY_POLICY' as never, granted: true },
        { req: mockReq as never },
      );

      expect(consentService.recordConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          tenantId,
          ipAddress: '203.0.113.45',
          userAgent: 'Mozilla/5.0 E2E-Test',
        }),
        expect.anything(),
      );
    });

    it('should prefer x-forwarded-for header over req.ip when present', async () => {
      const userId = crypto.randomUUID();
      const tenantId = crypto.randomUUID();
      const mockReq: MockGraphQLRequest = {
        ip: '10.0.0.1',
        headers: {
          'x-forwarded-for': '198.51.100.22, 10.0.0.1',
          'user-agent': 'E2E-Proxy-Test',
        },
      };

      await resolver.recordConsent(
        userId,
        tenantId,
        { consentType: 'PRIVACY_POLICY' as never, granted: true },
        { req: mockReq as never },
      );

      // Should extract first IP from X-Forwarded-For
      expect(consentService.recordConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '198.51.100.22',
        }),
        expect.anything(),
      );
    });
  });

  describe('Request without IP (proxy trust failure simulation)', () => {
    it('should handle undefined req.ip gracefully without TypeError', async () => {
      const userId = crypto.randomUUID();
      const tenantId = crypto.randomUUID();
      const mockReq: MockGraphQLRequest = {
        // ip is intentionally omitted (simulates Express v5 trust proxy change)
        headers: {
          'user-agent': 'E2E-No-IP-Test',
        },
      };

      // This must NOT throw a TypeError
      await expect(
        resolver.recordConsent(
          userId,
          tenantId,
          { consentType: 'PRIVACY_POLICY' as never, granted: true },
          { req: mockReq as never },
        ),
      ).resolves.toBeDefined();

      expect(consentService.recordConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          tenantId,
          ipAddress: undefined,
          userAgent: 'E2E-No-IP-Test',
        }),
        expect.anything(),
      );
    });

    it('should handle completely empty headers gracefully', async () => {
      const userId = crypto.randomUUID();
      const tenantId = crypto.randomUUID();
      const mockReq: MockGraphQLRequest = {
        // No ip, no headers
      };

      await expect(
        resolver.recordConsent(
          userId,
          tenantId,
          { consentType: 'PRIVACY_POLICY' as never, granted: true },
          { req: mockReq as never },
        ),
      ).resolves.toBeDefined();

      expect(consentService.recordConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          tenantId,
          ipAddress: undefined,
          userAgent: undefined,
        }),
        expect.anything(),
      );
    });

    it('should fall back to connection.remoteAddress when ip and headers are absent', async () => {
      const userId = crypto.randomUUID();
      const tenantId = crypto.randomUUID();
      const mockReq: MockGraphQLRequest = {
        // No ip, no x-forwarded-for
        headers: {
          'user-agent': 'E2E-Fallback-Test',
        },
        connection: {
          remoteAddress: '127.0.0.1',
        },
      };

      await resolver.recordConsent(
        userId,
        tenantId,
        { consentType: 'PRIVACY_POLICY' as never, granted: true },
        { req: mockReq as never },
      );

      expect(consentService.recordConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '127.0.0.1',
        }),
        expect.anything(),
      );
    });

    it('should not crash when req object has null-ish properties', async () => {
      const userId = crypto.randomUUID();
      const mockReq: MockGraphQLRequest = {
        ip: undefined,
        headers: undefined,
        connection: undefined,
      };

      // The resolver's extractRequestContext must handle this gracefully
      // This is the key Express v5 scenario: trust proxy changes can cause
      // req.ip to become undefined where it was always a string in v4
      await expect(
        resolver.recordConsent(
          userId,
          null,
          { consentType: 'PRIVACY_POLICY' as never, granted: true },
          { req: mockReq as never },
        ),
      ).resolves.toBeDefined();

      expect(consentService.recordConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          tenantId: null,
          ipAddress: undefined,
          userAgent: undefined,
        }),
        expect.anything(),
      );
    });
  });
});

// ============================================================================
// 5. parseExpiresIn Utility (regression-proofing for v11)
// ============================================================================

describe('parseExpiresIn utility (v11 regression proofing)', () => {
  it('should parse seconds correctly', () => {
    expect(parseExpiresIn('30s')).toBe(30);
    expect(parseExpiresIn('120s')).toBe(120);
  });

  it('should parse minutes correctly', () => {
    expect(parseExpiresIn('15m')).toBe(900);
    expect(parseExpiresIn('1m')).toBe(60);
  });

  it('should parse hours correctly', () => {
    expect(parseExpiresIn('1h')).toBe(3600);
    expect(parseExpiresIn('24h')).toBe(86400);
  });

  it('should parse days correctly', () => {
    expect(parseExpiresIn('7d')).toBe(604800);
    expect(parseExpiresIn('1d')).toBe(86400);
  });

  it('should parse weeks correctly', () => {
    expect(parseExpiresIn('1w')).toBe(604800);
    expect(parseExpiresIn('2w')).toBe(1209600);
  });

  it('should return default for invalid format', () => {
    expect(parseExpiresIn('')).toBe(SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_SECONDS);
    expect(parseExpiresIn('invalid')).toBe(SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_SECONDS);
    expect(parseExpiresIn('15')).toBe(SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_SECONDS);
    expect(parseExpiresIn('abc')).toBe(SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_SECONDS);
  });
});

// ============================================================================
// Helper: create mock ExecutionContext for JwtAuthGuard tests
// ============================================================================

function createMockExecutionContext(request: object, isPublic: boolean): ExecutionContext {
  const handler = jest.fn();
  const classRef = jest.fn();

  const context: ExecutionContext = {
    getType: jest.fn().mockReturnValue('http') as () => string,
    getHandler: jest.fn().mockReturnValue(handler),
    getClass: jest.fn().mockReturnValue(classRef),
    switchToHttp: jest.fn().mockReturnValue({
      getRequest: jest.fn().mockReturnValue(request),
      getResponse: jest.fn(),
      getNext: jest.fn(),
    }),
    switchToRpc: jest.fn(),
    switchToWs: jest.fn(),
    getArgs: jest.fn().mockReturnValue([]),
    getArgByIndex: jest.fn(),
  } as unknown as ExecutionContext;

  // Wire up the Reflector.getAllAndOverride to return isPublic
  // The JwtAuthGuard uses reflector.getAllAndOverride(IS_PUBLIC_KEY, [handler, class])
  // We need to set the metadata on the handler function
  if (isPublic) {
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, classRef);
  }

  return context;
}
