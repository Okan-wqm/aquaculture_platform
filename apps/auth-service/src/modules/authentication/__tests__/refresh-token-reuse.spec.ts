/**
 * WHY THIS FILE EXISTS (AUDIT-CRITICAL-005 + SEC-MEDIUM-003):
 *
 * Production runs with HASH_REFRESH_TOKENS=true, which routes every refresh
 * through refreshTokenWithHash() → detectRefreshTokenReuse() →
 * revokeTokenFamilyOnReuseDetection(). The pre-existing authentication.service
 * spec forced HASH_REFRESH_TOKENS=false, so the entire production reuse-
 * detection chain — the single most important defence against stolen-refresh-
 * token replay (RFC 6819 §5.2.2) — had ZERO test coverage.
 *
 * These tests exercise the HASHED path and pin the SEC-MEDIUM-003 contract:
 * reuse-detection revokes the suspect token's FAMILY (not the whole user),
 * blacklists the user's access tokens, kills sessions, and emits a
 * SecurityEvent carrying the family-id.
 */
import { BypassRlsService } from '@aquaculture/backend-common/database';
import {
  TimingSafeService,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
  SecurityEventService,
} from '@aquaculture/backend-common/security';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
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
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';

// bcryptjs sealed-namespace → spy-able wrappers (same pattern as the sibling spec).
jest.mock('bcryptjs', () => {
  const actual = jest.requireActual<typeof bcrypt>('bcryptjs');
  const promiseCompare: (d: string, e: string) => Promise<boolean> = actual.compare;
  const promiseHash: (d: string, s: string | number) => Promise<string> = actual.hash;
  return { ...actual, compare: jest.fn(promiseCompare), hash: jest.fn(promiseHash) };
});
const mockCompare = jest.mocked<(d: string, e: string) => Promise<boolean>>(bcrypt.compare);

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID = '22222222-2222-4222-8222-222222222222';

