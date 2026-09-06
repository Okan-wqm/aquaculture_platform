import { Role } from '@aquaculture/backend-common/decorators';
import { verifyPassword } from '@aquaculture/backend-common/auth';
import { SESSION_MANAGER } from '@aquaculture/backend-common/security';
import { BadRequestException, Logger, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';
import { AccountService } from '../services/account.service';
import { DurableUserTokenInvalidationService } from '../services/durable-user-token-invalidation.service';
import { MfaService } from '../services/mfa.service';
import { Tenant, TenantStatus } from '../../tenant/entities/tenant.entity';

const createUser = (overrides: Partial<User> = {}): User => {
  const user = new User();
  Object.assign(user, {
    id: 'user-1',
    email: 'user@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    role: Role.MODULE_USER,
    tenantId: 'tenant-1',
    isActive: true,
    credentialVersion: 1,
    accessTokenInvalidBeforeEpochSeconds: 0,
    isEmailVerified: true,
    mfaEnabled: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    validatePassword: jest.fn().mockResolvedValue(true),
    ...overrides,
  });
  return user;
};

const userRepository = {
  findOne: jest.fn<Promise<User | null>, [options?: unknown]>(),
  save: jest.fn((user: User) => Promise.resolve(user)),
  update: jest.fn(),
};

const refreshTokenRepository = {
  update: jest.fn().mockResolvedValue({ affected: 1 }),
};

const auditLogService = {
  log: jest.fn().mockResolvedValue(undefined),
};

const eventBus = {
  publish: jest.fn().mockResolvedValue(undefined),
};

const durableUserTokenInvalidation = {
  enqueue: jest.fn().mockResolvedValue(undefined),
  applyImmediately: jest.fn().mockResolvedValue(undefined),
};

const sessionManager = {
  revokeAllSessions: jest.fn().mockResolvedValue(undefined),
};

const mfaService = {
  isMfaAvailable: jest.fn().mockReturnValue(true),
  getMfaUnavailableReason: jest.fn().mockReturnValue(null),
};

const transactionManager = {
  queryRunner: { isTransactionActive: false },
  findOne: jest.fn(),
  update: jest.fn(),
  withRepository: jest.fn((repository: unknown) => repository),
};

const dataSource = {
  transaction: jest.fn(
    async <T>(callback: (manager: typeof transactionManager) => Promise<T>): Promise<T> => {
      transactionManager.queryRunner.isTransactionActive = true;
      try { return await callback(transactionManager); }
      finally { transactionManager.queryRunner.isTransactionActive = false; }
    },
  ),
};

describe('AccountService', () => {
  let service: AccountService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mfaService.isMfaAvailable.mockReturnValue(true);
    mfaService.getMfaUnavailableReason.mockReturnValue(null);
    userRepository.save.mockImplementation((user: User) => Promise.resolve(user));
    userRepository.findOne.mockResolvedValue(null);
    userRepository.update.mockImplementation(async (_criteria: unknown, values: Partial<User>) => {
      const current = await userRepository.findOne();
      if (!current) throw new Error('Account update has no stored user');
      const updated = Object.assign(new User(), current, values);
      if (values.password !== undefined && values.password !== current.password) {
        updated.credentialVersion = current.credentialVersion + 1;
      }
      userRepository.findOne.mockResolvedValue(updated);
      return { affected: 1 };
    });
    transactionManager.findOne.mockImplementation((entity: unknown, options: unknown) => {
      if (entity === User) return userRepository.findOne(options);
      if (entity === Tenant) return Promise.resolve(Object.assign(new Tenant(), {
        id: 'tenant-1', status: TenantStatus.ACTIVE,
      }));
      throw new Error('Unexpected account identity lookup');
    });
    transactionManager.update.mockImplementation((entity: unknown, criteria: unknown, values: Partial<User>) => {
      if (entity === User) return userRepository.update(criteria, values);
      throw new Error('Unexpected account mutation');
    });
    refreshTokenRepository.update.mockResolvedValue({ affected: 1 });
    durableUserTokenInvalidation.enqueue.mockResolvedValue(undefined);
    durableUserTokenInvalidation.applyImmediately.mockResolvedValue(undefined);
    sessionManager.revokeAllSessions.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountService,
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokenRepository },
        { provide: DataSource, useValue: dataSource },
        { provide: AuditLogService, useValue: auditLogService },
        { provide: MfaService, useValue: mfaService },
        { provide: BestEffortEventPublisher, useValue: new BestEffortEventPublisher(eventBus) },
        {
          provide: DurableUserTokenInvalidationService,
          useValue: durableUserTokenInvalidation,
        },
        { provide: SESSION_MANAGER, useValue: sessionManager },
      ],
    }).compile();

    service = module.get(AccountService);
  });

  it('updates first and last name without changing email', async () => {
    const user = createUser();
    userRepository.findOne.mockResolvedValue(user);

    const result = await service.updateMyProfile('user-1', {
      firstName: ' Grace ',
      lastName: ' Hopper ',
    });

    expect(result.firstName).toBe('Grace');
    expect(result.lastName).toBe('Hopper');
    expect(result.email).toBe('user@example.com');
    expect(userRepository.save).not.toHaveBeenCalled();
    expect(userRepository.update).toHaveBeenCalledWith({ id: user.id }, {
      firstName: 'Grace', lastName: 'Hopper',
    });
  });

  it('rejects blank profile names', async () => {
    userRepository.findOne.mockResolvedValue(createUser());

    await expect(service.updateMyProfile('user-1', { firstName: '   ' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects deprecated alias email changes', async () => {
    userRepository.findOne.mockResolvedValue(createUser());

    await expect(
      service.updateMyProfile('user-1', { firstName: 'Ada' }, { email: 'other@example.com' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('changes password and revokes refresh tokens, access tokens, and sessions', async () => {
    const user = createUser();
    userRepository.findOne.mockResolvedValue(user);

    await service.changeMyPassword('user-1', {
      currentPassword: 'OldPass1!',
      newPassword: 'NewPass1!',
    });

    const stored = await userRepository.findOne();
    if (!stored) throw new Error('Account missing after password change');
    expect((await verifyPassword('NewPass1!', stored.password)).matched).toBe(true);
    expect(stored.credentialVersion).toBe(user.credentialVersion + 1);
    expect(userRepository.save).not.toHaveBeenCalled();
    expect(refreshTokenRepository.update).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ isRevoked: true, revokedReason: 'Password changed' }),
    );
    expect(durableUserTokenInvalidation.enqueue).toHaveBeenCalledWith(
      transactionManager,
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        invalidatedAt: expect.any(Date),
        reason: 'password_changed',
      }),
    );
    const intent = durableUserTokenInvalidation.enqueue.mock.calls[0]?.[1];
    expect(durableUserTokenInvalidation.applyImmediately).toHaveBeenCalledWith(intent);
    expect(sessionManager.revokeAllSessions).toHaveBeenCalledWith('user-1');
  });

  it('fails closed before commit when password-change invalidation cannot be enqueued', async () => {
    userRepository.findOne.mockResolvedValue(createUser());
    durableUserTokenInvalidation.enqueue.mockRejectedValueOnce(new Error('outbox unavailable'));

    await expect(
      service.changeMyPassword('user-1', {
        currentPassword: 'OldPass1!',
        newPassword: 'NewPass1!',
      }),
    ).rejects.toThrow('outbox unavailable');

    expect(durableUserTokenInvalidation.applyImmediately).not.toHaveBeenCalled();
    expect(sessionManager.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('returns success after commit when immediate password-change effects fail', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    userRepository.findOne.mockResolvedValue(createUser());
    durableUserTokenInvalidation.applyImmediately.mockRejectedValueOnce(
      new TypeError('redis unavailable for user-1'),
    );
    sessionManager.revokeAllSessions.mockRejectedValueOnce(
      new RangeError('session store unavailable for user-1'),
    );

    await expect(
      service.changeMyPassword('user-1', {
        currentPassword: 'OldPass1!',
        newPassword: 'NewPass1!',
      }),
    ).resolves.toEqual({
      success: true,
      message: 'Password changed successfully',
    });

    expect(durableUserTokenInvalidation.enqueue).toHaveBeenCalledTimes(1);
    const [serializedLog] = errorSpy.mock.calls.at(-1) ?? [];
    expect(JSON.parse(String(serializedLog))).toEqual({
      event: 'post_commit_security_effect_failed',
      operation: 'password_change',
      failedCount: 2,
      effectCount: 2,
      failedEffectTypes: ['user_token_invalidation', 'session_revocation'],
      errorTypes: ['TypeError', 'RangeError'],
    });
    expect(String(serializedLog)).not.toContain('user-1');
    expect(String(serializedLog)).not.toContain('unavailable');
    errorSpy.mockRestore();
  });

  it('rejects wrong current password', async () => {
    const user = createUser();
    jest.spyOn(user, 'validatePassword').mockResolvedValue(false);
    userRepository.findOne.mockResolvedValue(user);

    await expect(
      service.changeMyPassword('user-1', {
        currentPassword: 'wrong',
        newPassword: 'NewPass1!',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('reports MFA availability from the MFA service', async () => {
    userRepository.findOne.mockResolvedValue(createUser({ mfaEnabled: true }));
    mfaService.isMfaAvailable.mockReturnValue(false);
    mfaService.getMfaUnavailableReason.mockReturnValue('MFA_ENCRYPTION_KEY is not configured');

    await expect(service.getMySecuritySettings('user-1')).resolves.toEqual({
      mfaEnabled: true,
      mfaAvailable: false,
      mfaUnavailableReason: 'MFA_ENCRYPTION_KEY is not configured',
    });
  });
});
