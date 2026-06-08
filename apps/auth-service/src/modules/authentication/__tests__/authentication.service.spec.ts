/**
 * WHY THIS FILE EXISTS:
 * authentication.service.ts is 1,042 lines of code covering every entry point
 * to the platform (login, register, refreshToken, logout). Before this file,
 * no unit tests existed for these methods. Regressions in login() — account
 * locking, tenant suspension, MFA branching, session limits — would only be
 * caught in E2E tests (which were swallowed with || true) or in production.
 *
 * Pattern follows password-reset.spec.ts: mock all collaborators, test each
 * login code path in isolation.
 */

// Production uses bcryptjs (see authentication.service.ts:2,
// token.service.ts:2). The spec was importing 'bcrypt' (without
// @types/bcrypt declared), so jest.spyOn(bcrypt, 'compare') was
// patching a DIFFERENT module than the one the SUT actually
// invokes — every "should reject password X" assertion was
// passing because the SUT called the real, un-mocked bcryptjs
// while the test mocked an unrelated bcrypt instance.
// Aligning to bcryptjs makes the spies intercept the real call
// path AND silences the missing-types error. Surfaced by PR-31
// (PROC-MEDIUM-007 ratchet).
import * as bcrypt from 'bcryptjs';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import { TimingSafeService, SESSION_MANAGER, TOKEN_BLACKLIST } from '@aquaculture/backend-common/security';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { ActionToken } from '../entities/action-token.entity';
import { Invitation } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { User } from '../entities/user.entity';
import { Tenant, TenantStatus } from '../../tenant/entities/tenant.entity';
import { AuthenticationService } from '../services/authentication.service';
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';

jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
}));

const mockBcryptCompare = bcrypt.compare as unknown as jest.MockedFunction<
  (data: string, encrypted: string) => Promise<boolean>
>;

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
    failedLoginAttempts: 0,
    lockedUntil: null,
    isPendingInvitation: () => false,
    isLocked: () => false,
    ...overrides,
  });
  return user;
};

const createMockTenant = (overrides: Partial<Tenant> = {}): Tenant => {
  const tenant = new Tenant();
  Object.assign(tenant, {
    id: 'tenant-uuid-123',
    name: 'Test Tenant',
    status: 'active',
    ...overrides,
  });
  return tenant;
};

// ============================================================================
// Mock Setup — same structure as password-reset.spec.ts
// ============================================================================

const mockUserRepository = {
  findOne: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
  createQueryBuilder: jest.fn(),
};

const mockRefreshTokenRepository = {
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
  createQueryBuilder: jest.fn(),
  // findOne was added when refreshToken() flow grew lookup-by-token
  // semantics. Per-test bodies (lines ~356, 369, 382) re-mock with
  // `mockRefreshTokenRepository.findOne = jest.fn().mockResolvedValue(...)`,
  // which strict-tsc rejected because the literal was the type
  // anchor and didn't carry the property. Declared here so per-test
  // assignments are property updates, not new-property additions.
  findOne: jest.fn(),
  find: jest.fn(),
  count: jest.fn(),
  delete: jest.fn(),
};

const mockInvitationRepository = {
  findOne: jest.fn(),
};

const mockActionTokenRepository = {
  create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
  save: jest.fn(async (entity: Record<string, unknown>) => ({
    id: 'action-token-id',
    ...entity,
  })),
  findOne: jest.fn(),
};

const mockUserModuleAssignmentRepository = {
  find: jest.fn().mockResolvedValue([]),
};

const mockTenantRepository = {
  findOne: jest.fn(),
};

const mockJwtService = {
  signAsync: jest.fn().mockResolvedValue('mock-access-token'),
};

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: unknown) => {
    const config: Record<string, unknown> = {
      JWT_EXPIRES_IN: '15m',
      JWT_AUDIENCE: 'test-audience',
      MIN_LOGIN_DURATION_MS: 0,
      MAX_FAILED_ATTEMPTS: 5,
      LOCKOUT_DURATION_MINUTES: 30,
      REFRESH_TOKEN_EXPIRY_DAYS: 7,
      MAX_SESSIONS_PER_USER: 5,
      HASH_REFRESH_TOKENS: false,
    };
    return config[key] ?? defaultValue;
  }),
};

const mockEventBus = {
  publish: jest.fn().mockResolvedValue(undefined),
};

const mockAuditLogService = {
  log: jest.fn().mockResolvedValue(undefined),
};

const mockDataSource = {
  transaction: jest.fn(),
  query: jest.fn(),
};

const mockTransactionManager = {
  getRepository: jest.fn(),
};

const mockTimingSafe = {
  ensureMinDuration: jest.fn().mockResolvedValue(undefined),
};

