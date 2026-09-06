import { Role } from '@aquaculture/backend-common/decorators';
import { ForbiddenException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { AuditLogService } from '../../../../audit/audit-log.service';
import { RefreshToken } from '../../../authentication/entities/refresh-token.entity';
import { UserModuleAssignment } from '../../../authentication/entities/user-module-assignment.entity';
import { UserSiteAssignment } from '../../../authentication/entities/user-site-assignment.entity';
import { User } from '../../../authentication/entities/user.entity';
import { DurableUserTokenInvalidationService } from '../../../authentication/services/durable-user-token-invalidation.service';
import { Module } from '../../../system-module/entities/module.entity';
import { TenantModule } from '../../entities/tenant-module.entity';
import { Tenant } from '../../entities/tenant.entity';
import { FarmSiteAssignmentValidator } from '../farm-site-assignment-validator.service';
import { TenantAdminService } from '../tenant-admin.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function user(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: USER_ID,
    email: 'member@example.invalid',
    tenantId: TENANT_ID,
    role: Role.MODULE_USER,
    isActive: true,
    credentialVersion: 1,
    accessTokenInvalidBeforeEpochSeconds: 0,
    ...overrides,
  });
}

function repositoryMock(): {
  findOne: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  count: jest.Mock;
  createQueryBuilder: jest.Mock;
} {
  return {
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 2, raw: [], generatedMaps: [] }),
    count: jest.fn().mockResolvedValue(2),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    })),
  };
}

describe('TenantAdminService deactivateUser credential fence', () => {
  let service: TenantAdminService;
  let userRepository: ReturnType<typeof repositoryMock>;
  let refreshTokenRepository: ReturnType<typeof repositoryMock>;
  let manager: EntityManager;
  let auditLog: { log: jest.Mock };
  let durableInvalidation: { enqueue: jest.Mock; applyImmediately: jest.Mock };

  beforeEach(async () => {
    userRepository = repositoryMock();
    refreshTokenRepository = repositoryMock();
    const source = new DataSource({ type: 'postgres' });
    const runner = source.createQueryRunner();
    jest.replaceProperty(runner, 'isTransactionActive', true);
    manager = runner.manager;
    jest.spyOn(manager, 'withRepository').mockImplementation((repository) => repository);
    jest.spyOn(manager, 'findOne').mockImplementation(async (entity, options) => {
      if (entity === User) return userRepository.findOne(options);
      if (entity === Tenant) return Object.assign(new Tenant(), { id: TENANT_ID });
      throw new Error('Unexpected deactivation identity lookup');
    });
    jest.spyOn(manager, 'update').mockImplementation(async (entity, criteria, values) => {
      if (entity !== User) throw new Error('Unexpected deactivation mutation');
      return userRepository.update(criteria, values);
    });
    jest.spyOn(manager, 'findOneByOrFail').mockImplementation(async () => userRepository.findOne());
    const dataSource = {
      transaction: jest.fn(
        async (work: (transactionManager: EntityManager) => Promise<unknown>): Promise<unknown> =>
          work(manager),
      ),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    durableInvalidation = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      applyImmediately: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TenantAdminService,
        { provide: getRepositoryToken(Tenant), useValue: repositoryMock() },
        { provide: getRepositoryToken(TenantModule), useValue: repositoryMock() },
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(UserModuleAssignment), useValue: repositoryMock() },
        { provide: getRepositoryToken(UserSiteAssignment), useValue: repositoryMock() },
        { provide: getRepositoryToken(Module), useValue: repositoryMock() },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokenRepository },
        { provide: DataSource, useValue: dataSource },
        { provide: AuditLogService, useValue: auditLog },
        { provide: FarmSiteAssignmentValidator, useValue: {} },
        { provide: DurableUserTokenInvalidationService, useValue: durableInvalidation },
      ],
    }).compile();
    service = moduleRef.get(TenantAdminService);
  });

  it('locks target User before RefreshToken, commits audit and durable invalidation atomically', async () => {
    const admin = user({ id: ADMIN_ID, role: Role.TENANT_ADMIN });
    const target = user();
    userRepository.findOne.mockResolvedValue(target).mockResolvedValueOnce(admin);
    userRepository.save.mockResolvedValue(target);

    await expect(service.deactivateUser(ADMIN_ID, USER_ID)).resolves.toBe(target);

    expect(manager.findOne).toHaveBeenCalledWith(User, {
      where: { id: USER_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(userRepository.findOne.mock.invocationCallOrder[1]).toBeLessThan(
      refreshTokenRepository.createQueryBuilder.mock.invocationCallOrder[0]!,
    );
    expect(refreshTokenRepository.update).toHaveBeenCalledWith(
      { userId: USER_ID },
      expect.objectContaining({ isRevoked: true, revokedReason: 'User deactivated' }),
    );
    expect(durableInvalidation.enqueue).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        userId: USER_ID,
        tenantId: TENANT_ID,
        reason: 'logout_all_devices',
      }),
    );
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'USER_DEACTIVATED', entityId: USER_ID }),
      manager,
    );
    expect(durableInvalidation.applyImmediately).toHaveBeenCalledTimes(1);
  });

  it('preserves the tenant-admin target prohibition before credential mutation', async () => {
    userRepository.findOne
      .mockResolvedValue(user({ role: Role.TENANT_ADMIN }))
      .mockResolvedValueOnce(user({ id: ADMIN_ID, role: Role.TENANT_ADMIN }));

    await expect(service.deactivateUser(ADMIN_ID, USER_ID)).rejects.toThrow(ForbiddenException);

    expect(refreshTokenRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(durableInvalidation.enqueue).not.toHaveBeenCalled();
  });

  it('fails closed and skips immediate invalidation when durable enqueue rejects', async () => {
    const target = user();
    userRepository.findOne
      .mockResolvedValue(target)
      .mockResolvedValueOnce(user({ id: ADMIN_ID, role: Role.TENANT_ADMIN }));
    userRepository.save.mockResolvedValue(target);
    durableInvalidation.enqueue.mockRejectedValueOnce(new Error('outbox unavailable'));

    await expect(service.deactivateUser(ADMIN_ID, USER_ID)).rejects.toThrow('outbox unavailable');

    expect(auditLog.log).not.toHaveBeenCalled();
    expect(durableInvalidation.applyImmediately).not.toHaveBeenCalled();
  });
});
