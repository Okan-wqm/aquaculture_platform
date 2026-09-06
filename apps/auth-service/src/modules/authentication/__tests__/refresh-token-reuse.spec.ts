import { Role } from '@aquaculture/backend-common/decorators';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import {
  SecurityEventService,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
} from '@aquaculture/backend-common/security';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';
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
import { ActionTokenResolver } from '../services/action-token-resolver.service';
import { AuthenticationService } from '../services/authentication.service';
import { DurableAccessTokenInvalidationService } from '../services/durable-access-token-invalidation.service';
import { DurableUserTokenInvalidationService } from '../services/durable-user-token-invalidation.service';
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';

jest.mock('bcryptjs', () => {
  const actual = jest.requireActual<typeof bcrypt>('bcryptjs');
  const compare: (data: string, encrypted: string) => Promise<boolean> = actual.compare;
  return { ...actual, compare: jest.fn(compare) };
});

const mockCompare = jest.mocked<(data: string, encrypted: string) => Promise<boolean>>(
  bcrypt.compare,
);

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN_ID_HEX = TOKEN_ID.replaceAll('-', '');
const V2_SECRET = `${TOKEN_ID_HEX}${'a'.repeat(128)}`;
const V2_TRANSPORT = `${USER_ID}:${V2_SECRET}`;
const LEGACY_SECRET = 'b'.repeat(128);
const LEGACY_TRANSPORT = `${USER_ID}:${LEGACY_SECRET}`;

