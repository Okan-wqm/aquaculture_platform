/**
 * AlertEscalated → notification rows — on real Postgres (ALERT-CRITICAL-004).
 *
 * WHY Postgres: the alarm's last mile is only as idempotent as two database
 * facts — the partial unique index that makes an in-app row per
 * (tenant, recipient, delivery id) unique, and the command receipts that make
 * a push/e-mail send happen once per delivery id. A redelivered AlertEscalated
 * (the bus is at-least-once) must re-send nothing that already landed; mocks
 * cannot prove that.
 *
 * The event is the registry fixture `libs/event-contracts/fixtures/alert-escalated.json`,
 * the same shape alert-engine's Testcontainers suite proves its escalation
 * enqueues (`apps/alert-engine/src/__tests__/integration/farm-signal-delivery.postgres.spec.ts`)
 * and the contract spec pins against the boundary schema. Together the two suites
 * cover farm event → incident → AlertEscalated → notification rows; a service's
 * test cannot import another service, so the fixture is the join.
 *
 * Real: the handler, the dispatcher, the in-app writer, the device-token read,
 * the notification schema (the service's own migrations). Doubled: the e-mail and
 * push PROVIDERS (external systems) and the two auth-service HTTP lookups on the
 * contact directory (another service).
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SsrfValidatorService } from '@aquaculture/backend-common/ai-safety';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  PLATFORM_EVENT_REGISTRY,
  checkAlertEscalatedEvent,
  type AlertEscalatedEvent,
} from '@platform/event-contracts';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type MigrationInterface } from 'typeorm';

import { Baseline1800000000000 } from '../../database/migrations/1800000000000-Baseline';
import { UniqueActiveDeviceTokenOwner1800100000000 } from '../../database/migrations/1800100000000-UniqueActiveDeviceTokenOwner';
import { CreateNotificationCommandReceipts1800200000000 } from '../../database/migrations/1800200000000-CreateNotificationCommandReceipts';
import { CreateNotificationInAppDeliveryReceipt1801100000000 } from '../../database/migrations/1801100000000-CreateNotificationInAppDeliveryReceipt';
import { DeviceToken } from '../../notification/entities/device-token.entity';
import { NotificationLog } from '../../notification/entities/notification-log.entity';
import { AlertEscalatedEventHandler } from '../../notification/event-handlers/alert-escalated.handler';
import { EmailService } from '../../notification/services/email.service';
import { InAppNotificationService } from '../../notification/services/in-app.service';
import { NotificationDispatcherService } from '../../notification/services/notification-dispatcher.service';
import { PushService } from '../../notification/services/push.service';
import { SmsService } from '../../notification/services/sms.service';
import { UserContactDirectory } from '../../notification/services/user-contact-directory.service';

const MANAGER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';

jest.setTimeout(180_000);

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

/** The registry's canonical AlertEscalated, validated exactly as the handler validates it. */
function fixtureEvent(): AlertEscalatedEvent {
  const raw: unknown = JSON.parse(
    readFileSync(resolve(REPO_ROOT, PLATFORM_EVENT_REGISTRY.AlertEscalated.fixture), 'utf8'),
  );
  const checked = checkAlertEscalatedEvent(raw);
  if (!checked.ok) throw new Error(`fixture drifted from the contract: ${checked.reason}`);
  return checked.value;
}

const MIGRATIONS: MigrationInterface[] = [
  new Baseline1800000000000(),
  new UniqueActiveDeviceTokenOwner1800100000000(),
  new CreateNotificationCommandReceipts1800200000000(),
  new CreateNotificationInAppDeliveryReceipt1801100000000(),
];

