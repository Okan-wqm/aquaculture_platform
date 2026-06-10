import { NotificationChannel } from '../entities/notification-log.entity';

import { NotificationDispatcherService } from './notification-dispatcher.service';

type CommandInput = Parameters<NotificationDispatcherService['dispatchCommandNotification']>[0];
type MockManager = { query: jest.Mock };

function commandInput(): CommandInput {
  return {
    tenantId: '123e4567-e89b-42d3-a456-426614174000',
    channel: NotificationChannel.EMAIL,
    recipient: 'ops@example.com',
    deliveryId: 'delivery-1',
    requestReference: 'request-1',
    source: 'tenant-provisioning',
    subject: 'Tenant ready',
    message: 'Tenant provisioning completed',
  };
}

function createService() {
  const dataSource = {
    transaction: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
  };
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'NODE_ENV') return 'test';
      if (key === 'NOTIFICATION_COMMAND_RECEIPT_LEASE_MS') return '300000';
      return undefined;
    }),
  };
  const service = new NotificationDispatcherService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    dataSource as never,
    configService as never,
    {} as never,
  );
  const rateLimit = jest
    .spyOn(
      service as unknown as {
        checkRateLimit: (tenantId: string, count: number) => Promise<boolean>;
      },
      'checkRateLimit',
    )
    .mockResolvedValue(true);
  const sendNotification = jest
    .spyOn(
      service as unknown as {
        sendNotification: (...args: unknown[]) => Promise<string | undefined>;
      },
      'sendNotification',
    )
    .mockResolvedValue('provider-message-1');

  return { service, dataSource, rateLimit, sendNotification };
}

function hashFor(service: NotificationDispatcherService, input: CommandInput): string {
  return (
    service as unknown as { hashCommandPayload(input: CommandInput): string }
  ).hashCommandPayload(input);
}

describe('NotificationDispatcherService command receipts', () => {
  it('does not replay fresh STARTED receipts as successful deliveries', async () => {
    const { service, dataSource, rateLimit, sendNotification } = createService();
    const input = commandInput();
    const payloadHash = hashFor(service, input);
    const manager = {
      query: jest.fn().mockResolvedValueOnce([
        {
          payloadHash,
          status: 'STARTED',
          externalId: null,
          updatedAt: new Date(),
        },
      ]),
    };
    dataSource.transaction.mockImplementation((callback: (manager: MockManager) => unknown) =>
      Promise.resolve(callback(manager)),
    );

    await expect(service.dispatchCommandNotification(input)).rejects.toThrow(
      /already in progress/i,
    );

    expect(rateLimit).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('reclaims stale STARTED receipts before dispatching again', async () => {
    const { service, dataSource, sendNotification } = createService();
    const input = commandInput();
    const payloadHash = hashFor(service, input);
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          {
            payloadHash,
            status: 'STARTED',
            externalId: null,
            updatedAt: new Date(Date.now() - 10 * 60 * 1000),
          },
        ])
        .mockResolvedValueOnce([]),
    };
    dataSource.transaction.mockImplementation((callback: (manager: MockManager) => unknown) =>
      Promise.resolve(callback(manager)),
    );

    await expect(service.dispatchCommandNotification(input)).resolves.toEqual({
      externalId: 'provider-message-1',
      replayed: false,
    });

    expect(manager.query).toHaveBeenCalledTimes(2);
    expect(manager.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("status = 'STARTED'"),
      expect.anything(),
    );
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(dataSource.query).toHaveBeenCalledTimes(1);
  });

  it('replays completed receipts without sending again', async () => {
    const { service, dataSource, rateLimit, sendNotification } = createService();
    const input = commandInput();
    const payloadHash = hashFor(service, input);
    const manager = {
      query: jest.fn().mockResolvedValueOnce([
        {
          payloadHash,
          status: 'SUCCEEDED',
          externalId: 'provider-message-1',
          updatedAt: new Date(),
        },
      ]),
    };
    dataSource.transaction.mockImplementation((callback: (manager: MockManager) => unknown) =>
      Promise.resolve(callback(manager)),
    );

    await expect(service.dispatchCommandNotification(input)).resolves.toEqual({
      externalId: 'provider-message-1',
      replayed: true,
    });

    expect(rateLimit).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});
