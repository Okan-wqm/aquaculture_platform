/**
 * RBAC-HIGH-007 — refresh enforces the tenant-status allow-list.
 *
 * Login has enforced `isLoginAllowed` (ACTIVE only, MT-HIGH-003) since the
 * tenant-status machine landed — but refresh did NOT, so suspending /
 * deactivating / cancelling a tenant only blocked NEW logins: every
 * logged-in user kept silently ROTATING fresh tokens for the refresh-token
 * lifetime (days). These tests pin the cure on the production (hashed)
 * refresh path: a non-operational tenant's refresh is rejected BEFORE
 * rotation, an ACTIVE tenant refreshes normally, and a platform user
 * (tenantId null) is exempt exactly like login.
 */
import { Role } from '@aquaculture/backend-common/decorators';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import {
  TimingSafeService,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
  SecurityEventService,
} from '@aquaculture/backend-common/security';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { TenantStatus } from '@platform/event-contracts';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { ActionToken } from '../entities/action-token.entity';
import { Invitation } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { User } from '../entities/user.entity';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';
import { AuthenticationService } from '../services/authentication.service';
import { DurableAccessTokenInvalidationService } from '../services/durable-access-token-invalidation.service';
import { DurableUserTokenInvalidationService } from '../services/durable-user-token-invalidation.service';
import { MfaService } from '../services/mfa.service';
import { LockedAuthContext } from '../services/credential-state';
import { TokenService } from '../services/token.service';

// bcryptjs sealed-namespace → spy-able wrappers (same pattern as the sibling specs).
jest.mock('bcryptjs', () => {
  const actual = jest.requireActual<typeof bcrypt>('bcryptjs');
  const promiseCompare: (d: string, e: string) => Promise<boolean> = actual.compare;
  const promiseHash: (d: string, s: string | number) => Promise<string> = actual.hash;
  return { ...actual, compare: jest.fn(promiseCompare), hash: jest.fn(promiseHash) };
});
const mockCompare = jest.mocked<(d: string, e: string) => Promise<boolean>>(bcrypt.compare);

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';

