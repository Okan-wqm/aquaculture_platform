import * as crypto from 'crypto';

import { BypassRlsService } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  TimingSafeService,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
} from '@aquaculture/backend-common/security';
import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, SelectQueryBuilder } from 'typeorm';

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

interface PasswordResetRequestedEvent {
  eventType: string;
  version: number;
  tenantId: string;
  userId: string;
  actionTokenId: string;
  cryptoShredKeyId: string;
  email?: unknown;
  resetToken?: unknown;
}

interface OutboxEnqueueOptions {
  aggregateId?: string;
  idempotencyKey?: string;
  routingScope?: 'tenant' | 'system';
}

/** The single PasswordResetRequested enqueue of a test, with its options. */
function enqueuedPasswordResetRequested(): {
  event: PasswordResetRequestedEvent;
  manager: unknown;
  options: OutboxEnqueueOptions;
} {
  const calls = mockOutboxPublisher.enqueue.mock.calls as readonly (readonly unknown[])[];
  expect(calls).toHaveLength(1);
  const [event, manager, options] = calls[0] ?? [];
  return {
    event: event as PasswordResetRequestedEvent,
    manager,
    options: options as OutboxEnqueueOptions,
  };
}

interface PasswordResetCompletedEvent {
  eventType: string;
  userId: string;
}

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
    failedLoginAttempts: 0,
    lockedUntil: null,
    passwordResetToken: null,
    passwordResetExpires: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return user;
};

// ============================================================================
// Mock Setup
// ============================================================================

const mockUserRepository = {
  findOne: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
  createQueryBuilder: jest.fn(),
  manager: { query: jest.fn() },
};

const mockRefreshTokenRepository = {
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
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
  find: jest.fn(),
};

const mockTenantRepository = {
  findOne: jest.fn(),
};

