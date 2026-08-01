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
import { BypassRlsService } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  TimingSafeService,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
} from '@aquaculture/backend-common/security';
import { ForbiddenException, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { Tenant, TenantStatus } from '../../tenant/entities/tenant.entity';
import { ActionToken } from '../entities/action-token.entity';
import { Invitation } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { User } from '../entities/user.entity';
import {
  AuthenticationService,
  decodeRefreshTokenTransport,
} from '../services/authentication.service';
import { DurableAccessTokenInvalidationService } from '../services/durable-access-token-invalidation.service';
import { DurableUserTokenInvalidationService } from '../services/durable-user-token-invalidation.service';
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';

// WHY: bcryptjs publishes a sealed module namespace under the current
// toolchain — jest.spyOn(bcrypt, 'compare') throws "Cannot redefine
// property". Re-exporting compare/hash as plain jest.fn wrappers (default
// behaviour = the real implementation) restores spy-ability while keeping
// production-equivalent hashing for tests that don't stub.
jest.mock('bcryptjs', () => {
  const actual = jest.requireActual<typeof bcrypt>('bcryptjs');
  // Bind the promise overloads explicitly — jest.fn over the raw
  // overloaded functions resolves the callback overload and trips
  // no-misused-promises.
  const promiseCompare: (data: string, encrypted: string) => Promise<boolean> = actual.compare;
  const promiseHash: (data: string, saltOrRounds: string | number) => Promise<string> = actual.hash;
  return { ...actual, compare: jest.fn(promiseCompare), hash: jest.fn(promiseHash) };
});

// SEC-LOW-001(a) cross-test support: keep the REAL enforceAccessTokenType so the
// token-type symmetry (an mfa_challenge token rejected on the bearer
// introspection surface) is genuinely exercised, but stub getJwtVerifyOptions to
// a benign options object so validateToken() does not require JWT_PUBLIC_KEY at
// unit-test time. verifyAsync is mocked per-test to supply the decoded payload.
jest.mock('@aquaculture/backend-common/auth', () => {
  const actual = jest.requireActual<typeof import('@aquaculture/backend-common/auth')>(
    '@aquaculture/backend-common/auth',
  );
  return {
    ...actual,
    getJwtVerifyOptions: jest.fn().mockReturnValue({ algorithms: ['RS256'] }),
  };
});

// Typed alias over the spy-able wrapper above: body assertions stub via
// mockBcryptCompare.mockResolvedValue while jest.spyOn(bcrypt, 'compare')
// remains equally valid — both views target the same jest.fn. The
// explicit type argument selects compare's promise overload; jest.mocked
// over the raw overloaded type collapses mockResolvedValue to never.
const mockBcryptCompare = jest.mocked<(data: string, encrypted: string) => Promise<boolean>>(
  bcrypt.compare,
);

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
    // Canonical UPPERCASE — the lowercase 'active' the mock used before never
    // matched the persisted 'ACTIVE', so the old block-list passed login for
    // the WRONG reason (active simply wasn't in the reject set). The allow-list
    // (isLoginAllowed) requires the real value.
    status: TenantStatus.ACTIVE,
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
  save: jest.fn((entity: Record<string, unknown>) =>
    Promise.resolve({
      id: 'action-token-id',
      ...entity,
    }),
  ),
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
  // verifyAsync drives validateToken(); individual tests set the decoded payload.
  verifyAsync: jest.fn(),
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

// WHY: token minting moved out of AuthenticationService into TokenService
// (refresh-token persistence + session bookkeeping live there now). The unit
// boundary for these specs is therefore the AuthPayload contract returned by
// generateTokens, not the JWT/bcrypt internals — those are TokenService's own
// spec's responsibility.
const mockTokenService = {
  generateTokens: jest.fn().mockImplementation((user: User) =>
    Promise.resolve({
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      user,
      expiresIn: 900,
      tokenType: 'Bearer',
      redirectUrl: '/dashboard',
    }),
  ),
  getUserModules: jest.fn().mockResolvedValue([]),
};

// WHAT: login() consults MfaService for the MFA branch
// (user.mfaEnabled && isMfaAvailable() → generateMfaChallenge().mfaToken).
// Default user fixtures have mfaEnabled=false, so only the explicit MFA
// tests exercise these stubs.
const mockMfaService = {
  isMfaAvailable: jest.fn().mockReturnValue(true),
  generateMfaChallenge: jest.fn().mockReturnValue({ mfaToken: 'mock-mfa-token' }),
};

const mockDataSource = {
  // WHY: refreshToken() (non-hashed path) runs inside dataSource.transaction
  // with manager-scoped repositories and a pessimistic-lock query builder.
  // The mock manager mirrors the SQL acceptance rules (isRevoked = false,
  // expiresAt > now) so the spec exercises the same semantics the WHERE
  // clause enforces in production — a passthrough mock would let expired or
  // revoked tokens through and the negative-path tests would assert nothing.
  transaction: jest.fn().mockImplementation(async (cb: (manager: unknown) => Promise<unknown>) => {
    const refreshTokenQueryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockImplementation(async () => {
        const token = (await mockRefreshTokenRepository.findOne()) as {
          isRevoked?: boolean;
          expiresAt?: Date;
        } | null;
        if (
          !token ||
          token.isRevoked === true ||
          !(token.expiresAt instanceof Date) ||
          token.expiresAt.getTime() <= Date.now()
        ) {
          return null;
        }
        return token;
      }),
    };
    const manager = {
      getRepository: jest.fn().mockImplementation((entity: unknown) => {
        if (entity === RefreshToken) {
          return {
            ...mockRefreshTokenRepository,
            createQueryBuilder: jest.fn(() => refreshTokenQueryBuilder),
          };
        }
        if (entity === User) {
          return mockUserRepository;
        }
        return {};
      }),
      query: jest.fn(),
    };
    return cb(manager);
  }),
  // WHAT: handleFailedLogin() runs an atomic UPDATE ... RETURNING. The
  // postgres driver returns the TUPLE `[rows, affectedCount]` for UPDATE
  // statements (ORPHAN-HIGH-318 — the old mock mirrored the WRONG plain-rows
  // shape, exactly the misread that shipped). The default reply mirrors one
  // failed attempt on an unlocked account so negative-path login tests
  // exercise the real post-update branch.
  query: jest.fn().mockResolvedValue([[{ failedLoginAttempts: 1, lockedUntil: null }], 1]),
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
  enforceSessionLimit: jest.fn().mockResolvedValue(undefined),
  revokeAllSessions: jest.fn().mockResolvedValue(undefined),
};

