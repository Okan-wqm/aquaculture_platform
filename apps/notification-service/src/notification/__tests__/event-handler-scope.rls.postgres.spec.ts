import { randomBytes } from 'node:crypto';

import { TenantEventHandlerScope } from '@aquaculture/backend-common/context';
import {
  applyTenantRlsToSchema,
  createRlsConnectionBootstrap,
} from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { ConfigService } from '@nestjs/config';
import { HandlerOutcome, NatsEventBus, type IEvent, type IEventHandler } from '@platform/event-bus';
import { DataSource } from 'typeorm';

import {
  NotificationChannel,
  NotificationLog,
  NotificationStatus,
} from '../entities/notification-log.entity';

/**
 * PLAT-HIGH-936 on real Postgres, with notification-service's own policy:
 * FORCE RLS on `notification.notification_logs`, a non-owner NOBYPASSRLS runtime
 * role, and the RLS pool patch every service installs (it reads the tenant from
 * the AsyncLocalStorage frame at each checkout).
 *
 * A NATS handler has no HTTP request, so no frame: the TaskOverdue handler's
 * insert was refused ("new row violates row-level security policy for table
 * notification_logs") on every redelivery, 8 times a minute in production. The
 * bus now runs each handler inside the event tenant's frame.
 */
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUNTIME_ROLE = 'notification_scope_rls_test';
const SUBJECT = 'events.*.TaskOverdue';

jest.setTimeout(240_000);

function taskOverdue(tenantId: string): IEvent {
  return {
    eventId: '55555555-5555-4555-8555-555555555555',
    eventType: 'TaskOverdue',
    timestamp: '2026-10-27T12:00:00.000Z',
    tenantId,
    version: 2,
  };
}

interface FakeJsMsg {
  ack: jest.Mock;
  nak: jest.Mock;
  term: jest.Mock;
  string: () => string;
  info: { deliveryCount: number };
}

