import * as crypto from 'crypto';

import { BypassRlsService } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  TimingSafeService,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
} from '@aquaculture/backend-common/security';
import { BadRequestException } from '@nestjs/common';
import { OutboxPublisher } from '@platform/outbox';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { ActionToken, ActionTokenPurpose, ActionTokenStatus } from '../entities/action-token.entity';
import { Invitation } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { User } from '../entities/user.entity';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';
import { AuthenticationService } from '../services/authentication.service';
import { DurableAccessTokenInvalidationService } from '../services/durable-access-token-invalidation.service';
import { DurableUserTokenInvalidationService } from '../services/durable-user-token-invalidation.service';
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';

interface PasswordResetRequestedEvent {
  eventType: string;
  version: number;
  userId: string;
  actionTokenId: string;
  cryptoShredKeyId: string;
  email?: unknown;
  resetToken?: unknown;
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
    tenantId: 'tenant-uuid-123',
    isActive: true,
    isEmailVerified: true,
    failedLoginAttempts: 0,
    lockedUntil: null,
    credentialVersion: 1,
    accessTokenInvalidBeforeEpochSeconds: 0,
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
  findOne: jest.fn<Promise<User | null>, [options?: unknown]>(),
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
const mockOutboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

const mockTokenService = {
  generateTokensInContext: jest.fn(),
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
  queryRunner: { isTransactionActive: false },
  findOne: jest.fn(),
  update: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  withRepository: <T>(repository: T): T => repository,
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
  manager: mockTransactionManager,
  transaction: jest.fn(),
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

describe('AuthenticationService - Password Reset Flow', () => {
  let service: AuthenticationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockUserRepository.findOne.mockResolvedValue(null);
    mockUserRepository.save.mockImplementation(async (user: User): Promise<User> => user);
    mockAuditLogService.log.mockResolvedValue(undefined);
    mockOutboxPublisher.enqueue.mockResolvedValue(undefined);
    mockTokenService.generateTokensInContext.mockResolvedValue(undefined);
    mockTenantRepository.findOne.mockResolvedValue(Object.assign(new Tenant(), {
      id: 'tenant-uuid-123', status: 'ACTIVE',
    }));
    mockTransactionManager.findOne.mockImplementation((entity: unknown, options: unknown) => {
      if (entity === User) return mockUserRepository.findOne(options);
      if (entity === Tenant) return mockTenantRepository.findOne(options);
      if (entity === ActionToken) return mockActionTokenRepository.findOne(options);
      if (entity === Invitation) return mockInvitationRepository.findOne(options);
      throw new Error('Unexpected credential-action entity');
    });
    mockTransactionManager.create.mockImplementation((entity: unknown, values: Record<string, unknown>) => {
      if (entity === ActionToken) return mockActionTokenRepository.create(values);
      throw new Error('Unexpected credential-action insert');
    });
    mockTransactionManager.save.mockImplementation((entity: unknown, values: Record<string, unknown>) => {
      if (entity === ActionToken) return mockActionTokenRepository.save(values);
      throw new Error('Unexpected credential-action save');
    });
    mockTransactionManager.update.mockImplementation(async (entity: unknown, criteria: unknown, values: Partial<User>) => {
      if (entity === User) {
        const current = await mockUserRepository.findOne();
        if (current) {
          const updated = Object.assign(new User(), current, values);
          if (values.password !== undefined && values.password !== current.password) {
            updated.credentialVersion = current.credentialVersion + 1;
          }
          mockUserRepository.findOne.mockResolvedValue(updated);
        }
      }
      if (entity === RefreshToken) return mockRefreshTokenRepository.update(criteria, values);
      return { affected: 1 };
    });
    mockDataSource.transaction.mockImplementation(async <T>(callback: (manager: typeof mockTransactionManager) => Promise<T>): Promise<T> => {
      mockTransactionManager.queryRunner.isTransactionActive = true;
      try { return await callback(mockTransactionManager); }
      finally { mockTransactionManager.queryRunner.isTransactionActive = false; }
    });
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
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: OutboxPublisher, useValue: mockOutboxPublisher },
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

      expect(mockUserRepository.save).not.toHaveBeenCalled();
      const savedUser = await mockUserRepository.findOne();
      if (!savedUser) throw new Error('User disappeared after reset request');
      expect(mockTransactionManager.update).toHaveBeenCalledWith(User, { id: user.id }, {
        passwordResetToken: savedUser.passwordResetToken,
        passwordResetExpires: savedUser.passwordResetExpires,
      });
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

      const savedUser = await mockUserRepository.findOne();
      if (!savedUser) throw new Error('User disappeared after reset request');
      const resetExpires = savedUser.passwordResetExpires;
      if (!(resetExpires instanceof Date)) {
        throw new Error('passwordResetExpires was not persisted as a Date');
      }
      const expiresAt = resetExpires.getTime();
      // Expiry should be approximately 1 hour from now (within 5 second tolerance)
      expect(expiresAt ?? 0).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 5000);
      expect(expiresAt ?? 0).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 5000);
    });

    it('should publish a PII-free PasswordResetRequested event (opaque references only)', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);

      await service.initiatePasswordReset('test@example.com');

      expect(mockEventBus.publish).toHaveBeenCalledTimes(1);
      const publishCalls = mockEventBus.publish.mock.calls as readonly (readonly unknown[])[];
      const event = publishCalls[0]?.[0] as PasswordResetRequestedEvent;
      expect(event.eventType).toBe('PasswordResetRequested');
      expect(event.version).toBe(2);
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

    it('should silently return without error when user is not found (enumeration prevention)', async () => {
      mockUserRepository.findOne.mockResolvedValue(null);

      // Should NOT throw
      await expect(
        service.initiatePasswordReset('nonexistent@example.com'),
      ).resolves.toBeUndefined();

      // Should NOT save or publish anything
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
        undefined,
      );
    });

    it('should swallow errors and not propagate them (security)', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockTransactionManager.update.mockRejectedValueOnce(new Error('DB error'));

      // Should NOT throw
      await expect(service.initiatePasswordReset('test@example.com')).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // resetPassword
  // ==========================================================================
  describe('resetPassword', () => {
    const plainToken = 'a'.repeat(64);
    const tokenHash = crypto.createHash('sha256').update(plainToken).digest('hex');

    function validUser(overrides: Partial<User> = {}): User {
      const user = createMockUser({ passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 3_600_000), ...overrides });
      mockUserRepository.findOne.mockResolvedValue(user);
      return user;
    }

    it('commits the password action and returns an explicit login requirement', async () => {
      const original = validUser();
      await expect(service.resetPassword(plainToken, 'NewPass123!')).resolves.toEqual({
        success: true, loginRequired: true,
      });
      const stored = await mockUserRepository.findOne();
      expect(stored).toMatchObject({ id: original.id, passwordResetToken: null,
        passwordResetExpires: null, credentialVersion: original.credentialVersion + 1 });
      if (!stored) throw new Error('Reset user disappeared');
      expect(stored.password).not.toBe('NewPass123!');
      expect(stored.password).not.toBe(original.password);
      expect(mockUserRepository.save).not.toHaveBeenCalled();
      expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
      expect(mockTokenService.generateTokensInContext).not.toHaveBeenCalled();
      expect(mockMfaService.generateMfaChallenge).not.toHaveBeenCalled();
      expect(mockDurableUserTokenInvalidation.applyImmediately).not.toHaveBeenCalled();
      expect(mockUserTokenRevocation.revokeUserTokens).not.toHaveBeenCalled();
    });

    it('uses the random link token hash and refuses reuse after successful completion', async () => {
      validUser();
      await service.resetPassword(plainToken, 'NewPass123!');
      expect(mockTransactionManager.findOne).toHaveBeenCalledWith(User, {
        where: [{ passwordResetToken: tokenHash }, { passwordResetToken: plainToken }],
      });
      await expect(service.resetPassword(plainToken, 'AnotherPass123!')).rejects.toThrow(BadRequestException);
      expect(mockOutboxPublisher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('resolves and consumes an emailed action id bound to the same principal', async () => {
      const user = validUser();
      const action = Object.assign(new ActionToken(), {
        id: '11111111-1111-4111-8111-111111111111', userId: user.id,
        tenantId: user.tenantId, purpose: ActionTokenPurpose.PASSWORD_RESET,
        tokenHash, status: ActionTokenStatus.ACTIVE, expiresAt: new Date(Date.now() + 3_600_000),
      });
      mockActionTokenRepository.findOne.mockResolvedValue(action);
      await expect(service.resetPassword(action.id, 'NewPass123!')).resolves.toEqual({ success: true, loginRequired: true });
      expect(mockTransactionManager.update).toHaveBeenCalledWith(ActionToken, { id: action.id },
        expect.objectContaining({ status: ActionTokenStatus.CONSUMED, consumedAt: expect.any(Date) }));
    });

    it('refuses an action id owned by another user before any credential write', async () => {
      validUser();
      const action = Object.assign(new ActionToken(), {
        id: '11111111-1111-4111-8111-111111111111', userId: 'different-user',
        tenantId: 'tenant-uuid-123', purpose: ActionTokenPurpose.PASSWORD_RESET,
        tokenHash, status: ActionTokenStatus.ACTIVE, expiresAt: new Date(Date.now() + 3_600_000),
      });
      mockActionTokenRepository.findOne.mockResolvedValue(action);
      await expect(service.resetPassword(action.id, 'NewPass123!')).rejects.toThrow(BadRequestException);
      expect(mockTransactionManager.update).not.toHaveBeenCalled();
      expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
    });

    it('rejects a missing action id without treating it as a historical raw token', async () => {
      validUser();
      await expect(service.resetPassword('11111111-1111-4111-8111-111111111111', 'NewPass123!'))
        .rejects.toThrow(BadRequestException);
      expect(mockTransactionManager.update).not.toHaveBeenCalled();
    });

    it('clears the account lockout as part of credential recovery', async () => {
      validUser({ failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 1_800_000) });
      await service.resetPassword(plainToken, 'NewPass123!');
      expect(await mockUserRepository.findOne()).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null });
    });

    it('terminally revokes refresh history and removes WebAuthn credentials inside the action transaction', async () => {
      const user = validUser();
      await service.resetPassword(plainToken, 'NewPass123!');
      expect(mockRefreshTokenRepository.update).toHaveBeenCalledWith({ userId: user.id },
        expect.objectContaining({ isRevoked: true, revokedReason: 'Password reset' }));
      expect(mockTransactionManager.delete).toHaveBeenCalledWith(WebAuthnCredential, { userId: user.id });
      expect(mockDurableUserTokenInvalidation.enqueue).toHaveBeenCalledWith(mockTransactionManager,
        expect.objectContaining({ userId: user.id, tenantId: user.tenantId,
          invalidatedAt: expect.any(Date), reason: 'password_reset' }));
    });

    it('completes recovery for a tenant-less platform account without session admission', async () => {
      validUser({ tenantId: null, role: Role.SUPER_ADMIN });
      await expect(service.resetPassword(plainToken, 'NewPass123!')).resolves.toEqual({ success: true, loginRequired: true });
      expect(mockTokenService.generateTokensInContext).not.toHaveBeenCalled();
    });

    it('completes despite unavailable Redis and signing services without calling them', async () => {
      validUser();
      mockDurableUserTokenInvalidation.applyImmediately.mockRejectedValue(new Error('redis unavailable'));
      mockTokenService.generateTokensInContext.mockRejectedValue(new Error('signing unavailable'));
      await expect(service.resetPassword(plainToken, 'NewPass123!')).resolves.toEqual({ success: true, loginRequired: true });
      expect(mockDurableUserTokenInvalidation.applyImmediately).not.toHaveBeenCalled();
      expect(mockTokenService.generateTokensInContext).not.toHaveBeenCalled();
    });

    it('rejects completion if its durable invalidation cannot be recorded', async () => {
      validUser();
      mockDurableUserTokenInvalidation.enqueue.mockRejectedValueOnce(new Error('outbox unavailable'));
      await expect(service.resetPassword(plainToken, 'NewPass123!')).rejects.toThrow('outbox unavailable');
      expect(mockAuditLogService.log).not.toHaveBeenCalled();
      expect(mockOutboxPublisher.enqueue).not.toHaveBeenCalled();
    });

    it.each([
      { isActive: false },
      { passwordResetExpires: new Date(0) },
      { passwordResetToken: 'unrelated-hash' },
    ])('rejects an ineligible stored action before writing: %j', async (overrides) => {
      validUser(overrides);
      await expect(service.resetPassword(plainToken, 'NewPass123!')).rejects.toThrow(BadRequestException);
      expect(mockTransactionManager.update).not.toHaveBeenCalled();
    });

    it('rejects an unknown token', async () => {
      await expect(service.resetPassword('invalid-token', 'NewPass123!')).rejects.toThrow(BadRequestException);
    });

    it('records completion audit and notification with the action transaction manager', async () => {
      const user = validUser();
      await service.resetPassword(plainToken, 'NewPass123!', '192.168.1.1');
      expect(mockAuditLogService.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'PASSWORD_RESET_SUCCESS', entityId: user.id,
      }), mockTransactionManager);
      expect(mockOutboxPublisher.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'PasswordResetCompleted', userId: user.id,
      }), mockTransactionManager, expect.objectContaining({ aggregateId: user.id }));
    });
  });
});
