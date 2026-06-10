/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-floating-promises */
import * as crypto from 'crypto';

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Role } from '@aquaculture/backend-common/decorators';
import { TimingSafeService, SESSION_MANAGER, TOKEN_BLACKLIST } from '@aquaculture/backend-common/security';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { Invitation } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { User } from '../entities/user.entity';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { AuthenticationService } from '../services/authentication.service';


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
  get: jest.fn((key: string, defaultValue?: any) => {
    const config: Record<string, any> = {
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

const mockDataSource = {
  transaction: jest.fn(),
  query: jest.fn(),
};

const mockTimingSafe = {
  ensureMinDuration: jest.fn().mockResolvedValue(undefined),
};

describe('AuthenticationService - Password Reset Flow', () => {
  let service: AuthenticationService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: getRepositoryToken(RefreshToken), useValue: mockRefreshTokenRepository },
        { provide: getRepositoryToken(Invitation), useValue: mockInvitationRepository },
        { provide: getRepositoryToken(UserModuleAssignment), useValue: mockUserModuleAssignmentRepository },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepository },
        { provide: DataSource, useValue: mockDataSource },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: 'EVENT_BUS', useValue: mockEventBus },
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: TimingSafeService, useValue: mockTimingSafe },
        { provide: SESSION_MANAGER, useValue: null },
        { provide: TOKEN_BLACKLIST, useValue: null },
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
      const savedUser = mockUserRepository.save.mock.calls[0][0] as User;
      expect(savedUser.passwordResetToken).toBeDefined();
      expect(savedUser.passwordResetToken).toHaveLength(64); // SHA-256 hex digest
      expect(savedUser.passwordResetExpires).toBeInstanceOf(Date);
      expect(savedUser.passwordResetExpires!.getTime()).toBeGreaterThan(Date.now());
    });

    it('should set token expiry to 1 hour from now', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);

      const before = Date.now();
      await service.initiatePasswordReset('test@example.com');
      const after = Date.now();

      const savedUser = mockUserRepository.save.mock.calls[0][0] as User;
      const expiresAt = savedUser.passwordResetExpires!.getTime();
      // Expiry should be approximately 1 hour from now (within 5 second tolerance)
      expect(expiresAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 5000);
      expect(expiresAt).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 5000);
    });

    it('should publish PasswordResetRequested event with plain token', async () => {
      const user = createMockUser();
      mockUserRepository.findOne.mockResolvedValue(user);
      mockUserRepository.save.mockResolvedValue(user);

      await service.initiatePasswordReset('test@example.com');

      expect(mockEventBus.publish).toHaveBeenCalledTimes(1);
      const event = mockEventBus.publish.mock.calls[0][0];
      expect(event.eventType).toBe('PasswordResetRequested');
      expect(event.email).toBe('test@example.com');
      expect(event.userId).toBe('user-uuid-123');
      expect(event.resetToken).toBeDefined();
      expect(event.resetToken).toHaveLength(64); // crypto.randomBytes(32).toString('hex')
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

      await expect(
        service.initiatePasswordReset('test@example.com'),
      ).resolves.toBeUndefined();

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
      await expect(
        service.initiatePasswordReset('test@example.com'),
      ).resolves.toBeUndefined();
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
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'user.passwordResetToken = :tokenHash',
        { tokenHash },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'user.passwordResetExpires > :now',
        expect.objectContaining({ now: expect.any(Date) }),
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

      const savedUser = mockUserRepository.save.mock.calls[0][0] as User;
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

      const savedUser = mockUserRepository.save.mock.calls[0][0] as User;
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
    });

    it('should throw BadRequestException for invalid token', async () => {
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(null);

      await expect(
        service.resetPassword('invalid-token', 'NewPass123!'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for expired token', async () => {
      // The query already filters by passwordResetExpires > NOW(),
      // so expired token results in null from getOne
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(null);

      await expect(
        service.resetPassword(plainToken, 'NewPass123!'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for inactive user', async () => {
      const user = createMockUser({
        isActive: false,
        passwordResetToken: tokenHash,
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockQueryBuilder.getOne as jest.Mock).mockResolvedValue(user);

      await expect(
        service.resetPassword(plainToken, 'NewPass123!'),
      ).rejects.toThrow(BadRequestException);
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

      const publishCalls = mockEventBus.publish.mock.calls;
      const resetCompletedEvent = publishCalls.find(
        (call: any[]) => call[0].eventType === 'PasswordResetCompleted',
      );
      expect(resetCompletedEvent).toBeDefined();
      expect(resetCompletedEvent![0].userId).toBe('user-uuid-123');
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

      const savedUser = mockUserRepository.save.mock.calls[0][0] as User;
      expect(savedUser.password).toBe('NewPass123!');
    });
  });
});