describe('AlertEscalated delivery on real Postgres (ALERT-CRITICAL-004)', () => {
  let harness: HarnessContext | undefined;
  let moduleClose: (() => Promise<void>) | undefined;
  let admin: DataSource;
  let handler: AlertEscalatedEventHandler;
  const sendAlertEmail = jest.fn(async (to: string) => `email-${to}`);
  const sendPushNotification = jest.fn(async (token: string) => `push-${token}`);

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    admin = harness.dataSource;
    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query('CREATE SCHEMA notification');
    const runner = admin.createQueryRunner();
    await runner.connect();
    try {
      for (const migration of MIGRATIONS) await migration.up(runner);
    } finally {
      await runner.release();
    }

    const connection = harness.connectionOptions;
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: connection.host,
          port: connection.port,
          database: connection.database,
          username: connection.username,
          password: connection.password,
          entities: [NotificationLog, DeviceToken],
          synchronize: false,
          logging: false,
        }),
        TypeOrmModule.forFeature([NotificationLog, DeviceToken]),
      ],
      providers: [
        AlertEscalatedEventHandler,
        NotificationDispatcherService,
        InAppNotificationService,
        UserContactDirectory,
        { provide: EmailService, useValue: { sendAlertEmail } },
        { provide: PushService, useValue: { sendPushNotification } },
        { provide: SmsService, useValue: {} },
        { provide: SsrfValidatorService, useValue: {} },
        { provide: 'EVENT_BUS', useValue: { subscribeWildcard: jest.fn() } },
      ],
    }).compile();
    moduleClose = () => moduleRef.close();

    // auth-service owns who holds the targeted roles and their addresses.
    const contacts = moduleRef.get(UserContactDirectory);
    jest
      .spyOn(contacts, 'alertRecipients')
      .mockResolvedValue({ userIds: [ADMIN, MANAGER], truncated: false });
    jest.spyOn(contacts, 'email').mockImplementation(async (_t, userId) => `${userId}@farm.test`);

    handler = moduleRef.get(AlertEscalatedEventHandler);
  });

  afterAll(async () => {
    await moduleClose?.();
    await shutdownHarness(harness);
  });

  async function rowsFor(tenantId: string): Promise<Array<{ channel: string; recipient: string }>> {
    return admin.query(
      `SELECT channel::text AS channel, recipient
         FROM notification.notification_logs
        WHERE tenant_id = $1
        ORDER BY channel, recipient`,
      [tenantId],
    );
  }

  it('writes one notification per recipient and channel, and a redelivery re-sends nothing', async () => {
    // SCENARIO: the critical-water escalation reaches notification-service; the site
    //           manager has a registered phone, the tenant admin does not. The bus
    //           then delivers the same event a second time.
    // EXPECTS: first delivery — an in-app row for both, a push row for the manager,
    //          an e-mail row for both, each provider called once per send; the
    //          redelivery adds no row and calls no provider again.
    const event = fixtureEvent();
    await admin.query(
      `INSERT INTO notification.device_tokens (user_id, tenant_id, token, platform, last_seen_at)
       VALUES ($1, $2, 'fcm-manager', 'android', now())`,
      [MANAGER, event.tenantId],
    );

    await expect(handler.handle(event)).resolves.toEqual(expect.objectContaining({ kind: 'ack' }));

    // Ordered as the query sorts (channel, then recipient: MANAGER < ADMIN).
    const expected = [
      { channel: 'email', recipient: `userId:${MANAGER}` },
      { channel: 'email', recipient: `userId:${ADMIN}` },
      { channel: 'in_app', recipient: MANAGER },
      { channel: 'in_app', recipient: ADMIN },
      { channel: 'push', recipient: `userId:${MANAGER}` },
    ];
    expect(await rowsFor(event.tenantId)).toEqual(expected);
    expect(sendAlertEmail).toHaveBeenCalledTimes(2);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(sendPushNotification).toHaveBeenCalledWith(
      'fcm-manager',
      expect.objectContaining({ title: '[KRİTİK] Water Quality Critical: tank T1' }),
    );

    await expect(handler.handle(event)).resolves.toEqual(expect.objectContaining({ kind: 'ack' }));

    expect(await rowsFor(event.tenantId)).toEqual(expected);
    expect(sendAlertEmail).toHaveBeenCalledTimes(2);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });
});
