import { NotificationResolver } from '../notification.resolver';
import { DeviceToken } from '../../entities/device-token.entity';

describe('NotificationResolver device token registration', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const token = 'raw-device-token';

  function createHarness() {
    const deleteBuilder = {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const transactionalRepository = {
      createQueryBuilder: jest.fn(() => deleteBuilder),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: Partial<DeviceToken>) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn(() => transactionalRepository),
    };
    const repository = {
      manager: {
        transaction: jest.fn(async (work: (value: typeof manager) => Promise<void>) =>
          work(manager),
        ),
      },
    };
    const resolver = new NotificationResolver({} as never, {} as never, repository as never);

    return { resolver, repository, manager, transactionalRepository, deleteBuilder };
  }

  it('revokes any previous token owner before saving the current tenant/user owner', async () => {
    const { resolver, transactionalRepository, deleteBuilder, manager } = createHarness();

    await expect(
      resolver.registerDeviceToken(
        token,
        'web',
        { sub: userId, email: 'u@example.com', tenantId, roles: [] },
        tenantId,
      ),
    ).resolves.toBe(true);

    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [token]);
    expect(deleteBuilder.where).toHaveBeenCalledWith('"token" = :token', {
      token,
    });
    expect(deleteBuilder.andWhere).toHaveBeenCalledWith(
      '("tenant_id" <> :tenantId OR "user_id" <> :userId)',
      { tenantId, userId },
    );
    expect(transactionalRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, userId, token, platform: 'web' }),
    );
  });

  it('updates the existing current owner without creating another token row', async () => {
    const { resolver, transactionalRepository } = createHarness();
    const existing = {
      id: 'token-id',
      tenantId,
      userId,
      token,
      platform: 'android',
      lastSeenAt: null,
    };
    transactionalRepository.findOne.mockResolvedValue(existing);

    await expect(
      resolver.registerDeviceToken(
        token,
        'ios',
        { sub: userId, email: 'u@example.com', tenantId, roles: [] },
        tenantId,
      ),
    ).resolves.toBe(true);

    expect(transactionalRepository.create).not.toHaveBeenCalled();
    expect(transactionalRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'token-id', platform: 'ios' }),
    );
  });
});
