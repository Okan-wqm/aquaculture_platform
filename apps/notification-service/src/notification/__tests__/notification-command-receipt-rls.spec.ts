/**
 * ORPHAN-HIGH-413 — the notification command-receipt ledger must be written
 * under an RLS tenant context.
 *
 * `notification.command_receipts` carries the canonical
 * `tenant_isolation_policy`: it is in `MODULE_SCHEMAS['notification'].tables`
 * and NOT in that module's `infrastructureTables`, so
 * `getRlsExcludeTablesForService('notification')` never exempts it. A row is
 * readable/writable only under `app.bypass_rls = 'on'`, or when
 * `app.current_tenant` equals the row's `tenantId`.
 *
 * The `SEND_EMAIL` / `SEND_PUSH` NATS commands arrive with NO HTTP frame, so
 * `TenantContextMiddleware` never runs and `RlsConnectionBootstrap` seeds the
 * checkout GUCs with the deny-by-default pair (`''`, `'off'`). Every receipt
 * statement therefore ran with neither control set: the `FOR UPDATE` probe
 * returned an empty result *silently* (so a replay looked like a first
 * delivery) and the INSERT was refused outright — the same defect class as
 * billing ORPHAN-CRITICAL-412 and auth ORPHAN-CRITICAL-573.
 *
 * These tests do not mock the policy away — the fake data source SIMULATES it:
 * transaction-local GUC lifetime, deny-by-default at session level,
 * silent-empty on a denied SELECT and a raised `new row violates row-level
 * security policy` on a denied INSERT/UPDATE. A dispatch that does not bind
 * its own tenant context cannot pass them.
 */
import { getRequestContext } from '@aquaculture/backend-common/logging';

import { NotificationChannel } from '../entities/notification-log.entity';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';

const TENANT_ID = '7d3f2b9a-8c41-4d9e-8b21-0f6c5e4a1b77';
const RECIPIENT_USER_ID = '11111111-2222-4333-8444-555555555555';

interface ReceiptRow {
  tenantId: string;
  channel: string;
  requestReference: string;
  deliveryId: string;
  source: string;
  payloadHash: string;
  status: 'STARTED' | 'SUCCEEDED' | 'FAILED';
  externalId: string | null;
  error: string | null;
  updatedAt: Date;
}

interface RecordedStatement {
  sql: string;
  params: unknown[];
  /** GUC state at the instant the statement executed. */
  tenantGuc: string;
  bypassGuc: 'on' | 'off';
}

class RlsViolationError extends Error {
  constructor(table: string) {
    super(`new row violates row-level security policy for table "${table}"`);
    this.name = 'RlsViolationError';
  }
}

/**
 * A minimal PostgreSQL stand-in that enforces the same predicate the real
 * `tenant_isolation_policy` enforces, with the same GUC lifetime rules:
 * `set_config(..., true)` is transaction-local and disappears when the
 * transaction ends, so work done outside a transaction sees only the
 * session-level (deny-by-default) pair a NATS checkout leaves behind.
 */
class RlsSimulatingDataSource {
  sessionTenant = '';
  sessionBypass: 'on' | 'off' = 'off';
  readonly rows: ReceiptRow[] = [];
  readonly statements: RecordedStatement[] = [];

  private txTenant: string | null = null;
  private txBypass: 'on' | 'off' | null = null;
  private inTransaction = false;

  transaction = async <T>(
    runInTransaction: (manager: { query: RlsSimulatingDataSource['query'] }) => Promise<T>,
  ): Promise<T> => {
    this.inTransaction = true;
    this.txTenant = null;
    this.txBypass = null;
    try {
      return await runInTransaction({ query: this.query });
    } finally {
      // Transaction-local settings do not outlive the transaction.
      this.inTransaction = false;
      this.txTenant = null;
      this.txBypass = null;
    }
  };

  query = async (sql: string, params: unknown[] = []): Promise<unknown> => {
    this.statements.push({
      sql,
      params,
      tenantGuc: this.currentTenant(),
      bypassGuc: this.currentBypass(),
    });

    if (sql.includes('set_config')) {
      return this.applySetConfig(sql, params);
    }
    if (sql.includes('current_setting')) {
      return [{ tenant: this.currentTenant(), bypass: this.currentBypass() }];
    }
    if (sql.includes('notification.command_receipts')) {
      return this.runReceiptStatement(sql, params);
    }
    return [];
  };

  private currentTenant(): string {
    return this.txTenant ?? this.sessionTenant;
  }

  private currentBypass(): 'on' | 'off' {
    return this.txBypass ?? this.sessionBypass;
  }

  private applySetConfig(sql: string, params: unknown[]): unknown[] {
    const gucName = String(params[0] ?? '');
    // `set_config($1, $2, true)` — transaction-local when the third argument
    // is true, session-wide otherwise.
    const isLocal = /,\s*true\s*\)/.test(sql);
    const value = /'off'/.test(sql) ? 'off' : String(params[1] ?? '');

