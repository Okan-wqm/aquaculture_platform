import { NotificationChannel } from '../entities/notification-log.entity';

import { NotificationDispatcherService } from './notification-dispatcher.service';

type CommandInput = Parameters<NotificationDispatcherService['dispatchCommandNotification']>[0];
type MockManager = { query: jest.Mock };

const TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';

function commandInput(): CommandInput {
  return {
    tenantId: TENANT_ID,
    channel: NotificationChannel.EMAIL,
    recipient: 'ops@example.com',
    deliveryId: 'delivery-1',
    requestReference: 'request-1',
    source: 'tenant-provisioning',
    subject: 'Tenant ready',
    message: 'Tenant provisioning completed',
  };
}

/**
 * A receipt-transaction manager that answers by STATEMENT, not by call order.
 *
 * ORPHAN-HIGH-413 put `bindTenantRlsContext` in front of the first receipt
 * statement (set_config ×2 + a read-back), so a positional
 * `mockResolvedValueOnce` chain would be pinning the shape of the RLS binding
 * rather than the receipt logic these tests are about. Routing on SQL keeps
 * the assertions on the behaviour and makes the binding's presence explicit
 * instead of accidental — the read-back must return the bound tenant, or
 * `bindTenantRlsContext` raises TenantContextError before any receipt query.
 */
function createManager(firstSelectRows: unknown[]): MockManager {
  let selectServed = false;
  return {
    query: jest.fn((sql: string) => {
      if (sql.includes('current_setting')) {
        return Promise.resolve([{ tenant: TENANT_ID, bypass: 'off' }]);
      }
      if (sql.includes('set_config')) {
        return Promise.resolve([]);
      }
      if (
        sql.includes('notification.command_receipts') &&
        sql.trimStart().startsWith('SELECT') &&
        !selectServed
      ) {
        selectServed = true;
        return Promise.resolve(firstSelectRows);
      }
      return Promise.resolve([]);
    }),
  };
}

/** Receipt statements only — the RLS binding is asserted separately. */
function receiptSql(manager: MockManager): string[] {
  return manager.query.mock.calls
    .map(([sql]) => String(sql))
    .filter((sql) => sql.includes('notification.command_receipts'));
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
    const manager = createManager([
      {
        payloadHash,
        status: 'STARTED',
        externalId: null,
        updatedAt: new Date(),
      },
    ]);
    dataSource.transaction.mockImplementation((callback: (manager: MockManager) => unknown) =>
      Promise.resolve(callback(manager)),
    );

    await expect(service.dispatchCommandNotification(input)).rejects.toThrow(
      /already in progress/i,
    );

    expect(rateLimit).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    // ORPHAN-HIGH-413: receipt work never leaves the bound transaction, so a
    // raw pooled-session query is itself the regression.
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('reclaims stale STARTED receipts before dispatching again', async () => {
    const { service, dataSource, sendNotification } = createService();
    const input = commandInput();
    const payloadHash = hashFor(service, input);
    const manager = createManager([
      {
        payloadHash,
        status: 'STARTED',
        externalId: null,
        updatedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    ]);
    dataSource.transaction.mockImplementation((callback: (manager: MockManager) => unknown) =>
      Promise.resolve(callback(manager)),
    );

    await expect(service.dispatchCommandNotification(input)).resolves.toEqual({
      externalId: 'provider-message-1',
      replayed: false,
    });

    const statements = receiptSql(manager);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('FOR UPDATE');
    expect(statements[1]).toContain("status = 'STARTED'");
    expect(statements[2]).toContain("status = 'SUCCEEDED'");
    expect(sendNotification).toHaveBeenCalledTimes(1);
    // The claim transaction plus the terminal receipt's own bound
    // transaction — never a raw dataSource.query on an unbound session.
    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('binds the command tenant transaction-locally before touching the receipt ledger', async () => {
    const { service, dataSource } = createService();
    const input = commandInput();
    const manager = createManager([]);
    dataSource.transaction.mockImplementation((callback: (manager: MockManager) => unknown) =>
      Promise.resolve(callback(manager)),
    );

    await service.dispatchCommandNotification(input);

    const calls = manager.query.mock.calls;
    const bindIndex = calls.findIndex(
      ([sql, params]) =>
        String(sql).includes('set_config') &&
        Array.isArray(params) &&
        params.includes('app.current_tenant'),
    );
    const firstReceiptIndex = calls.findIndex(([sql]) =>
      String(sql).includes('notification.command_receipts'),
    );

    expect(bindIndex).toBeGreaterThanOrEqual(0);
    expect(bindIndex).toBeLessThan(firstReceiptIndex);
    expect(calls[bindIndex]?.[1]).toEqual(['app.current_tenant', TENANT_ID]);
    // `, true` = transaction-local; session scope would leak this tenant into
    // whatever the pooled connection serves next.
    expect(String(calls[bindIndex]?.[0])).toContain('$2, true');
  });

  it('replays completed receipts without sending again', async () => {
    const { service, dataSource, rateLimit, sendNotification } = createService();
    const input = commandInput();
    const payloadHash = hashFor(service, input);
    const manager = createManager([
      {
        payloadHash,
        status: 'SUCCEEDED',
        externalId: 'provider-message-1',
        updatedAt: new Date(),
      },
    ]);
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
