import { createBaseEvent, type UserDeletedEvent } from '@platform/event-contracts';
import { DeviceTokenEventHandler } from '../device-token-event.handler';

describe('DeviceTokenEventHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const requesterId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  const repository = {
    delete: jest.fn(),
  };
  const eventBus = {
    subscribeWildcard: jest.fn(),
  };

  let handler: DeviceTokenEventHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    repository.delete.mockResolvedValue({ affected: 1 });
    eventBus.subscribeWildcard.mockResolvedValue(undefined);
    handler = new DeviceTokenEventHandler(repository as never, eventBus as never);
  });

  it('subscribes to tenant-scoped UserDeleted events', async () => {
    await handler.onModuleInit();

    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('UserDeleted', handler);
  });

  it('revokes tenant-scoped device tokens for a deleted user', async () => {
    await handler.handle(makeUserDeletedEvent());

    expect(repository.delete).toHaveBeenCalledWith({ tenantId, userId });
  });

  it('uses deletedUserId as target when requester differs from deleted user', async () => {
    await handler.handle(makeUserDeletedEvent());

    expect(repository.delete).toHaveBeenCalledWith({ tenantId, userId });
    expect(repository.delete).not.toHaveBeenCalledWith({
      tenantId,
      userId: requesterId,
    });
  });

  it('rejects malformed tenant/user payloads without deleting tokens', async () => {
    await handler.handle({
      ...makeUserDeletedEvent(),
      deletedUserId: 'not-a-uuid',
    });

    expect(repository.delete).not.toHaveBeenCalled();
  });

  function makeUserDeletedEvent(): UserDeletedEvent {
    return {
      ...createBaseEvent<UserDeletedEvent>('UserDeleted', tenantId),
      userId: requesterId,
      deletedUserId: userId,
      hardDelete: true,
      cascadeRequested: true,
      initiatedBy: 'gdpr-erasure',
      cryptoShredKeyId: 'kms-key-1',
    };
  }
});