const mockTokenBlacklist = {
  add: jest.fn().mockResolvedValue(undefined),
  isBlacklisted: jest.fn().mockResolvedValue(false),
};

const mockUserTokenRevocation = {
  revokeUserTokens: jest.fn().mockResolvedValue(undefined),
  isTokenValid: jest.fn().mockResolvedValue(true),
};

const mockDurableAccessTokenInvalidation = {
  enqueue: jest.fn().mockResolvedValue(undefined),
  applyImmediately: jest.fn().mockResolvedValue(undefined),
};

const mockDurableUserTokenInvalidation = {
  enqueue: jest.fn().mockResolvedValue(undefined),
  applyImmediately: jest.fn().mockResolvedValue(undefined),
};

// ============================================================================
// Test Suite
// ============================================================================

describe('AuthenticationService', () => {
  let service: AuthenticationService;
  let bypassRlsMock: BypassRlsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockBcryptCompare.mockReset();

    // Default happy-path setup
    mockUserModuleAssignmentRepository.find.mockResolvedValue([]);
    mockActionTokenRepository.findOne.mockResolvedValue(null);
    mockRefreshTokenRepository.count.mockResolvedValue(0);
    mockRefreshTokenRepository.create.mockImplementation((data: Partial<RefreshToken>) => ({
      ...data,
    }));
    mockRefreshTokenRepository.save.mockImplementation((token: Partial<RefreshToken>) =>
      Promise.resolve(token),
    );
    mockRefreshTokenRepository.createQueryBuilder.mockReturnValue({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    });
    mockTransactionManager.getRepository.mockImplementation((entity: unknown) => {
      if (entity === RefreshToken) return mockRefreshTokenRepository;
      if (entity === User) return mockUserRepository;
      if (entity === Tenant) return mockTenantRepository;
      if (entity === Invitation) return mockInvitationRepository;
      if (entity === ActionToken) return mockActionTokenRepository;
      return {};
    });
    mockDataSource.transaction.mockImplementation(
      async (callback: (manager: typeof mockTransactionManager) => Promise<unknown>) =>
        callback(mockTransactionManager),
    );
    // Postgres UPDATE…RETURNING tuple shape [rows, affected] (ORPHAN-HIGH-318).
    mockDataSource.query.mockResolvedValue([[{ failedLoginAttempts: 3, lockedUntil: null }], 1]);
    mockSessionManager.countActiveSessions.mockResolvedValue(0);
    mockSessionManager.revokeAllSessions.mockResolvedValue(undefined);
    mockTokenBlacklist.isBlacklisted.mockResolvedValue(false);
    mockUserTokenRevocation.isTokenValid.mockResolvedValue(true);
    mockDurableAccessTokenInvalidation.enqueue.mockResolvedValue(undefined);
    mockDurableAccessTokenInvalidation.applyImmediately.mockResolvedValue(undefined);
    mockDurableUserTokenInvalidation.enqueue.mockResolvedValue(undefined);
    mockDurableUserTokenInvalidation.applyImmediately.mockResolvedValue(undefined);
    mockTokenService.generateTokens.mockImplementation((user: User) =>
      Promise.resolve({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        user,
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: getRepositoryToken(RefreshToken), useValue: mockRefreshTokenRepository },
        { provide: getRepositoryToken(Invitation), useValue: mockInvitationRepository },
        { provide: getRepositoryToken(ActionToken), useValue: mockActionTokenRepository },
        {
          provide: getRepositoryToken(UserModuleAssignment),
          useValue: mockUserModuleAssignmentRepository,
        },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepository },
        { provide: DataSource, useValue: mockDataSource },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: 'EVENT_BUS', useValue: mockEventBus },
        {
          provide: BestEffortEventPublisher,
          useValue: new BestEffortEventPublisher(mockEventBus),
        },
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: TokenService, useValue: mockTokenService },
        {
          provide: DurableAccessTokenInvalidationService,
          useValue: mockDurableAccessTokenInvalidation,
        },
        {
          provide: DurableUserTokenInvalidationService,
          useValue: mockDurableUserTokenInvalidation,
        },
        { provide: MfaService, useValue: mockMfaService },
        { provide: TimingSafeService, useValue: mockTimingSafe },
        { provide: SESSION_MANAGER, useValue: mockSessionManager },
        { provide: TOKEN_BLACKLIST, useValue: mockTokenBlacklist },
        { provide: USER_TOKEN_REVOCATION, useValue: mockUserTokenRevocation },
        // DEPLOY-CRITICAL-007: AuthenticationService injects BypassRlsService
        // so the SUPER_ADMIN login path can create refresh tokens on a
        // tenantId=NULL row (which cannot satisfy tenant_isolation_policy
        // regardless of app.current_tenant). The mock forwards through
        // withBypass so the unit test exercises the SAME call chain as
        // production — just without the audit WARN log.
        {
          provide: BypassRlsService,
          useValue: {
            withBypass: jest.fn(
              async <T>(_op: string, cb: () => Promise<T> | T): Promise<T> => cb(),
            ),
            withBypassSync: <T>(_op: string, cb: () => T): T => cb(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthenticationService>(AuthenticationService);
    bypassRlsMock = module.get<BypassRlsService>(BypassRlsService);
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

    it('throws UnauthorizedException on wrong password and increments failedLoginAttempts atomically', async () => {
      const user = createMockUser({ failedLoginAttempts: 2 });
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(createMockTenant());
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);
      // WHY: failed-attempt accounting moved to a single atomic
      // UPDATE ... RETURNING (race-safe under concurrent login failures) —
      // assert the SQL contract instead of the read-modify-write save that
      // production no longer performs. Params: [userId, maxAttempts, lockout].
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('"failedLoginAttempts" = "failedLoginAttempts" + 1'),
        ['user-uuid-123', 5, expect.any(Date)],
      );
    });

    it('ORPHAN-HIGH-318: audit reason carries the REAL attempt count from the driver tuple (regression: misread reported "attempt 0")', async () => {
      const user = createMockUser({ failedLoginAttempts: 2 });
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(createMockTenant());
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);
      // Below threshold: attempts 3 of 5, no lock set.
      mockDataSource.query.mockResolvedValue([[{ failedLoginAttempts: 3, lockedUntil: null }], 1]);

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);

      // The failed-password audit event must report the count RETURNING gave
      // us — the shipped bug read the tuple as a row and always logged 0.
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'LOGIN_FAILED_INVALID_PASSWORD',
          details: expect.objectContaining({
            reason: 'Invalid password (attempt 3)',
          }),
        }),
      );
      // Below the threshold no lockout event may fire.
      expect(mockAuditLogService.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ACCOUNT_LOCKED' }),
      );
    });

    it('ORPHAN-HIGH-318: emits the CRITICAL ACCOUNT_LOCKED audit event on the threshold-crossing attempt (regression: never fired)', async () => {
      const user = createMockUser({ failedLoginAttempts: 4 });
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(createMockTenant());
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);
      // Threshold crossed: attempts 5 of 5, lockedUntil set by the CASE arm.
      mockDataSource.query.mockResolvedValue([
        [{ failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 30 * 60 * 1000) }],
        1,
      ]);

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);

      // The brute-force detection signal: CRITICAL severity, lockout reason.
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ACCOUNT_LOCKED',
          severity: 'critical',
          details: expect.objectContaining({
            reason: expect.stringContaining('Account locked after 5 failed attempts'),
          }),
        }),
      );
      // And the failed-password event carries the real terminal count.
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'LOGIN_FAILED_INVALID_PASSWORD',
          details: expect.objectContaining({
            reason: 'Invalid password (attempt 5)',
          }),
        }),
      );
      // ORPHAN-MEDIUM-320: the owner-facing lockout event rides the
      // best-effort path (mockEventBus backs BestEffortEventPublisher).
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'UserAccountLocked',
          userId: 'user-uuid-123',
          failedAttempts: 5,
          lockedUntil: expect.any(String),
        }),
      );
    });

    it('ORPHAN-MEDIUM-320: does NOT emit UserAccountLocked below the threshold', async () => {
      const user = createMockUser({ failedLoginAttempts: 1 });
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(createMockTenant());
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);
      mockDataSource.query.mockResolvedValue([[{ failedLoginAttempts: 2, lockedUntil: null }], 1]);

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);

      expect(mockEventBus.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'UserAccountLocked' }),
      );
    });

    it('SEC-LOW-001(c): casts the lockout deadline to timestamptz (not tz-stripping timestamp)', async () => {
      const user = createMockUser({ failedLoginAttempts: 2 });
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(createMockTenant());
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);

      // WHY: users.lockedUntil is TIMESTAMP WITH TIME ZONE and $3 is a JS Date
      // (an absolute instant). ::timestamp (without tz) drops the offset and
      // reinterprets the lockout deadline under the DB session TimeZone, drifting
      // the lockout window on non-UTC sessions. The cast MUST be ::timestamptz.
      const lockoutQueryCall = mockDataSource.query.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('"failedLoginAttempts" = "failedLoginAttempts" + 1'),
      );
      expect(lockoutQueryCall).toBeDefined();
      const sql = lockoutQueryCall![0] as string;
      expect(sql).toMatch(/\$3::timestamptz/);
      // Reject a tz-stripping ::timestamp cast (negative lookahead so the legit
      // ::timestamptz match does not satisfy this assertion).
      expect(sql).not.toMatch(/\$3::timestamp(?!tz)/);
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

    // MT-HIGH-003: login is gated by the fail-closed allow-list (ACTIVE only).
    // The old block-list rejected just SUSPENDED + CANCELLED, so every other
    // non-operational status authenticated. Pin that EVERY non-ACTIVE status
    // is now blocked — a regression that re-opens the slip-through fails here.
    it.each([
      TenantStatus.PENDING,
      TenantStatus.PROVISIONING,
      TenantStatus.PROVISIONING_FAILED,
      TenantStatus.SUSPENDED,
      TenantStatus.DEACTIVATED,
      TenantStatus.CANCELLED,
      TenantStatus.ARCHIVED,
      TenantStatus.PURGED,
    ])('blocks login when tenant status is %s', async (status) => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(createMockTenant({ status }));
      mockBcryptCompare.mockResolvedValue(true);

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);
    });

    it('allows an ACTIVE tenant past the status gate', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(
        createMockTenant({ status: TenantStatus.ACTIVE }),
      );
      mockBcryptCompare.mockResolvedValue(true);
      mockUserRepository.save.mockResolvedValue(user);

      const result = await service.login(validInput, '127.0.0.1', 'test-agent');
      expect(result.accessToken).toBeDefined();
    });

    it('throws UnauthorizedException for pending-invitation user', async () => {
      const user = createMockUser({ isPendingInvitation: () => true });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.login(validInput)).rejects.toThrow(UnauthorizedException);
    });

    it('delegates session-limit enforcement to TokenService on login', async () => {
      const user = createMockUser();
      const tenant = createMockTenant();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTenantRepository.findOne.mockResolvedValue(tenant);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);
      mockUserRepository.save.mockResolvedValue(user);

      const result = await service.login(validInput, '127.0.0.1', 'test-agent');

      // WHY: concurrent-session control moved into TokenService.generateTokens
      // (sessionManager.enforceSessionLimit evicts the oldest session instead
      // of rejecting the login). The login-level contract is therefore
      // delegation; the eviction behaviour itself is asserted in
      // token.service.spec.ts where the collaborator lives.
      expect(result.accessToken).toBe('mock-access-token');
      // ORPHAN-LOW-135: login threads the rememberMe choice (default false) into issuance.
      expect(mockTokenService.generateTokens).toHaveBeenCalledWith(
        user,
        '127.0.0.1',
        'test-agent',
        {
          rememberMe: false,
        },
      );
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
    it('discovers the plaintext owner, then locks User before the authoritative token row', async () => {
      const user = createMockUser();
      const storedToken = Object.assign(new RefreshToken(), {
        id: 'refresh-token-id',
        token: 'valid-token',
        userId: user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        isRevoked: false,
        rememberMe: false,
      });
      const queryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(storedToken),
      };
      mockRefreshTokenRepository.findOne.mockResolvedValue(storedToken);
      mockRefreshTokenRepository.createQueryBuilder.mockReturnValue(queryBuilder);
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.refreshToken('valid-token')).resolves.toMatchObject({
        accessToken: 'mock-access-token',
      });

      expect(mockRefreshTokenRepository.findOne).toHaveBeenCalledWith({
        select: { userId: true },
        where: { token: 'valid-token' },
      });
      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: { id: user.id },
        lock: { mode: 'pessimistic_write' },
      });
      expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(mockRefreshTokenRepository.findOne.mock.invocationCallOrder[0]).toBeLessThan(
        mockUserRepository.findOne.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
      );
      expect(mockUserRepository.findOne.mock.invocationCallOrder[0]).toBeLessThan(
        queryBuilder.getOne.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
      );
    });

    it('throws UnauthorizedException for a token that is not in the store', async () => {
      mockRefreshTokenRepository.findOne = jest.fn().mockResolvedValue(null);

      await expect(service.refreshToken('invalid-token')).rejects.toThrow(UnauthorizedException);
    });

    // ROOT CAUSE regression guard (logout on every refresh): auth.refresh_tokens
    // is RLS-protected by tenant_isolation_policy, but a refresh request carries
    // NO tenant context (the token IS the pre-tenant credential). Without an RLS
    // bypass the lookup returns ZERO rows under the auth_service DB role and the
    // user is logged out on each refresh. The rotation MUST run under the audited
    // BypassRlsService.withBypass with this exact label.
    it('runs the refresh-token rotation under an audited RLS bypass', async () => {
      mockRefreshTokenRepository.findOne = jest.fn().mockResolvedValue(null);

      await expect(service.refreshToken('any-token')).rejects.toThrow(UnauthorizedException);

      expect(bypassRlsMock.withBypass).toHaveBeenCalledWith(
        'auth-service:refresh-token-rotation',
        expect.any(Function),
      );
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
      mockUserRepository.findOne.mockResolvedValue(createMockUser());
      mockRefreshTokenRepository.update = jest.fn().mockResolvedValue({ affected: 1 });

      const result = await service.logout('user-uuid-123');

      expect(result).toBe(true);
      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-uuid-123' },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('durably invalidates the access token when a JTI is provided', async () => {
      mockUserRepository.findOne.mockResolvedValue(createMockUser());
      mockRefreshTokenRepository.update = jest.fn().mockResolvedValue({ affected: 1 });
      const accessExpiry = new Date(Date.now() + 900000);

      await service.logout('user-uuid-123', 'jti-123', accessExpiry);

      expect(mockDurableAccessTokenInvalidation.enqueue).toHaveBeenCalledWith(
        mockTransactionManager,
        expect.objectContaining({
          targetJti: 'jti-123',
          tenantId: 'tenant-uuid-123',
          expiresAt: accessExpiry,
          reason: 'user_logout',
        }),
      );
      const intent = mockDurableAccessTokenInvalidation.enqueue.mock.calls[0]?.[1];
      expect(mockDurableAccessTokenInvalidation.applyImmediately).toHaveBeenCalledWith(intent);
    });

    it('fails closed before commit when logout invalidation cannot be enqueued', async () => {
      mockUserRepository.findOne.mockResolvedValue(createMockUser());
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 1 });
      mockDurableAccessTokenInvalidation.enqueue.mockRejectedValueOnce(
        new Error('outbox unavailable'),
      );

      await expect(
        service.logout('user-uuid-123', 'jti-123', new Date(Date.now() + 900000)),
      ).rejects.toThrow('outbox unavailable');

      expect(mockDurableAccessTokenInvalidation.applyImmediately).not.toHaveBeenCalled();
      expect(mockSessionManager.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('returns success after commit when immediate logout effects fail', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      mockUserRepository.findOne.mockResolvedValue(createMockUser());
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 1 });
      mockDurableAccessTokenInvalidation.applyImmediately.mockRejectedValueOnce(
        new TypeError('redis unavailable for jti-123'),
      );
      mockSessionManager.revokeAllSessions.mockRejectedValueOnce(
        new RangeError('session store unavailable for user-uuid-123'),
      );

      await expect(
        service.logout('user-uuid-123', 'jti-123', new Date(Date.now() + 900000)),
      ).resolves.toBe(true);

      expect(mockDurableAccessTokenInvalidation.enqueue).toHaveBeenCalledTimes(1);
      const [serializedLog] = errorSpy.mock.calls.at(-1) ?? [];
      expect(JSON.parse(String(serializedLog))).toEqual({
        event: 'post_commit_security_effect_failed',
        operation: 'user_logout',
        failedCount: 2,
        effectCount: 2,
        failedEffectTypes: ['access_token_invalidation', 'session_revocation'],
        errorTypes: ['TypeError', 'RangeError'],
      });
      expect(String(serializedLog)).not.toContain('jti-123');
      expect(String(serializedLog)).not.toContain('user-uuid-123');
      expect(String(serializedLog)).not.toContain('unavailable');
      errorSpy.mockRestore();
    });
  });

  describe('logoutAllDevices()', () => {
    it('fails closed before commit when user-wide invalidation cannot be enqueued', async () => {
      mockUserRepository.findOne.mockResolvedValue(createMockUser());
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 3 });
      mockDurableUserTokenInvalidation.enqueue.mockRejectedValueOnce(
        new Error('outbox unavailable'),
      );

      await expect(service.logoutAllDevices('user-uuid-123')).rejects.toThrow('outbox unavailable');

      expect(mockDurableUserTokenInvalidation.applyImmediately).not.toHaveBeenCalled();
      expect(mockSessionManager.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('returns the committed count when immediate all-device effects fail', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      mockUserRepository.findOne.mockResolvedValue(createMockUser());
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 3 });
      mockDurableUserTokenInvalidation.applyImmediately.mockRejectedValueOnce(
        new TypeError('redis unavailable for user-uuid-123'),
      );
      mockSessionManager.revokeAllSessions.mockRejectedValueOnce(
        new RangeError('session store unavailable for user-uuid-123'),
      );

      await expect(service.logoutAllDevices('user-uuid-123')).resolves.toBe(3);

      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-uuid-123' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(mockDurableUserTokenInvalidation.enqueue).toHaveBeenCalledTimes(1);
      const [serializedLog] = errorSpy.mock.calls.at(-1) ?? [];
      expect(JSON.parse(String(serializedLog))).toEqual({
        event: 'post_commit_security_effect_failed',
        operation: 'logout_all_devices',
        failedCount: 2,
        effectCount: 2,
        failedEffectTypes: ['user_token_invalidation', 'session_revocation'],
        errorTypes: ['TypeError', 'RangeError'],
      });
      expect(String(serializedLog)).not.toContain('user-uuid-123');
      expect(String(serializedLog)).not.toContain('unavailable');
      errorSpy.mockRestore();
    });
  });

  // ==========================================================================
  // validateToken() — token-type symmetry (SEC-LOW-001(a))
  // ==========================================================================
  describe('validateToken()', () => {
    it('SEC-LOW-001(a): rejects an mfa_challenge token on the bearer introspection surface', async () => {
      // SYMMETRY: generateMfaChallenge mints type:'mfa_challenge'. enforceAccessTokenType
      // (real, not mocked here) requires type === 'access' on every bearer surface,
      // so a valid-but-MFA token must be reported invalid by validateToken() — it
      // can never be replayed as an access token even though it is signed by the
      // same keypair.
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        purpose: 'mfa_verification',
        jti: 'mock-jti',
      });

      const result = await service.validateToken('an-mfa-challenge-token');

      expect(result.valid).toBe(false);
      expect(result.payload).toBeUndefined();
    });

    it('accepts a genuine access token', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({
        sub: 'user-uuid-123',
        type: 'access',
        role: Role.MODULE_USER,
        roles: [Role.MODULE_USER],
        tenantId: 'tenant-uuid-123',
        jti: 'mock-jti',
        iat: Math.floor(Date.now() / 1000),
      });

      const result = await service.validateToken('a-real-access-token');

      expect(result.valid).toBe(true);
      expect(result.payload?.type).toBe('access');
    });
  });

  describe('me (reports the JWT effective tenant)', () => {
    it('reports the JWT tenant claim over the DB record (the token is the session SSoT)', async () => {
      mockUserRepository.findOne.mockResolvedValue(
        createMockUser({ id: 'admin', role: Role.SUPER_ADMIN, tenantId: null }),
      );
      const result = await service.me('admin', 'tenant-uuid-123');
      expect(result.user.tenantId).toBe('tenant-uuid-123');
    });

    it('leaves the tenant null for a platform SUPER_ADMIN (null token tenant)', async () => {
      mockUserRepository.findOne.mockResolvedValue(
        createMockUser({ id: 'admin', role: Role.SUPER_ADMIN, tenantId: null }),
      );
      const result = await service.me('admin', null);
      expect(result.user.tenantId).toBeNull();
    });
  });

  describe('decodeRefreshTokenTransport (logout-on-refresh root cause)', () => {
    const USER = '8025339a-e6c7-46df-b65a-dcf4f010b861';
    const RANDOM = '7acbcb0bf6efac13cbc4adad5bf7598e';

    it('decodes a URL-encoded ":" ("%3A") back to the canonical {userId}:{random}', () => {
      expect(decodeRefreshTokenTransport(`${USER}%3A${RANDOM}`)).toBe(`${USER}:${RANDOM}`);
    });

    it('is idempotent for an already-canonical token (no "%")', () => {
      const canonical = `${USER}:${RANDOM}`;
      expect(decodeRefreshTokenTransport(canonical)).toBe(canonical);
    });

    it('falls back to the raw value on a malformed escape (never throws)', () => {
      const malformed = `${USER}%ZZ${RANDOM}`;
      expect(decodeRefreshTokenTransport(malformed)).toBe(malformed);
    });
  });

  // confirmUserPassword backs the request.auth.verifyPassword responder that
  // gates messaging's irreversible GDPR anonymizeMyData. It is a
  // re-confirmation, NOT a login — these tests pin that distinction.
  describe('confirmUserPassword() — GDPR re-confirmation (no login side effects)', () => {
    it('returns true on a matching password WITHOUT touching lockout state', async () => {
      const user = createMockUser({ failedLoginAttempts: 3 });
      mockUserRepository.findOne.mockResolvedValue(user);
      mockBcryptCompare.mockResolvedValue(true);

      const result = await service.confirmUserPassword('user-uuid-123', 'correct');

      expect(result).toBe(true);
      // The lockout accounting UPDATE (dataSource.query) must NEVER run — a
      // confirmation is not a login and must not lock or reset the account.
      expect(mockDataSource.query).not.toHaveBeenCalled();
      expect(user.failedLoginAttempts).toBe(3); // unchanged
    });

    it('returns false on a wrong password WITHOUT incrementing failedLoginAttempts', async () => {
      const user = createMockUser({ failedLoginAttempts: 2 });
      mockUserRepository.findOne.mockResolvedValue(user);
      mockBcryptCompare.mockResolvedValue(false);

      const result = await service.confirmUserPassword('user-uuid-123', 'wrong');

      expect(result).toBe(false);
      expect(mockDataSource.query).not.toHaveBeenCalled();
      expect(user.failedLoginAttempts).toBe(2); // NOT incremented — no lockout path
    });

    it('returns false for an unknown user (timing-equalized dummy verify, no save)', async () => {
      mockUserRepository.findOne.mockResolvedValue(null);
      mockBcryptCompare.mockResolvedValue(false);

      const result = await service.confirmUserPassword('missing-user', 'whatever');

      expect(result).toBe(false);
      // The dummy-hash verify runs the same pipeline (enumeration-safe); no
      // user row exists to persist.
      expect(mockBcryptCompare).toHaveBeenCalled();
      expect(mockUserRepository.save).not.toHaveBeenCalled();
    });
  });
});