interface RefreshQueryBuilderDouble {
  setLock: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  take: jest.Mock;
  getOne: jest.Mock;
  getMany: jest.Mock;
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const mockOutboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

describe('AuthenticationService refresh-token reuse containment', () => {
  let service: AuthenticationService;
  let exactToken: RefreshToken | null;
  let activeTokens: RefreshToken[];
  let revokedTokens: RefreshToken[];
  let containmentClaimed: boolean;
  let transactionCommitted: boolean;
  let boundedScanCount: number;
  let queryBuilder: RefreshQueryBuilderDouble;

  const refreshUpdate = jest.fn(
    (criteria: Record<string, unknown>): Promise<{ affected: number }> => {
      if ('id' in criteria) {
        if (containmentClaimed) return Promise.resolve({ affected: 0 });
        containmentClaimed = true;
      }
      return Promise.resolve({ affected: 1 });
    },
  );
  const refreshSave = jest.fn().mockResolvedValue(undefined);
  const userRepository = {
    findOne: jest.fn().mockResolvedValue({
      id: USER_ID,
      tenantId: TENANT_ID,
      role: 'MODULE_USER',
      isActive: true,
    }),
  };
  const durableUserInvalidation = {
    enqueue: jest.fn().mockImplementation(() => {
      expect(transactionCommitted).toBe(false);
      return Promise.resolve();
    }),
    applyImmediately: jest.fn().mockImplementation(() => {
      expect(transactionCommitted).toBe(true);
      return Promise.resolve();
    }),
  };
  const sessionManager = {
    enforceSessionLimit: jest.fn(),
    createSession: jest.fn(),
    revokeAllSessions: jest.fn().mockResolvedValue(1),
  };
  const securityEvents = {
    publishSuspiciousActivity: jest.fn().mockResolvedValue(undefined),
  };
  const tokenService = { generateTokensInContext: jest.fn() };

  const suspectToken = Object.assign(new RefreshToken(), {
    id: '44444444-4444-4444-8444-444444444444',
    tokenId: TOKEN_ID,
    userId: USER_ID,
    tenantId: TENANT_ID,
    familyId: FAMILY_ID,
    token: 'suspect-hash',
    isRevoked: true,
    reuseContainedAt: null,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    revokedAt: new Date('2026-06-10T00:00:00.000Z'),
    revokedReason: 'Token refreshed',
    rememberMe: false,
    ipAddress: '203.0.113.9',
    userAgent: 'agent',
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    exactToken = suspectToken;
    activeTokens = [];
    revokedTokens = [suspectToken];
    containmentClaimed = false;
    transactionCommitted = false;
    boundedScanCount = 0;
    userRepository.findOne.mockResolvedValue(
      Object.assign(new User(), {
        id: USER_ID,
        tenantId: TENANT_ID,
        role: Role.MODULE_USER,
        isActive: true,
        credentialVersion: 1,
      }),
    );
    refreshUpdate.mockImplementation(
      (criteria: Record<string, unknown>): Promise<{ affected: number }> => {
        if ('id' in criteria) {
          if (containmentClaimed) return Promise.resolve({ affected: 0 });
          containmentClaimed = true;
        }
        return Promise.resolve({ affected: 1 });
      },
    );
    mockCompare.mockImplementation((_plain, hash) => Promise.resolve(hash === suspectToken.token));

    queryBuilder = {
      setLock: jest.fn(() => queryBuilder),
      where: jest.fn(() => queryBuilder),
      andWhere: jest.fn(() => queryBuilder),
      orderBy: jest.fn(() => queryBuilder),
      take: jest.fn(() => queryBuilder),
      getOne: jest.fn(() => Promise.resolve(exactToken)),
      getMany: jest.fn(() => {
        boundedScanCount += 1;
        return Promise.resolve(boundedScanCount % 2 === 1 ? activeTokens : revokedTokens);
      }),
    };
    const refreshRepository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
      update: refreshUpdate,
      save: refreshSave,
      count: jest.fn().mockResolvedValue(1),
    };
    const tenantRepository = {
      findOne: jest.fn().mockResolvedValue({ id: TENANT_ID, status: 'ACTIVE' }),
    };
    const manager = {
      queryRunner: { isTransactionActive: false },
      withRepository: jest.fn((repository: object) => repository),
      findOne: jest.fn((entity: unknown, options: { select?: object }) => {
        if (entity === Tenant) return tenantRepository.findOne(options);
        if (entity === User) {
          if (options.select) return Promise.resolve({ id: USER_ID, tenantId: TENANT_ID });
          return userRepository.findOne(options);
        }
        throw new Error('Unexpected identity entity');
      }),
      query: jest.fn(),
    };
    const dataSource = {
      transaction: jest.fn(async (work: (activeManager: typeof manager) => Promise<unknown>) => {
        manager.queryRunner.isTransactionActive = true;
        try {
          const result = await work(manager);
          transactionCommitted = true;
          return result;
        } finally {
          manager.queryRunner.isTransactionActive = false;
        }
      }),
    };
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          HASH_REFRESH_TOKENS: true,
          NODE_ENV: 'test',
          MAX_FAILED_ATTEMPTS: 5,
          LOCKOUT_DURATION_MINUTES: 30,
          MIN_LOGIN_DURATION_MS: 0,
        };
        return values[key] ?? defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        ActionTokenResolver,
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshRepository },
        { provide: getRepositoryToken(Invitation), useValue: {} },
        { provide: getRepositoryToken(ActionToken), useValue: {} },
        { provide: getRepositoryToken(UserModuleAssignment), useValue: {} },
        { provide: getRepositoryToken(Tenant), useValue: tenantRepository },
        // ADR-046: the MFA-enrollment gate counts the user's registered
        // WebAuthn credentials, so AuthenticationService injects the repo.
        // Zero credentials keeps these suites on their existing paths.
        {
          provide: getRepositoryToken(WebAuthnCredential),
          useValue: { count: jest.fn().mockResolvedValue(0) },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: JwtService, useValue: {} },
        { provide: ConfigService, useValue: config },
        { provide: BestEffortEventPublisher, useValue: { publish: jest.fn() } },
        { provide: OutboxPublisher, useValue: mockOutboxPublisher },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        { provide: TokenService, useValue: tokenService },
        { provide: MfaService, useValue: {} },
        {
          provide: DurableAccessTokenInvalidationService,
          useValue: { enqueue: jest.fn(), applyImmediately: jest.fn() },
        },
        {
          provide: DurableUserTokenInvalidationService,
          useValue: durableUserInvalidation,
        },
        { provide: SESSION_MANAGER, useValue: sessionManager },
        {
          provide: TOKEN_BLACKLIST,
          useValue: { add: jest.fn(), isBlacklisted: jest.fn() },
        },
        {
          provide: USER_TOKEN_REVOCATION,
          useValue: { revokeUserTokens: jest.fn(), isTokenValid: jest.fn() },
        },
        { provide: SecurityEventService, useValue: securityEvents },
        {
          provide: BypassRlsService,
          useValue: {
            withBypass: async <T>(_operation: string, work: () => Promise<T> | T): Promise<T> =>
              work(),
          },
        },
      ],
    }).compile();
    service = module.get(AuthenticationService);
  });

  it('uses exact tokenId lookup and commits durable containment before post-commit effects', async () => {
    await expect(service.refreshToken(V2_TRANSPORT)).rejects.toThrow(UnauthorizedException);

    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: { id: USER_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(queryBuilder.where).toHaveBeenCalledWith('rt.userId = :userId', {
      userId: USER_ID,
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('rt.tokenId = :tokenId', {
      tokenId: TOKEN_ID,
    });
    expect(queryBuilder.getMany).not.toHaveBeenCalled();
    expect(durableUserInvalidation.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: USER_ID,
        idempotencyKey: `refresh-token-reuse:${suspectToken.id}`,
      }),
    );
    expect(durableUserInvalidation.applyImmediately).toHaveBeenCalledTimes(1);
    expect(sessionManager.revokeAllSessions).toHaveBeenCalledWith(USER_ID);
    expect(userRepository.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      queryBuilder.getOne.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('serializes rotation before concurrent logout-all revokes the replacement', async () => {
    exactToken = Object.assign(new RefreshToken(), suspectToken, {
      isRevoked: false,
      reuseContainedAt: null,
    });
    const payload = { accessToken: 'access' };
    const rotationTokenReadStarted = deferredVoid();
    const releaseRotationTokenRead = deferredVoid();
    const logoutUserLockRequested = deferredVoid();
    const releaseLogoutUserLock = deferredVoid();
    const principal = Object.assign(new User(), {
      id: USER_ID,
      tenantId: TENANT_ID,
      role: Role.MODULE_USER,
      isActive: true,
      credentialVersion: 1,
    });
    const writeOrder: string[] = [];
    let principalLockCount = 0;

    queryBuilder.getOne.mockImplementationOnce(async () => {
      rotationTokenReadStarted.resolve();
      await releaseRotationTokenRead.promise;
      return exactToken;
    });
    userRepository.findOne.mockImplementation(() => {
      principalLockCount += 1;
      if (principalLockCount === 1) {
        return Promise.resolve(principal);
      }
      logoutUserLockRequested.resolve();
      return releaseLogoutUserLock.promise.then(() => principal);
    });
    tokenService.generateTokensInContext.mockImplementationOnce(() => {
      writeOrder.push('replacement-persisted');
      return Promise.resolve(payload);
    });
    refreshUpdate.mockImplementationOnce(() => {
      writeOrder.push('logout-revoked-active');
      return Promise.resolve({ affected: 1 });
    });
    durableUserInvalidation.enqueue.mockResolvedValue(undefined);

    const rotation = service.refreshToken(V2_TRANSPORT);
    await rotationTokenReadStarted.promise;

    const logoutAll = service.logoutAllDevices(USER_ID);
    await logoutUserLockRequested.promise;
    expect(refreshUpdate).not.toHaveBeenCalled();

    releaseRotationTokenRead.resolve();
    await expect(rotation).resolves.toBe(payload);
    expect(writeOrder).toEqual(['replacement-persisted']);

    releaseLogoutUserLock.resolve();
    await expect(logoutAll).resolves.toBe(1);
    expect(writeOrder).toEqual(['replacement-persisted', 'logout-revoked-active']);
    expect(userRepository.findOne).toHaveBeenNthCalledWith(1, {
      where: { id: USER_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(userRepository.findOne).toHaveBeenNthCalledWith(2, {
      where: { id: USER_ID },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('claims one containment across concurrent replays and does not flood effects', async () => {
    const results = await Promise.allSettled([
      service.refreshToken(V2_TRANSPORT),
      service.refreshToken(V2_TRANSPORT),
    ]);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(durableUserInvalidation.enqueue).toHaveBeenCalledTimes(1);
    expect(durableUserInvalidation.applyImmediately).toHaveBeenCalledTimes(1);
    expect(sessionManager.revokeAllSessions).toHaveBeenCalledTimes(1);
    expect(securityEvents.publishSuspiciousActivity).toHaveBeenCalledTimes(1);
  });

  // ─── SEC-MEDIUM-113 (2026-08-23 scan №58): rotation grace window ─────

  it('grace: a JUST-rotated token re-mints once instead of triggering containment', async () => {
    exactToken = Object.assign(new RefreshToken(), suspectToken, {
      id: '55555555-5555-5555-8555-555555555555',
      revokedAt: new Date(Date.now() - 1_000),
      revokedReason: 'Token refreshed',
    });
    tokenService.generateTokensInContext.mockResolvedValue({ accessToken: 'fresh' });

    const result = await service.refreshToken(V2_TRANSPORT);

    expect(result.accessToken).toBe('fresh');
    // The grace claim flipped the reason — the one-shot semantic
    expect(refreshUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ revokedReason: 'Token refreshed' }),
      expect.objectContaining({ revokedReason: 'Token refreshed (grace)' }),
    );
    // NO containment effects fired for a benign two-tab race
    expect(durableUserInvalidation.enqueue).not.toHaveBeenCalled();
    expect(sessionManager.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('grace is one-shot: a second presentation of the same row contains', async () => {
    exactToken = Object.assign(new RefreshToken(), suspectToken, {
      id: '66666666-6666-6666-8666-666666666666',
      revokedAt: new Date(Date.now() - 1_000),
      revokedReason: 'Token refreshed (grace)',
    });

    await expect(service.refreshToken(V2_TRANSPORT)).rejects.toThrow(UnauthorizedException);

    expect(durableUserInvalidation.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'refresh_token_reuse' }),
    );
  });

  it.each(['Password reset', 'Session limit exceeded', 'User logged out'])(
    'terminal history %s cannot reopen a family or contain newer sessions',
    async (revokedReason) => {
      exactToken = Object.assign(new RefreshToken(), suspectToken, {
        revokedReason,
        revokedAt: new Date(),
      });
      await expect(service.refreshToken(V2_TRANSPORT)).rejects.toThrow(UnauthorizedException);
      expect(tokenService.generateTokensInContext).not.toHaveBeenCalled();
      expect(refreshUpdate).not.toHaveBeenCalled();
      expect(durableUserInvalidation.enqueue).not.toHaveBeenCalled();
    },
  );

  it('revoked history without a family cannot contain a newer session', async () => {
    exactToken = Object.assign(new RefreshToken(), suspectToken, { familyId: null });
    await expect(service.refreshToken(V2_TRANSPORT)).rejects.toThrow(UnauthorizedException);
    expect(refreshUpdate).not.toHaveBeenCalled();
    expect(durableUserInvalidation.enqueue).not.toHaveBeenCalled();
  });

  it('an OLD rotation (outside the window) still contains immediately', async () => {
    // revokedAt 2026-06-10 fixture default — far outside the 60s window
    await expect(service.refreshToken(V2_TRANSPORT)).rejects.toThrow(UnauthorizedException);
    expect(tokenService.generateTokensInContext).not.toHaveBeenCalled();
  });

  it('does not contain an expired revoked token', async () => {
    exactToken = Object.assign(new RefreshToken(), suspectToken, {
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    await expect(service.refreshToken(V2_TRANSPORT)).rejects.toThrow(UnauthorizedException);

    expect(refreshUpdate).not.toHaveBeenCalled();
    expect(durableUserInvalidation.enqueue).not.toHaveBeenCalled();
  });

  it('rejects malformed UUID input before opening a transaction', async () => {
    await expect(service.refreshToken(`not-a-uuid:${V2_SECRET}`)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(queryBuilder.getOne).not.toHaveBeenCalled();
  });

  it('keeps a bounded legacy two-part compatibility path', async () => {
    exactToken = null;
    activeTokens = [];
    revokedTokens = [suspectToken];

    await expect(service.refreshToken(LEGACY_TRANSPORT)).rejects.toThrow(UnauthorizedException);

    expect(queryBuilder.getMany).toHaveBeenCalledTimes(2);
    expect(queryBuilder.take).toHaveBeenCalledTimes(2);
    expect(durableUserInvalidation.enqueue).toHaveBeenCalledTimes(1);
  });

  it('rotates an active v2 row and threads the active manager into replacement persistence', async () => {
    exactToken = Object.assign(new RefreshToken(), suspectToken, {
      isRevoked: false,
      reuseContainedAt: null,
    });
    const payload = { accessToken: 'access' };
    tokenService.generateTokensInContext.mockResolvedValue(payload);

    await expect(service.refreshToken(V2_TRANSPORT)).resolves.toBe(payload);

    expect(refreshSave).toHaveBeenCalledWith(expect.objectContaining({ isRevoked: true }));
    expect(tokenService.generateTokensInContext).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ id: USER_ID }),
        manager: expect.anything(),
      }),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        familyId: FAMILY_ID,
        establishSession: false,
      }),
    );
  });

  it('does not run post-commit effects when the transactional family update fails', async () => {
    refreshUpdate.mockImplementation((criteria: Record<string, unknown>) => {
      if ('id' in criteria) return Promise.resolve({ affected: 1 });
      return Promise.reject(new Error('family update failed'));
    });

    await expect(service.refreshToken(V2_TRANSPORT)).rejects.toThrow('family update failed');

    expect(durableUserInvalidation.applyImmediately).not.toHaveBeenCalled();
    expect(sessionManager.revokeAllSessions).not.toHaveBeenCalled();
  });
});
