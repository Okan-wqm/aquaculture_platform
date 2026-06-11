import { Role } from '@aquaculture/backend-common/decorators';
import { SESSION_MANAGER, TOKEN_BLACKLIST } from '@aquaculture/backend-common/security';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';
import { AccountService } from '../services/account.service';
import { MfaService } from '../services/mfa.service';

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
  findOne: jest.fn(),
  save: jest.fn((user: User) => Promise.resolve(user)),
};

const refreshTokenRepository = {
  update: jest.fn().mockResolvedValue({ affected: 1 }),
};

const configService = {
  get: jest.fn((key: string, defaultValue?: string) => {
    const values: Record<string, string> = { JWT_EXPIRES_IN: '15m' };
    return values[key] ?? defaultValue;
  }),
};

const auditLogService = {
  log: jest.fn().mockResolvedValue(undefined),
};

const eventBus = {
  publish: jest.fn().mockResolvedValue(undefined),
};

const tokenBlacklist = {
  blacklistUserTokens: jest.fn().mockResolvedValue(undefined),
};

const sessionManager = {
  revokeAllSessions: jest.fn().mockResolvedValue(undefined),
};

const mfaService = {
  isMfaAvailable: jest.fn().mockReturnValue(true),
  getMfaUnavailableReason: jest.fn().mockReturnValue(null),
};

describe('AccountService', () => {
  let service: AccountService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mfaService.isMfaAvailable.mockReturnValue(true);
    mfaService.getMfaUnavailableReason.mockReturnValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountService,
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokenRepository },
        { provide: ConfigService, useValue: configService },
        { provide: AuditLogService, useValue: auditLogService },
        { provide: MfaService, useValue: mfaService },
        { provide: BestEffortEventPublisher, useValue: new BestEffortEventPublisher(eventBus) },
        { provide: TOKEN_BLACKLIST, useValue: tokenBlacklist },
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
    expect(userRepository.save).toHaveBeenCalledWith(user);
  });

  it('rejects blank profile names', async () => {
    userRepository.findOne.mockResolvedValue(createUser());

    await expect(service.updateMyProfile('user-1', { firstName: '   ' })).rejects.toThrow(BadRequestException);
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

    expect(user.password).toBe('NewPass1!');
    expect(refreshTokenRepository.update).toHaveBeenCalledWith(
      { userId: 'user-1', isRevoked: false },
      expect.objectContaining({ isRevoked: true, revokedReason: 'Password changed' }),
    );
    expect(tokenBlacklist.blacklistUserTokens).toHaveBeenCalledWith(
      'user-1',
      expect.any(Date),
      'password_change',
    );
    expect(sessionManager.revokeAllSessions).toHaveBeenCalledWith('user-1');
  });

  it('rejects wrong current password', async () => {
    const user = createUser({ validatePassword: jest.fn().mockResolvedValue(false) as unknown as User['validatePassword'] });
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