describe('AuthenticationService — refresh-token reuse (hashed path, SEC-MEDIUM-003 / AUDIT-CRITICAL-005)', () => {
  let service: AuthenticationService;

  const mockUserRepository = { findOne: jest.fn() };
  const mockRefreshTokenRepository = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const mockTokenBlacklist = {
    add: jest.fn().mockResolvedValue(undefined),
    isBlacklisted: jest.fn().mockResolvedValue(false),
    blacklistUserTokens: jest.fn().mockResolvedValue(undefined),
  };
  const mockSessionManager = {
    enforceSessionLimit: jest.fn().mockResolvedValue(undefined),
    revokeAllSessions: jest.fn().mockResolvedValue(undefined),
    createSession: jest.fn().mockResolvedValue(undefined),
  };
  const mockSecurityEventService = {
    publishSuspiciousActivity: jest.fn().mockResolvedValue(undefined),
  };
  const mockTokenService = { generateTokens: jest.fn() };

  // The suspect (already-revoked) token the attacker replays.
  const suspectToken = {
    id: 'suspect-token-id',
    userId: USER_ID,
    familyId: FAMILY_ID,
    token: '$2a$12$hashedsuspect',
    isRevoked: true,
    revokedAt: new Date('2026-06-10T00:00:00Z'),
    revokedReason: 'Token refreshed',
    ipAddress: '203.0.113.9',
    userAgent: 'attacker-agent',
  };

  // A RefreshToken repo whose query builder distinguishes the locked
  // active-scan (returns [] → no live match) from the unlocked reuse-scan
  // (returns the revoked suspect token).
  const buildRefreshTokenRepo = (): {
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  } => ({
    update: mockRefreshTokenRepository.update,
    createQueryBuilder: jest.fn(() => {
      const state = { locked: false };
      const qb: Record<string, unknown> = {
        setLock: jest.fn(() => {
          state.locked = true;
          return qb;
        }),
        where: jest.fn(() => qb),
        andWhere: jest.fn(() => qb),
        orderBy: jest.fn(() => qb),
        take: jest.fn(() => qb),
        getMany: jest.fn(() =>
          // locked scan = active tokens (none); unlocked scan = revoked tokens
          Promise.resolve(state.locked ? [] : [suspectToken]),
        ),
      };
      return qb;
    }),
  });

  const mockManager = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === RefreshToken) return buildRefreshTokenRepo();
      if (entity === User) return mockUserRepository;
      return {};
    }),
    query: jest.fn(),
  };

  const mockDataSource = {
    transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => cb(mockManager)),
    query: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, def?: unknown) => {
      const config: Record<string, unknown> = {
        HASH_REFRESH_TOKENS: true, // PRODUCTION default — the whole point
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
    mockCompare.mockReset();
    mockRefreshTokenRepository.update.mockResolvedValue({ affected: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: getRepositoryToken(RefreshToken), useValue: { update: jest.fn() } },
        { provide: getRepositoryToken(Invitation), useValue: {} },
        { provide: getRepositoryToken(ActionToken), useValue: {} },
        { provide: getRepositoryToken(UserModuleAssignment), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(Tenant), useValue: {} },
        { provide: getRepositoryToken(WebAuthnCredential), useValue: { count: jest.fn() } },
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
        { provide: MfaService, useValue: { isMfaAvailable: jest.fn() } },
        { provide: TimingSafeService, useValue: { ensureMinDuration: jest.fn() } },
        { provide: SESSION_MANAGER, useValue: mockSessionManager },
        { provide: TOKEN_BLACKLIST, useValue: mockTokenBlacklist },
        { provide: SecurityEventService, useValue: mockSecurityEventService },
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

  // The replayed token: `{userId}:{random}` shape so the userId prefix scopes
  // the scan, and bcrypt.compare matches ONLY the suspect (revoked) token.
  const replayedToken = `${USER_ID}:replayed-random-hex`;

  it('detects replay of a revoked token and rejects with 401', async () => {
    // No live token matches; the revoked suspect matches on the reuse scan.
    mockCompare.mockImplementation((_plain, hash) =>
      Promise.resolve(hash === suspectToken.token),
    );

    await expect(service.refreshToken(replayedToken)).rejects.toThrow(UnauthorizedException);
  });

  it('revokes ONLY the suspect token FAMILY, not the whole user chain', async () => {
    mockCompare.mockImplementation((_plain, hash) =>
      Promise.resolve(hash === suspectToken.token),
    );

    await expect(service.refreshToken(replayedToken)).rejects.toThrow(UnauthorizedException);

    // WHY family-scoped: a single stale-cookie replay must not log the user
    // out of every device — the UPDATE filter carries userId + familyId.
    expect(mockRefreshTokenRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, familyId: FAMILY_ID, isRevoked: false }),
      expect.objectContaining({ isRevoked: true }),
    );
  });

  it('blacklists the user access tokens and kills sessions on reuse', async () => {
    mockCompare.mockImplementation((_plain, hash) =>
      Promise.resolve(hash === suspectToken.token),
    );

    await expect(service.refreshToken(replayedToken)).rejects.toThrow(UnauthorizedException);

    expect(mockTokenBlacklist.blacklistUserTokens).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Date),
      'refresh_token_reuse_detected',
    );
    expect(mockSessionManager.revokeAllSessions).toHaveBeenCalledWith(USER_ID);
  });

  it('emits a SecurityEvent carrying the family-id for incident correlation', async () => {
    mockCompare.mockImplementation((_plain, hash) =>
      Promise.resolve(hash === suspectToken.token),
    );

    await expect(service.refreshToken(replayedToken)).rejects.toThrow(UnauthorizedException);

    expect(mockSecurityEventService.publishSuspiciousActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        familyId: FAMILY_ID,
        suspectTokenId: suspectToken.id,
        description: 'refresh-token-reuse-detected',
      }),
    );
  });

  it('an unknown token (no revoked match) does NOT trigger family revocation', async () => {
    // Nothing matches — neither active nor revoked.
    mockCompare.mockResolvedValue(false);

    await expect(service.refreshToken(replayedToken)).rejects.toThrow(UnauthorizedException);

    expect(mockRefreshTokenRepository.update).not.toHaveBeenCalled();
    expect(mockSecurityEventService.publishSuspiciousActivity).not.toHaveBeenCalled();
  });
});