const mockJwtService = {
  signAsync: jest.fn().mockResolvedValue('mock-access-token'),
};

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: unknown): unknown => {
    const config: Record<string, string | number | boolean> = {
      JWT_EXPIRES_IN: '15m',
      JWT_AUDIENCE: 'test-audience',
      MIN_LOGIN_DURATION_MS: 0, // Disable timing delays for tests
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

// WHY: AuthenticationService now injects TokenService (token minting moved
// there) and MfaService (login MFA branch). Password-reset paths don't mint
// MFA challenges, but the constructor requires both collaborators.
const mockTokenService = {
  generateTokens: jest.fn().mockImplementation((user: User) => ({
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    user,
    expiresIn: 900,
    tokenType: 'Bearer',
    redirectUrl: '/dashboard',
  })),
  getUserModules: jest.fn().mockResolvedValue([]),
};

const mockMfaService = {
  isMfaAvailable: jest.fn().mockReturnValue(false),
  generateMfaChallenge: jest.fn(),
};

const mockTransactionManager = {
  getRepository: jest.fn((entity: unknown) => {
    if (entity === User) return mockUserRepository;
    if (entity === RefreshToken) return mockRefreshTokenRepository;
    if (entity === Invitation) return mockInvitationRepository;
    if (entity === ActionToken) return mockActionTokenRepository;
    if (entity === Tenant) return mockTenantRepository;
    return {};
  }),
  // SEC-CRITICAL-002 (№38b): resetPassword deletes WebAuthn credentials
  // inside the transaction via manager.delete
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
};

const mockDataSource = {
  transaction: jest.fn(
    async <T>(callback: (manager: typeof mockTransactionManager) => Promise<T>): Promise<T> =>
      callback(mockTransactionManager),
  ),
  query: jest.fn(),
};

const mockTimingSafe = {
  ensureMinDuration: jest.fn().mockResolvedValue(undefined),
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

const mockSessionManager = {
  revokeAllSessions: jest.fn().mockResolvedValue(undefined),
};

const mockOutboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

describe('AuthenticationService - Password Reset Flow', () => {
  let service: AuthenticationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockActionTokenRepository.create.mockImplementation((data: Record<string, unknown>) => ({
      ...data,
    }));
    mockActionTokenRepository.save.mockImplementation((entity: Record<string, unknown>) =>
      Promise.resolve({
        id: 'action-token-id',
        ...entity,
      }),
    );
    mockActionTokenRepository.findOne.mockResolvedValue(null);
    mockTokenService.generateTokens.mockImplementation((user: User) =>
      Promise.resolve({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        user,
      }),
    );
    mockTokenBlacklist.isBlacklisted.mockResolvedValue(false);
    mockUserTokenRevocation.isTokenValid.mockResolvedValue(true);
    mockDurableAccessTokenInvalidation.enqueue.mockResolvedValue(undefined);
    mockDurableAccessTokenInvalidation.applyImmediately.mockResolvedValue(undefined);
    mockDurableUserTokenInvalidation.enqueue.mockResolvedValue(undefined);
    mockDurableUserTokenInvalidation.applyImmediately.mockResolvedValue(undefined);
    mockSessionManager.revokeAllSessions.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        ActionTokenResolver,
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: getRepositoryToken(RefreshToken), useValue: mockRefreshTokenRepository },
        { provide: getRepositoryToken(Invitation), useValue: mockInvitationRepository },
        { provide: getRepositoryToken(ActionToken), useValue: mockActionTokenRepository },
        {
          provide: getRepositoryToken(UserModuleAssignment),
          useValue: mockUserModuleAssignmentRepository,
        },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepository },
        // ADR-046: the MFA-enrollment gate counts the user's registered
        // WebAuthn credentials, so AuthenticationService injects the repo.
        // Zero credentials keeps these suites on their existing paths.
        {
          provide: getRepositoryToken(WebAuthnCredential),
          useValue: { count: jest.fn().mockResolvedValue(0) },
        },
        { provide: DataSource, useValue: mockDataSource },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: 'EVENT_BUS', useValue: mockEventBus },
        {
          provide: BestEffortEventPublisher,
          useValue: new BestEffortEventPublisher(mockEventBus),
        },
        { provide: OutboxPublisher, useValue: mockOutboxPublisher },
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
        // WHY: the SUPER_ADMIN reset path persists refresh tokens through the
        // audited RLS bypass; the mock forwards through withBypass so the
        // spec exercises the same call chain without the audit WARN log.
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

  // ==========================================================================
  // initiatePasswordReset
  // ==========================================================================
  describe('initiatePasswordReset', () => {
    it('should generate token, hash it with SHA-256, and store hash in user', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);

      await service.initiatePasswordReset('test@example.com');

      // Verify save was called with hashed token (SHA-256 hex = 64 chars)
      expect(mockUserRepository.save).toHaveBeenCalledTimes(1);
      const [savedUser] = mockUserRepository.save.mock.calls[0] as [User];
      expect(savedUser.passwordResetToken).toBeDefined();
      expect(savedUser.passwordResetToken).toHaveLength(64); // SHA-256 hex digest
      const resetExpires = savedUser.passwordResetExpires;
      if (!(resetExpires instanceof Date)) {
        throw new Error('passwordResetExpires was not persisted as a Date');
      }
      expect(resetExpires.getTime()).toBeGreaterThan(Date.now());
    });

    it('should set token expiry to 1 hour from now', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);

      const before = Date.now();
      await service.initiatePasswordReset('test@example.com');
      const after = Date.now();

      const saveCalls = mockUserRepository.save.mock.calls as readonly (readonly unknown[])[];
      const savedUser = saveCalls[0]?.[0] as User;
      const resetExpires = savedUser.passwordResetExpires;
      if (!(resetExpires instanceof Date)) {
        throw new Error('passwordResetExpires was not persisted as a Date');
      }
      const expiresAt = resetExpires.getTime();
      // Expiry should be approximately 1 hour from now (within 5 second tolerance)
      expect(expiresAt ?? 0).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 5000);
      expect(expiresAt ?? 0).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 5000);
    });

    it('should enqueue a PII-free PasswordResetRequested event through the durable outbox (opaque references only)', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);

      await service.initiatePasswordReset('test@example.com');

      // SEC-HIGH-159: the delivery trigger is durable and commits with the
      // token row — never the lossy best-effort path.
      expect(mockEventBus.publish).not.toHaveBeenCalled();
      const { event, manager, options } = enqueuedPasswordResetRequested();
      expect(manager).toBe(mockTransactionManager);
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(options).toEqual({
        aggregateId: 'user-uuid-123',
        idempotencyKey: 'password-reset-requested:action-token-id',
      });
      expect(event.eventType).toBe('PasswordResetRequested');
      expect(event.version).toBe(2);
      expect(event.tenantId).toBe(user.tenantId);
      expect(event.userId).toBe('user-uuid-123');
      // WHAT: actionTokenId is the persisted ActionToken row id (the
      // command-receipt ledger design that landed with the enterprise
      // train). Notification-service resolves the actual reset URL at
      // delivery time via the authenticated internal
      // /internal/action-tokens/{id}/url endpoint using this opaque
      // reference; the raw token never crosses the bus.
      expect(event.actionTokenId).toBe('action-token-id');
      expect(event.cryptoShredKeyId).toBe('user-uuid-123');
      // WHY: PII and secrets must never be placed on the immutable event bus
      // (GDPR erasure + token-leak surface). Assert structural absence so a
      // regression reintroducing them fails loudly.
      expect(event.email).toBeUndefined();
      expect(event.resetToken).toBeUndefined();
    });

    it('SEC-HIGH-159: a super admin (no tenant) gets a platform-scoped, system-routed durable event', async () => {
      const superAdmin = createMockUser({
        id: 'super-admin-uuid',
        role: Role.SUPER_ADMIN,
        tenantId: null,
      });
      mockUserRepository.findOne.mockResolvedValue(superAdmin);
      mockUserRepository.save.mockResolvedValue(superAdmin);

      await service.initiatePasswordReset('test@example.com');

      const { event, options } = enqueuedPasswordResetRequested();
      expect(event.tenantId).toBe('system');
      expect(event.userId).toBe('super-admin-uuid');
      expect(event.actionTokenId).toBe('action-token-id');
      expect(options).toEqual({
        aggregateId: 'super-admin-uuid',
        idempotencyKey: 'password-reset-requested:action-token-id',
        routingScope: 'system',
      });
      // The token row keeps the NULL tenant of a platform principal.
      const [actionTokenRow] = mockActionTokenRepository.create.mock.calls[0] as [
        { tenantId: string | null; userId: string },
      ];
      expect(actionTokenRow).toEqual(
        expect.objectContaining({ tenantId: null, userId: 'super-admin-uuid' }),
      );
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('should silently return without error when user is not found (enumeration prevention)', async () => {
      mockUserRepository.findOne.mockResolvedValue(null);

      // Should NOT throw
      await expect(
        service.initiatePasswordReset('nonexistent@example.com'),
      ).resolves.toBeUndefined();

      // Should NOT save or publish anything
      expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
      expect(mockUserRepository.save).not.toHaveBeenCalled();
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('should silently return when user is inactive', async () => {
      const user = createMockUser({ isActive: false });
      mockUserRepository.findOne.mockResolvedValue(user);

      await expect(service.initiatePasswordReset('test@example.com')).resolves.toBeUndefined();

      expect(mockUserRepository.save).not.toHaveBeenCalled();
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('should normalize email to lowercase for lookup', async () => {
      mockUserRepository.findOne.mockResolvedValue(null);

      await service.initiatePasswordReset('Test@Example.COM');

      expect(mockUserRepository.findOne).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
      });
    });

    it('should log audit event for successful reset request', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);

      await service.initiatePasswordReset('test@example.com', '192.168.1.1');

      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PASSWORD_RESET_REQUESTED',
          entityType: 'User',
          entityId: 'user-uuid-123',
        }),
      );
    });

    it('should swallow errors and not propagate them (security)', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockUserRepository.save.mockRejectedValue(new Error('DB error'));

      // Should NOT throw
      await expect(service.initiatePasswordReset('test@example.com')).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // resetPassword
  // ==========================================================================
  describe('resetPassword', () => {
    const plainToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(plainToken).digest('hex');

    let mockQueryBuilder: Partial<SelectQueryBuilder<User>>;

    beforeEach(() => {
      mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn(),
      };
      mockUserRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
    });

    it('should reset password for valid token', async () => {
      const user = createMockUser({
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 1 });
      mockRefreshTokenRepository.create.mockReturnValue({ id: 'rt-1' });
      mockRefreshTokenRepository.save.mockResolvedValue({ id: 'rt-1' });
      mockUserModuleAssignmentRepository.find.mockResolvedValue([]);

      const result = await service.resetPassword(plainToken, 'NewPass123!');

      expect(result).toBeDefined();
      expect(result.accessToken).toBe('mock-access-token');
      expect(result.user).toBe(user);
    });

    it('should hash token with SHA-256 before database lookup', async () => {
      const user = createMockUser({
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 1 });
      mockRefreshTokenRepository.create.mockReturnValue({ id: 'rt-1' });
      mockRefreshTokenRepository.save.mockResolvedValue({ id: 'rt-1' });
      mockUserModuleAssignmentRepository.find.mockResolvedValue([]);

      await service.resetPassword(plainToken, 'NewPass123!');

      // Verify createQueryBuilder was used with the hashed token
      const dateMatcher: unknown = expect.any(Date);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'user.passwordResetExpires > :now',
        expect.objectContaining({ now: dateMatcher }),
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'user.passwordResetToken = :tokenHash',
        { tokenHash },
      );
    });

    it('should clear reset token after successful reset (single-use)', async () => {
      const user = createMockUser({
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 1 });
      mockRefreshTokenRepository.create.mockReturnValue({ id: 'rt-1' });
      mockRefreshTokenRepository.save.mockResolvedValue({ id: 'rt-1' });
      mockUserModuleAssignmentRepository.find.mockResolvedValue([]);

      await service.resetPassword(plainToken, 'NewPass123!');

      const [savedUser] = mockUserRepository.save.mock.calls[0] as [User];
      expect(savedUser.passwordResetToken).toBeNull();
      expect(savedUser.passwordResetExpires).toBeNull();
    });

    it('should reset account lockout on password reset', async () => {
      const user = createMockUser({
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 30 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 1 });
      mockRefreshTokenRepository.create.mockReturnValue({ id: 'rt-1' });
      mockRefreshTokenRepository.save.mockResolvedValue({ id: 'rt-1' });
      mockUserModuleAssignmentRepository.find.mockResolvedValue([]);

      await service.resetPassword(plainToken, 'NewPass123!');

      const [savedUser] = mockUserRepository.save.mock.calls[0] as [User];
      expect(savedUser.failedLoginAttempts).toBe(0);
      expect(savedUser.lockedUntil).toBeNull();
    });

    it('should revoke all refresh tokens after password reset', async () => {
      const user = createMockUser({
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 3 });
      mockRefreshTokenRepository.create.mockReturnValue({ id: 'rt-1' });
      mockRefreshTokenRepository.save.mockResolvedValue({ id: 'rt-1' });
      mockUserModuleAssignmentRepository.find.mockResolvedValue([]);

      await service.resetPassword(plainToken, 'NewPass123!');

      expect(mockRefreshTokenRepository.update).toHaveBeenCalledWith(
        { userId: 'user-uuid-123', isRevoked: false },
        expect.objectContaining({
          isRevoked: true,
          revokedReason: 'Password reset',
        }),
      );
      expect(mockDurableUserTokenInvalidation.enqueue).toHaveBeenCalledWith(
        mockTransactionManager,
        expect.objectContaining({
          userId: 'user-uuid-123',
          tenantId: '11111111-1111-4111-8111-111111111111',
          invalidatedAt: expect.any(Date),
          reason: 'password_reset',
        }),
      );
      const intent = mockDurableUserTokenInvalidation.enqueue.mock.calls[0]?.[1];
      expect(mockDurableUserTokenInvalidation.applyImmediately).toHaveBeenCalledWith(intent);
      expect(mockSessionManager.revokeAllSessions).toHaveBeenCalledWith('user-uuid-123');
    });

    it('should delete all WebAuthn credentials after password reset (SEC-CRITICAL-002 №38b)', async () => {
      const user = createMockUser({
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 0 });
      mockRefreshTokenRepository.create.mockReturnValue({ id: 'rt-1' });
      mockRefreshTokenRepository.save.mockResolvedValue({ id: 'rt-1' });
      mockUserModuleAssignmentRepository.find.mockResolvedValue([]);

      await service.resetPassword(plainToken, 'NewPass123!');

      // A biometric credential planted with a stolen token must NOT survive
      // the victim rotating their password.
      expect(mockTransactionManager.delete).toHaveBeenCalledWith(WebAuthnCredential, {
        userId: 'user-uuid-123',
      });
    });

    it('fails closed before commit when password-reset invalidation cannot be enqueued', async () => {
      const user = createMockUser({
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 1 });
      mockDurableUserTokenInvalidation.enqueue.mockRejectedValueOnce(
        new Error('outbox unavailable'),
      );

      await expect(service.resetPassword(plainToken, 'NewPass123!')).rejects.toThrow(
        'outbox unavailable',
      );

      expect(mockDurableUserTokenInvalidation.applyImmediately).not.toHaveBeenCalled();
      expect(mockSessionManager.revokeAllSessions).not.toHaveBeenCalled();
      expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
    });

    it('returns tokens after commit when immediate password-reset effects fail', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const user = createMockUser({
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 1 });
      mockDurableUserTokenInvalidation.applyImmediately.mockRejectedValueOnce(
        new TypeError('redis unavailable for user-uuid-123'),
      );
      mockSessionManager.revokeAllSessions.mockRejectedValueOnce(
        new RangeError('session store unavailable for user-uuid-123'),
      );

      await expect(service.resetPassword(plainToken, 'NewPass123!')).resolves.toMatchObject({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
      });

      expect(mockDurableUserTokenInvalidation.enqueue).toHaveBeenCalledTimes(1);
      const [serializedLog] = errorSpy.mock.calls.at(-1) ?? [];
      expect(JSON.parse(String(serializedLog))).toEqual({
        event: 'post_commit_security_effect_failed',
        operation: 'password_reset',
        failedCount: 2,
        effectCount: 2,
        failedEffectTypes: ['user_token_invalidation', 'session_revocation'],
        errorTypes: ['TypeError', 'RangeError'],
      });
      expect(String(serializedLog)).not.toContain('user-uuid-123');
      expect(String(serializedLog)).not.toContain('unavailable');
      errorSpy.mockRestore();
    });

    it('should throw BadRequestException for invalid token', async () => {
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(null);

      await expect(service.resetPassword('invalid-token', 'NewPass123!')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for expired token', async () => {
      // The query already filters by passwordResetExpires > NOW(),
      // so expired token results in null from getOne
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(null);

      await expect(service.resetPassword(plainToken, 'NewPass123!')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for inactive user', async () => {
      const user = createMockUser({
        isActive: false,
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);

      await expect(service.resetPassword(plainToken, 'NewPass123!')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should publish PasswordResetCompleted event', async () => {
      const user = createMockUser({
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 1 });
      mockRefreshTokenRepository.create.mockReturnValue({ id: 'rt-1' });
      mockRefreshTokenRepository.save.mockResolvedValue({ id: 'rt-1' });
      mockUserModuleAssignmentRepository.find.mockResolvedValue([]);

      await service.resetPassword(plainToken, 'NewPass123!');

      const publishCalls = mockEventBus.publish.mock.calls as readonly (readonly unknown[])[];
      const resetCompletedEvent = publishCalls.find((call) => {
        const payload = call[0];
        return (
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { eventType?: unknown }).eventType === 'PasswordResetCompleted'
        );
      });
      if (!resetCompletedEvent) {
        throw new Error('PasswordResetCompleted event was not published');
      }
      const completedEvent = resetCompletedEvent[0] as PasswordResetCompletedEvent;
      expect(completedEvent.userId).toBe('user-uuid-123');
    });

    it('should log PASSWORD_RESET_SUCCESS audit event', async () => {
      const user = createMockUser({
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 1 });
      mockRefreshTokenRepository.create.mockReturnValue({ id: 'rt-1' });
      mockRefreshTokenRepository.save.mockResolvedValue({ id: 'rt-1' });
      mockUserModuleAssignmentRepository.find.mockResolvedValue([]);

      await service.resetPassword(plainToken, 'NewPass123!', '192.168.1.1');

      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PASSWORD_RESET_SUCCESS',
          entityType: 'User',
          entityId: 'user-uuid-123',
        }),
      );
    });

    it('should set new password on user (to be hashed by BeforeUpdate hook)', async () => {
      const user = createMockUser({
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);
      mockRefreshTokenRepository.update.mockResolvedValue({ affected: 1 });
      mockRefreshTokenRepository.create.mockReturnValue({ id: 'rt-1' });
      mockRefreshTokenRepository.save.mockResolvedValue({ id: 'rt-1' });
      mockUserModuleAssignmentRepository.find.mockResolvedValue([]);

      await service.resetPassword(plainToken, 'NewPass123!');

      const [savedUser] = mockUserRepository.save.mock.calls[0] as [User];
      expect(savedUser.password).toBe('NewPass123!');
    });
  });
});