    if (gucName === 'app.current_tenant') {
      if (isLocal && this.inTransaction) {
        this.txTenant = value;
      } else {
        this.sessionTenant = value;
      }
    }
    if (gucName === 'app.bypass_rls') {
      const bypass: 'on' | 'off' = value === 'on' ? 'on' : 'off';
      if (isLocal && this.inTransaction) {
        this.txBypass = bypass;
      } else {
        this.sessionBypass = bypass;
      }
    }
    return [];
  }

  /** The policy: `app.bypass_rls = 'on' OR "tenantId" = app.current_tenant`. */
  private isVisible(tenantId: string): boolean {
    return this.currentBypass() === 'on' || this.currentTenant() === tenantId;
  }

  private runReceiptStatement(sql: string, params: unknown[]): unknown {
    const trimmed = sql.trimStart();
    const tenantId = String(params[0] ?? '');
    const channel = String(params[1] ?? '');
    const requestReference = String(params[2] ?? '');

    if (trimmed.startsWith('SELECT')) {
      // A denied SELECT is NOT an error — it silently returns nothing, which
      // is precisely why this defect was invisible in the logs.
      if (!this.isVisible(tenantId)) {
        return [];
      }
      return this.rows
        .filter(
          (row) =>
            row.tenantId === tenantId &&
            row.channel === channel &&
            row.requestReference === requestReference,
        )
        .map((row) => ({
          payloadHash: row.payloadHash,
          status: row.status,
          externalId: row.externalId,
          updatedAt: row.updatedAt,
        }));
    }

    if (trimmed.startsWith('INSERT')) {
      if (!this.isVisible(tenantId)) {
        throw new RlsViolationError('command_receipts');
      }
      this.rows.push({
        tenantId,
        channel,
        requestReference,
        deliveryId: String(params[3] ?? ''),
        source: String(params[4] ?? ''),
        payloadHash: String(params[5] ?? ''),
        status: 'STARTED',
        externalId: null,
        error: null,
        updatedAt: new Date(),
      });
      return [];
    }

    if (trimmed.startsWith('UPDATE')) {
      if (!this.isVisible(tenantId)) {
        throw new RlsViolationError('command_receipts');
      }
      const target = this.rows.find(
        (row) =>
          row.tenantId === tenantId &&
          row.channel === channel &&
          row.requestReference === requestReference,
      );
      if (target) {
        if (sql.includes("status = 'SUCCEEDED'")) {
          target.status = 'SUCCEEDED';
          target.externalId = params[3] === null ? null : String(params[3]);
        } else if (sql.includes("status = 'FAILED'")) {
          target.status = 'FAILED';
          target.error = String(params[3] ?? '');
        } else if (sql.includes("status = 'STARTED'")) {
          target.status = 'STARTED';
        }
        target.updatedAt = new Date();
      }
      return [];
    }

    return [];
  }
}

function createDispatcher(dataSource: RlsSimulatingDataSource): {
  dispatcher: NotificationDispatcherService;
  pushService: { sendPushNotification: jest.Mock; sendAlertPush: jest.Mock };
  /** Tenant visible to AsyncLocalStorage when the log repository writes. */
  logWriteTenants: (string | undefined)[];
} {
  const pushService = {
    sendPushNotification: jest.fn().mockResolvedValue('fcm-message-1'),
    sendAlertPush: jest.fn().mockResolvedValue('fcm-message-1'),
  };
  const logWriteTenants: (string | undefined)[] = [];
  const logRepository = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn(() => {
      // `RlsConnectionBootstrap` reads exactly this frame at pool checkout to
      // set app.current_tenant for the notification_logs INSERT.
      logWriteTenants.push(getRequestContext()?.tenantId);
      return Promise.resolve(undefined);
    }),
  };
  const redisService = {
    incrby: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(undefined),
  };
  const configService = { get: jest.fn().mockReturnValue(undefined) };

  const dispatcher = new NotificationDispatcherService(
    logRepository as never,
    {} as never,
    {} as never,
    pushService as never,
    dataSource as never,
    configService as never,
    {} as never,
    redisService as never,
  );

  return { dispatcher, pushService, logWriteTenants };
}

const commandInput = {
  tenantId: TENANT_ID,
  channel: NotificationChannel.PUSH,
  recipient: 'device-token-abc',
  recipientLogRef: `userId:${RECIPIENT_USER_ID}`,
  deliveryId: 'delivery-1',
  requestReference: 'messaging:msg-1',
  source: 'messaging-service',
  subject: 'New message',
  message: 'Open the app to read the message.',
};

function receiptStatements(dataSource: RlsSimulatingDataSource): RecordedStatement[] {
  return dataSource.statements.filter((s) => s.sql.includes('notification.command_receipts'));
}