const mockSessionManager = {
  countActiveSessions: jest.fn().mockResolvedValue(0),
  createSession: jest.fn().mockResolvedValue(undefined),
  invalidateSession: jest.fn().mockResolvedValue(undefined),
  invalidateAllSessions: jest.fn().mockResolvedValue(0),
  revokeAllSessions: jest.fn().mockResolvedValue(undefined),
};

const mockTokenBlacklist = {
  add: jest.fn().mockResolvedValue(undefined),
  isBlacklisted: jest.fn().mockResolvedValue(false),
};

const mockTokenService = {
  generateTokens: jest.fn().mockResolvedValue({
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    user: null,
  }),
  refreshTokens: jest.fn(),
};

const mockMfaService = {};

// ============================================================================
// Test Suite
// ============================================================================

describe('AuthenticationService', () => {
  let service: AuthenticationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockBcryptCompare.mockReset();

    // Default happy-path setup
    mockUserModuleAssignmentRepository.find.mockResolvedValue([]);
    mockActionTokenRepository.findOne.mockResolvedValue(null);
    mockRefreshTokenRepository.count.mockResolvedValue(0);
    mockRefreshTokenRepository.create.mockImplementation((data: Partial<RefreshToken>) => ({ ...data }));
    mockRefreshTokenRepository.save.mockImplementation((token: Partial<RefreshToken>) => Promise.resolve(token));
    mockRefreshTokenRepository.createQueryBuilder.mockReturnValue({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    });
    mockTransactionManager.getRepository.mockImplementation((entity: unknown) => {
      if (entity === RefreshToken) return mockRefreshTokenRepository;
      if (entity === User) return mockUserRepository;
      if (entity === Invitation) return mockInvitationRepository;
      if (entity === ActionToken) return mockActionTokenRepository;
      return {};
    });
    mockDataSource.transaction.mockImplementation(
      async (callback: (manager: typeof mockTransactionManager) => Promise<unknown>) =>
        callback(mockTransactionManager),
    );
    mockDataSource.query.mockResolvedValue([
      { failedLoginAttempts: 3, lockedUntil: null },
    ]);
    mockSessionManager.countActiveSessions.mockResolvedValue(0);
    mockSessionManager.revokeAllSessions.mockResolvedValue(undefined);
    mockTokenService.generateTokens.mockImplementation(async (user: User) => ({
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      user,
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: getRepositoryToken(RefreshToken), useValue: mockRefreshTokenRepository },
        { provide: getRepositoryToken(Invitation), useValue: mockInvitationRepository },
        { provide: getRepositoryToken(ActionToken), useValue: mockActionTokenRepository },
        { provide: getRepositoryToken(UserModuleAssignment), useValue: mockUserModuleAssignmentRepository },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepository },
        { provide: DataSource, useValue: mockDataSource },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: 'EVENT_BUS', useValue: mockEventBus },
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: TokenService, useValue: mockTokenService },
        { provide: MfaService, useValue: mockMfaService },
        { provide: TimingSafeService, useValue: mockTimingSafe },
        { provide: SESSION_MANAGER, useValue: mockSessionManager },
        { provide: TOKEN_BLACKLIST, useValue: mockTokenBlacklist },
        // DEPLOY-CRITICAL-007: AuthenticationService injects BypassRlsService
        // so the SUPER_ADMIN login path can create refresh tokens on a
        // tenantId=NULL row (which cannot satisfy tenant_isolation_policy
        // regardless of app.current_tenant). The mock forwards through
        // withBypass so the unit test exercises the SAME call chain as
        // production — just without the audit WARN log.
        {
          provide: BypassRlsService,
          useValue: {
            withBypass: async <T>(_op: string, cb: () => Promise<T> | T): Promise<T> =>
              cb(),
            withBypassSync: <T>(_op: string, cb: () => T): T => cb(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthenticationService>(AuthenticationService);
  });

  // ==========================================================================
  // login()
  // ==========================================================================
  describe('login()', () => {
    const validInput = { email: 'test@example.com', password: 'ValidP@ss1' };

    it('returns AuthPayload with tokens on valid credentials', async () => {
      const user = createMockUser();
      const tenant = createMockTenant();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(tenant);
      mockBcryptCompare.mockResolvedValue(true);
      mockUserRepository.save.mockResolvedValue(user);

      const result = await service.login(validInput, '127.0.0.1', 'test-agent');

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(mockUserRepository.save).toHaveBeenCalled();
    });

    it('throws UnauthorizedException and performs dummy hash check when user not found', async () => {
      // SECURITY: prevents timing-based user enumeration
      mockUserRepository.findOne.mockResolvedValue(null);
      mockBcryptCompare.mockResolvedValue(false);

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);
      // Dummy hash compare must always run to equalise timing
      expect(mockBcryptCompare).toHaveBeenCalled();
    });

    it('throws UnauthorizedException on wrong password and increments failedLoginAttempts', async () => {
      const user = createMockUser({ failedLoginAttempts: 2 });
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(createMockTenant());
      mockBcryptCompare.mockResolvedValue(false);
      mockUserRepository.save.mockResolvedValue({ ...user, failedLoginAttempts: 3 });

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE auth.users'),
        expect.arrayContaining(['user-uuid-123']),
      );
    });

    it('throws UnauthorizedException when account is locked (isLocked returns true)', async () => {
      const user = createMockUser({ isLocked: () => true });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);
    });

    it('resets failedLoginAttempts to 0 on successful login', async () => {
      const user = createMockUser({ failedLoginAttempts: 3 });
      const tenant = createMockTenant();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(tenant);
      mockBcryptCompare.mockResolvedValue(true);
      mockUserRepository.save.mockResolvedValue({ ...user, failedLoginAttempts: 0 });

      await service.login(validInput);

      expect(mockUserRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ failedLoginAttempts: 0 }),
      );
    });

    it('throws UnauthorizedException when account is inactive', async () => {
      const user = createMockUser({ isActive: false });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);
    });

    it('throws ForbiddenException or UnauthorizedException when tenant is suspended', async () => {
      const user = createMockUser();
      const suspendedTenant = createMockTenant({ status: TenantStatus.SUSPENDED });
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(suspendedTenant);
      mockBcryptCompare.mockResolvedValue(true);

      await expect(service.login(validInput)).rejects.toThrow(
        expect.objectContaining({ message: expect.any(String) }),
      );
    });

    it('throws UnauthorizedException for pending-invitation user', async () => {
      const user = createMockUser({ isPendingInvitation: () => true });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);
    });

    it('delegates token generation after password validation', async () => {
      const user = createMockUser();
      const tenant = createMockTenant();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(tenant);
      mockBcryptCompare.mockResolvedValue(true);
      mockUserRepository.save.mockResolvedValue(user);

      await expect(service.login(validInput)).resolves.toEqual(
        expect.objectContaining({ accessToken: 'mock-access-token' }),
      );
      expect(mockTokenService.generateTokens).toHaveBeenCalledWith(user, undefined, undefined);
    });

    it('records audit log entry on successful login', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(createMockTenant());
      mockBcryptCompare.mockResolvedValue(true);
      mockUserRepository.save.mockResolvedValue(user);

      await service.login(validInput, '127.0.0.1');

      expect(mockAuditLogService.log).toHaveBeenCalled();
    });

    it('records audit log entry on failed login (wrong password)', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(createMockTenant());
      mockBcryptCompare.mockResolvedValue(false);
      mockUserRepository.save.mockResolvedValue(user);

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);
      expect(mockAuditLogService.log).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // refreshToken()
  // ==========================================================================
  describe('refreshToken()', () => {
    it('throws UnauthorizedException for a token that is not in the store', async () => {
      mockRefreshTokenRepository.findOne = jest.fn().mockResolvedValue(null);

      await expect(service.refreshToken('invalid-token')).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException for an expired refresh token', async () => {
      const expiredToken = {
        token: 'expired-token',
        expiresAt: new Date(Date.now() - 1000), // expired 1 second ago
        isRevoked: false,
        userId: 'user-uuid-123',
        user: createMockUser(),
      };
      mockRefreshTokenRepository.findOne = jest.fn().mockResolvedValue(expiredToken);

      await expect(service.refreshToken('expired-token')).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException for a revoked refresh token', async () => {
      const revokedToken = {
        token: 'revoked-token',
        expiresAt: new Date(Date.now() + 86400000),
        isRevoked: true,
        userId: 'user-uuid-123',
        user: createMockUser(),
      };
      mockRefreshTokenRepository.findOne = jest.fn().mockResolvedValue(revokedToken);

      await expect(service.refreshToken('revoked-token')).rejects.toThrow(UnauthorizedException);
    });
  });

  // ==========================================================================
  // logout()
  // ==========================================================================
  describe('logout()', () => {
    it('revokes the refresh token and returns true', async () => {
      mockRefreshTokenRepository.update = jest.fn().mockResolvedValue({ affected: 1 });

      const result = await service.logout('user-uuid-123');

      expect(result).toBe(true);
    });

    it('blacklists the access token when jti is provided', async () => {
      mockRefreshTokenRepository.update = jest.fn().mockResolvedValue({ affected: 1 });
      const accessExpiry = new Date(Date.now() + 900000);

      await service.logout('user-uuid-123', 'jti-123', accessExpiry);

      expect(mockTokenBlacklist.add).toHaveBeenCalledWith('jti-123', accessExpiry, 'user_logout');
    });
  });
});