describe('AuthenticationService — tenant-status refresh gate (RBAC-HIGH-007)', () => {
  let service: AuthenticationService;

  const mockUserRepository = { findOne: jest.fn() };
  const mockTenantFindOne = jest.fn();
  const mockTokenService = {
    generateTokensInContext: jest.fn(async (context: LockedAuthContext) => {
      context.assertSessionAdmission();
      return { accessToken: 'a', refreshToken: 'r' };
    }),
  };
  const mockTokenSave = jest.fn();

  // The live (unrevoked) token the client presents; bcrypt.compare matches it.
  const liveToken = {
    id: 'live-token-id',
    userId: USER_ID,
    familyId: null,
    token: '$2a$12$hashedlive',
    isRevoked: false,
    rememberMe: false,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    ipAddress: null,
    userAgent: null,
  };

  const buildRefreshTokenRepo = (): Record<string, unknown> => {
    const qb: Record<string, unknown> = {
      setLock: jest.fn(() => qb),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      take: jest.fn(() => qb),
      // Fresh clone per scan: successful rotation MUTATES the matched row
      // (isRevoked = true), and a shared fixture would leak that into the
      // next test as a spurious "already revoked" rejection.
      getMany: jest.fn(() => Promise.resolve([{ ...liveToken }])),
    };
    return {
      save: mockTokenSave,
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => qb),
    };
  };

  const mockManager = {
    queryRunner: { isTransactionActive: false },
    withRepository: jest.fn((repository: object) => repository),
    findOne: jest.fn((entity: unknown, options: unknown) => {
      if (entity === User) return mockUserRepository.findOne(options);
      if (entity === Tenant) return mockTenantFindOne(options);
      throw new Error('Unexpected identity entity');
    }),
    query: jest.fn(),
  };

  const mockDataSource = {
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => {
      mockManager.queryRunner.isTransactionActive = true;
      try {
        return await cb(mockManager);
      } finally {
        mockManager.queryRunner.isTransactionActive = false;
      }
    }),
    query: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, def?: unknown) => {
      const config: Record<string, unknown> = {
        HASH_REFRESH_TOKENS: true, // PRODUCTION default — routes through refreshTokenWithHash
        JWT_EXPIRES_IN: '15m',
        MAX_FAILED_ATTEMPTS: 5,
        LOCKOUT_DURATION_MINUTES: 30,
        MIN_LOGIN_DURATION_MS: 0,
      };
      return config[key] ?? def;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCompare.mockResolvedValue(true); // the presented token matches the live row
    mockTokenSave.mockImplementation((token: unknown) => Promise.resolve(token));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        { provide: OutboxPublisher, useValue: { enqueue: jest.fn() } },
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: getRepositoryToken(RefreshToken), useValue: buildRefreshTokenRepo() },
        { provide: getRepositoryToken(Invitation), useValue: {} },
        { provide: getRepositoryToken(ActionToken), useValue: {} },
        { provide: getRepositoryToken(UserModuleAssignment), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(Tenant), useValue: { findOne: mockTenantFindOne } },
        // ADR-046: the MFA-enrollment gate counts the user's registered
        // WebAuthn credentials, so AuthenticationService injects the repo.
        // Zero credentials keeps these suites on their existing paths.
        {
          provide: getRepositoryToken(WebAuthnCredential),
          useValue: { count: jest.fn().mockResolvedValue(0) },
        },
        { provide: DataSource, useValue: mockDataSource },
        { provide: JwtService, useValue: { signAsync: jest.fn() } },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: 'EVENT_BUS', useValue: { publish: jest.fn() } },
        {
          provide: BestEffortEventPublisher,
          useValue: new BestEffortEventPublisher({ publish: jest.fn() }),
        },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        { provide: TokenService, useValue: mockTokenService },
        {
          provide: DurableAccessTokenInvalidationService,
          useValue: { enqueue: jest.fn(), applyImmediately: jest.fn() },
        },
        {
          provide: DurableUserTokenInvalidationService,
          useValue: { enqueue: jest.fn(), applyImmediately: jest.fn() },
        },
        { provide: MfaService, useValue: { isMfaAvailable: jest.fn() } },
        { provide: TimingSafeService, useValue: { ensureMinDuration: jest.fn() } },
        {
          provide: SESSION_MANAGER,
          useValue: {
            enforceSessionLimit: jest.fn(),
            revokeAllSessions: jest.fn(),
            createSession: jest.fn(),
          },
        },
        {
          provide: TOKEN_BLACKLIST,
          useValue: { add: jest.fn(), isBlacklisted: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: USER_TOKEN_REVOCATION,
          useValue: {
            revokeUserTokens: jest.fn(),
            isTokenValid: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: SecurityEventService, useValue: { publishSuspiciousActivity: jest.fn() } },
        {
          provide: BypassRlsService,
          useValue: {
            withBypass: async <T>(_op: string, cb: () => Promise<T> | T): Promise<T> => cb(),
            withBypassSync: <T>(_op: string, cb: () => T): T => cb(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthenticationService>(AuthenticationService);
  });

  const presentedToken = `${USER_ID}:${'a'.repeat(128)}`;

  function tenantUser(tenantId: string | null): User {
    return Object.assign(new User(), {
      id: USER_ID,
      email: 'user@farm.test',
      isActive: true,
      tenantId,
      credentialVersion: 1,
      role: tenantId ? Role.MODULE_USER : Role.SUPER_ADMIN,
    });
  }

  it.each([
    TenantStatus.SUSPENDED,
    TenantStatus.DEACTIVATED,
    TenantStatus.CANCELLED,
    TenantStatus.ARCHIVED,
  ])(
    'rejects refresh and does NOT rotate when the tenant is %s (fail-closed allow-list)',
    async (status) => {
      mockUserRepository.findOne.mockResolvedValue(tenantUser(TENANT_ID));
      mockTenantFindOne.mockResolvedValue({ id: TENANT_ID, status });

      await expect(service.refreshToken(presentedToken)).rejects.toThrow(UnauthorizedException);

      // The gate fires BEFORE rotation: no new tokens minted.
      expect(mockTokenService.generateTokensInContext).not.toHaveBeenCalled();
    },
  );

  it('refreshes normally for an ACTIVE tenant', async () => {
    mockUserRepository.findOne.mockResolvedValue(tenantUser(TENANT_ID));
    mockTenantFindOne.mockResolvedValue({ id: TENANT_ID, status: TenantStatus.ACTIVE });

    await expect(service.refreshToken(presentedToken)).resolves.toEqual(
      expect.objectContaining({ accessToken: 'a' }),
    );
    expect(mockTokenService.generateTokensInContext).toHaveBeenCalledTimes(1);
  });

  it('exempts platform users (tenantId null) exactly like login', async () => {
    mockUserRepository.findOne.mockResolvedValue(tenantUser(null));

    await expect(service.refreshToken(presentedToken)).resolves.toEqual(
      expect.objectContaining({ accessToken: 'a' }),
    );
    expect(mockTenantFindOne).not.toHaveBeenCalled();
  });
});