describe('event handler tenant scope under notification_logs FORCE RLS', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  let runtime: DataSource | undefined;

  function row(tenantId: string): Partial<NotificationLog> {
    return {
      tenantId,
      channel: NotificationChannel.IN_APP,
      recipient: 'user-1',
      subject: 'Task overdue',
      content: 'template:task.TaskOverdue',
      status: NotificationStatus.PENDING,
    };
  }

  async function ownerCount(tenantId: string): Promise<number> {
    const result: Array<{ n: string }> = await admin!.query(
      'SELECT count(*) AS n FROM notification.notification_logs WHERE tenant_id = $1',
      [tenantId],
    );
    return Number(result[0]?.n);
  }

  /** The bus delivering one event to a handler that writes a notification row. */
  function deliver(tenantId: string, scope?: TenantEventHandlerScope): Promise<FakeJsMsg> {
    const handler: IEventHandler<IEvent> = {
      getEventType: () => 'TaskOverdue',
      handle: async () => {
        await runtime!.manager.save(
          NotificationLog,
          runtime!.manager.create(NotificationLog, row(tenantId)),
        );
        return HandlerOutcome.ack();
      },
    };
    const bus = new NatsEventBus(
      new ConfigService({
        NATS_STREAM_NAME: 'AQUACULTURE_EVENTS',
        SERVICE_NAME: 'notification-service',
      }),
      undefined,
      undefined,
      undefined,
      scope,
    );
    Reflect.set(bus, 'handlers', new Map([[SUBJECT, [handler]]]));
    Reflect.set(bus, 'subscriptionOptions', new Map([[SUBJECT, { maxRetries: 5 }]]));
    const msg: FakeJsMsg = {
      ack: jest.fn(),
      nak: jest.fn(),
      term: jest.fn(),
      string: () => JSON.stringify(taskOverdue(tenantId)),
      info: { deliveryCount: 1 },
    };
    const process = Reflect.get(bus, 'processConsumerMessage') as (
      this: NatsEventBus,
      subject: string,
      msg: FakeJsMsg,
    ) => Promise<void>;
    return process.call(bus, SUBJECT, msg).then(() => msg);
  }

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    await harness.dataSource.query('CREATE SCHEMA notification');
    // The real entity creates the real table, owned by the superuser.
    admin = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: `notification-scope-admin-${randomBytes(4).toString('hex')}`,
      entities: [NotificationLog],
      synchronize: true,
      logging: false,
    });
    await admin.initialize();

    const password = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN NOBYPASSRLS PASSWORD '${password}'`);
    const previous = process.env['DB_MIGRATE_DDL_AUTHORITY'];
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    try {
      const qr = admin.createQueryRunner();
      await applyTenantRlsToSchema(qr, { schemaOverride: 'notification' });
      await qr.release();
    } finally {
      if (previous === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
      else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previous;
    }
    await admin.query(`GRANT USAGE ON SCHEMA notification TO ${RUNTIME_ROLE}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA notification TO ${RUNTIME_ROLE}`,
    );

    runtime = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: RUNTIME_ROLE,
      password,
      name: `notification-scope-runtime-${randomBytes(4).toString('hex')}`,
      entities: [NotificationLog],
      synchronize: false,
      logging: false,
    });
    await runtime.initialize();
    // The same pool patch the service installs: GUCs come from the frame.
    const Bootstrap = createRlsConnectionBootstrap('notification');
    new Bootstrap(runtime).onModuleInit();
  });

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (admin?.isInitialized) await admin.destroy();
    if (harness) await shutdownHarness(harness);
  });

  it('BEFORE: an event handler with no scope is refused by the policy (the production failure)', async () => {
    const msg = await deliver(TENANT_A);

    expect(msg.nak).toHaveBeenCalledTimes(1); // retried forever: the poison loop
    expect(msg.ack).not.toHaveBeenCalled();
    expect(await ownerCount(TENANT_A)).toBe(0);
  });

  it("AFTER: the bus scope binds the event's tenant and the handler's write lands for that tenant", async () => {
    const msg = await deliver(TENANT_A, new TenantEventHandlerScope());

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.nak).not.toHaveBeenCalled();
    expect(await ownerCount(TENANT_A)).toBe(1);
    expect(await ownerCount(TENANT_B)).toBe(0);
  });

  it('keeps tenants apart: an event for tenant B writes tenant B, and A cannot see it', async () => {
    const scope = new TenantEventHandlerScope();
    const msg = await deliver(TENANT_B, scope);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(await ownerCount(TENANT_B)).toBe(1);

    const seenByA = await scope.run(taskOverdue(TENANT_A), () =>
      runtime!.manager.find(NotificationLog),
    );
    expect(seenByA.map((log) => log.tenantId)).toEqual([TENANT_A]);
    const seenByB = await scope.run(taskOverdue(TENANT_B), () =>
      runtime!.manager.find(NotificationLog),
    );
    expect(seenByB.map((log) => log.tenantId)).toEqual([TENANT_B]);
  });

  it('a handler cannot write another tenant than its event: the policy still refuses it', async () => {
    const handler: IEventHandler<IEvent> = {
      getEventType: () => 'TaskOverdue',
      handle: async () => {
        // event is for A, row is for B
        await runtime!.manager.save(
          NotificationLog,
          runtime!.manager.create(NotificationLog, row(TENANT_B)),
        );
        return HandlerOutcome.ack();
      },
    };
    const bus = new NatsEventBus(
      new ConfigService({
        NATS_STREAM_NAME: 'AQUACULTURE_EVENTS',
        SERVICE_NAME: 'notification-service',
      }),
      undefined,
      undefined,
      undefined,
      new TenantEventHandlerScope(),
    );
    Reflect.set(bus, 'handlers', new Map([[SUBJECT, [handler]]]));
    Reflect.set(bus, 'subscriptionOptions', new Map([[SUBJECT, { maxRetries: 5 }]]));
    const msg: FakeJsMsg = {
      ack: jest.fn(),
      nak: jest.fn(),
      term: jest.fn(),
      string: () => JSON.stringify(taskOverdue(TENANT_A)),
      info: { deliveryCount: 1 },
    };
    const before = await ownerCount(TENANT_B);

    await (
      Reflect.get(bus, 'processConsumerMessage') as (
        this: NatsEventBus,
        subject: string,
        msg: FakeJsMsg,
      ) => Promise<void>
    ).call(bus, SUBJECT, msg);

    expect(msg.ack).not.toHaveBeenCalled();
    expect(await ownerCount(TENANT_B)).toBe(before);
  });
});