describe('ORPHAN-HIGH-413: notification command receipts run under an RLS tenant context', () => {
  it('completes a NATS-originated dispatch that carries no ambient tenant context', async () => {
    // The session GUCs are the deny-by-default pair a NATS checkout produces.
    // Before the fix the receipt INSERT was refused here.
    const dataSource = new RlsSimulatingDataSource();
    const { dispatcher } = createDispatcher(dataSource);

    const result = await dispatcher.dispatchCommandNotification(commandInput);

    expect(result).toEqual({ externalId: 'fcm-message-1', replayed: false });
    expect(dataSource.rows).toHaveLength(1);
    expect(dataSource.rows[0]).toMatchObject({
      tenantId: TENANT_ID,
      status: 'SUCCEEDED',
      externalId: 'fcm-message-1',
    });
  });

  it('binds the command tenant before the FIRST receipt statement, transaction-locally', async () => {
    const dataSource = new RlsSimulatingDataSource();
    const { dispatcher } = createDispatcher(dataSource);

    await dispatcher.dispatchCommandNotification(commandInput);

    const firstReceiptIndex = dataSource.statements.findIndex((s) =>
      s.sql.includes('notification.command_receipts'),
    );
    const gucIndex = dataSource.statements.findIndex(
      (s) => s.sql.includes('set_config') && s.params.includes('app.current_tenant'),
    );

    expect(gucIndex).toBeGreaterThanOrEqual(0);
    expect(firstReceiptIndex).toBeGreaterThanOrEqual(0);
    // A context set after the statement is a context the statement never had.
    expect(gucIndex).toBeLessThan(firstReceiptIndex);

    const gucStatement = dataSource.statements[gucIndex];
    expect(gucStatement?.params).toEqual(['app.current_tenant', TENANT_ID]);
    // Third argument `true` = transaction-local; a session-wide setting would
    // leak this tenant into whatever the pooled connection serves next.
    expect(gucStatement?.sql).toContain('$2, true');
  });

  it('holds the tenant context for EVERY receipt statement, including those outside the claim transaction', async () => {
    const dataSource = new RlsSimulatingDataSource();
    const { dispatcher } = createDispatcher(dataSource);

    await dispatcher.dispatchCommandNotification(commandInput);

    const receipts = receiptStatements(dataSource);
    // claim SELECT + claim INSERT + success UPDATE
    expect(receipts.length).toBeGreaterThanOrEqual(3);
    for (const statement of receipts) {
      expect(statement.tenantGuc).toBe(TENANT_ID);
      // Honest tenant scoping, not a switched-off policy.
      expect(statement.bypassGuc).toBe('off');
    }
  });

  it('binds the tenant for the failure receipt written after the provider throws', async () => {
    const dataSource = new RlsSimulatingDataSource();
    const { dispatcher, pushService } = createDispatcher(dataSource);
    pushService.sendPushNotification.mockRejectedValue(new Error('FCM unavailable'));
    pushService.sendAlertPush.mockRejectedValue(new Error('FCM unavailable'));

    await expect(dispatcher.dispatchCommandNotification(commandInput)).rejects.toThrow(
      'FCM unavailable',
    );

    const failureUpdate = receiptStatements(dataSource).find((s) =>
      s.sql.includes("status = 'FAILED'"),
    );
    expect(failureUpdate).toBeDefined();
    expect(failureUpdate?.tenantGuc).toBe(TENANT_ID);
    expect(dataSource.rows[0]?.status).toBe('FAILED');
  });

  it('writes notification_logs inside the tenant frame, whatever door the caller came through', async () => {
    // The log write goes through a TypeORM repository, so it is NOT covered by
    // the hand-written receipt binding — it depends on AsyncLocalStorage being
    // seeded. The @MessagePattern interceptor does that for SEND_* commands,
    // but the eventBus subscribers (feeding-daily-summary, task-event) call
    // this same method with no interceptor in the path. Establishing the frame
    // in the dispatcher is what makes both doors safe.
    const dataSource = new RlsSimulatingDataSource();
    const { dispatcher, logWriteTenants } = createDispatcher(dataSource);

    expect(getRequestContext()?.tenantId).toBeUndefined();
    await dispatcher.dispatchCommandNotification(commandInput);

    expect(logWriteTenants).toEqual([TENANT_ID]);
    // And the frame does not outlive the dispatch.
    expect(getRequestContext()?.tenantId).toBeUndefined();
  });

  it('leaves no tenant behind on the pooled session after the dispatch', async () => {
    const dataSource = new RlsSimulatingDataSource();
    const { dispatcher } = createDispatcher(dataSource);

    await dispatcher.dispatchCommandNotification(commandInput);

    expect(dataSource.sessionTenant).toBe('');
    expect(dataSource.sessionBypass).toBe('off');
  });

  it('sees a prior receipt on replay instead of a silent empty read', async () => {
    const dataSource = new RlsSimulatingDataSource();
    const { dispatcher } = createDispatcher(dataSource);

    await dispatcher.dispatchCommandNotification(commandInput);
    const replay = await dispatcher.dispatchCommandNotification(commandInput);

    expect(replay).toEqual({ externalId: 'fcm-message-1', replayed: true });
    expect(dataSource.rows).toHaveLength(1);
  });
});
