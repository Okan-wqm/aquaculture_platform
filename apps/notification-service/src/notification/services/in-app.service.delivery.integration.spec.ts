import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, Repository } from 'typeorm';

import { Baseline1800000000000 } from '../../database/migrations/1800000000000-Baseline';
import { AddInAppNotificationDeliveryIdentity1801100000000 } from '../../database/migrations/1801100000000-AddInAppNotificationDeliveryIdentity';
import { NotificationLog } from '../entities/notification-log.entity';
import { InAppNotificationService } from './in-app.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DELIVERY_ID = `feeding-summary:${TENANT}:2026-07-17:user-1`;

describe('InAppNotificationService durable delivery (PostgreSQL)', () => {
  let postgres: HarnessContext | undefined;
  let applicationDataSource: DataSource | undefined;
  let notificationRepository: Repository<NotificationLog>;
  let service: InAppNotificationService;

  beforeAll(async () => {
    postgres = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    const queryRunner = postgres.dataSource.createQueryRunner();
    try {
      await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await queryRunner.query('CREATE SCHEMA "notification"');
      await new Baseline1800000000000().up(queryRunner);
      const migration = new AddInAppNotificationDeliveryIdentity1801100000000();
      await migration.up(queryRunner);
    } finally {
      await queryRunner.release();
    }

    applicationDataSource = new DataSource({
      type: 'postgres',
      ...postgres.connectionOptions,
      schema: 'notification',
      entities: [NotificationLog],
      synchronize: false,
      logging: false,
      name: 'notification-durable-delivery-integration',
    });
    await applicationDataSource.initialize();
    notificationRepository = new Repository(NotificationLog, applicationDataSource.manager);
    service = new InAppNotificationService(notificationRepository);
  }, 120_000);

  beforeEach(async () => {
    await notificationRepository.clear();
  });

  afterAll(async () => {
    if (applicationDataSource?.isInitialized) {
      await applicationDataSource.destroy();
    }
    await shutdownHarness(postgres);
  }, 30_000);

  it('migration establishes the entity column and partial unique index', async () => {
    if (!postgres) throw new Error('PostgreSQL harness did not initialize');
    if (!applicationDataSource) throw new Error('Application data source did not initialize');
    const queryRunner = postgres.dataSource.createQueryRunner();
    try {
      // The migration is convergent when invoked again by recovery tooling.
      const migration = new AddInAppNotificationDeliveryIdentity1801100000000();
      await migration.up(queryRunner);

      const table = await queryRunner.getTable('notification.notification_logs');
      const deliveryColumn = table?.findColumnByName('delivery_id');
      const deliveryIndex = table?.indices.find(
        (index) => index.name === 'uq_notification_logs_in_app_delivery',
      );

      expect(deliveryColumn).toMatchObject({
        isNullable: true,
        length: '255',
      });
      expect(deliveryIndex).toMatchObject({
        isUnique: true,
        columnNames: ['tenant_id', 'recipient', 'delivery_id'],
      });
      expect(deliveryIndex?.where).toContain('delivery_id');
      expect(deliveryIndex?.where).toContain('in_app');

      const entityMetadata = applicationDataSource.getMetadata(NotificationLog);
      const entityColumn = entityMetadata.findColumnWithPropertyName('deliveryId');
      const entityIndex = entityMetadata.indices.find(
        (index) => index.givenName === 'uq_notification_logs_in_app_delivery',
      );
      expect(entityColumn).toMatchObject({
        databaseName: 'delivery_id',
        isNullable: true,
        length: '255',
      });
      expect(entityIndex).toMatchObject({ isUnique: true });
      await expect(migration.postCondition(queryRunner)).resolves.toBe(true);
    } finally {
      await queryRunner.release();
    }
  });

  it.each([
    {
      drift: 'ALTER COLUMN "delivery_id" SET NOT NULL',
      label: 'nullability',
      restore: 'ALTER COLUMN "delivery_id" DROP NOT NULL',
    },
    {
      drift: 'ALTER COLUMN "delivery_id" TYPE varchar(254)',
      label: 'varchar length',
      restore: 'ALTER COLUMN "delivery_id" TYPE varchar(255)',
    },
  ])('postCondition rejects $label drift that IF NOT EXISTS cannot repair', async (testCase) => {
    if (!postgres) throw new Error('PostgreSQL harness did not initialize');
    const queryRunner = postgres.dataSource.createQueryRunner();
    const migration = new AddInAppNotificationDeliveryIdentity1801100000000();
    try {
      await queryRunner.query(`ALTER TABLE "notification"."notification_logs" ${testCase.drift}`);
      await migration.up(queryRunner);
      await expect(migration.postCondition(queryRunner)).resolves.toBe(false);
    } finally {
      await queryRunner.query(`ALTER TABLE "notification"."notification_logs" ${testCase.restore}`);
      await queryRunner.release();
    }
  });

  it.each([
    {
      ddl: `CREATE INDEX "uq_notification_logs_in_app_delivery"
              ON "notification"."notification_logs"
                 ("tenant_id", "recipient", "delivery_id")
             WHERE "channel" = 'in_app' AND "delivery_id" IS NOT NULL`,
      label: 'non-unique index',
    },
    {
      ddl: `CREATE UNIQUE INDEX "uq_notification_logs_in_app_delivery"
              ON "notification"."notification_logs"
                 ("recipient", "tenant_id", "delivery_id")
             WHERE "channel" = 'in_app' AND "delivery_id" IS NOT NULL`,
      label: 'wrong key order',
    },
    {
      ddl: `CREATE UNIQUE INDEX "uq_notification_logs_in_app_delivery"
              ON "notification"."notification_logs"
                 ("tenant_id", "recipient", "delivery_id")
             WHERE "delivery_id" IS NOT NULL`,
      label: 'wrong partial predicate',
    },
  ])('postCondition rejects a same-named $label', async (testCase) => {
    if (!postgres) throw new Error('PostgreSQL harness did not initialize');
    const queryRunner = postgres.dataSource.createQueryRunner();
    const migration = new AddInAppNotificationDeliveryIdentity1801100000000();
    try {
      await queryRunner.query('DROP INDEX "notification"."uq_notification_logs_in_app_delivery"');
      await queryRunner.query(testCase.ddl);

      // IF NOT EXISTS preserves this drift; the post-condition must still fail closed.
      await migration.up(queryRunner);
      await expect(migration.postCondition(queryRunner)).resolves.toBe(false);
    } finally {
      await queryRunner.query(
        'DROP INDEX IF EXISTS "notification"."uq_notification_logs_in_app_delivery"',
      );
      await migration.up(queryRunner);
      await queryRunner.release();
    }
  });

  it('concurrent attempts with one delivery identity create exactly one row', async () => {
    const delivery = {
      tenantId: TENANT,
      userId: 'user-1',
      title: 'Günlük yemleme özeti — 2026-07-17',
      body: '8/10 ünite tamamlandı',
      deliveryId: DELIVERY_ID,
      data: { type: 'FeedingDailySummary', planDate: '2026-07-17' },
    };

    await Promise.all(Array.from({ length: 16 }, () => service.ensureNotification(delivery)));

    await expect(
      notificationRepository.count({
        where: {
          tenantId: TENANT,
          recipient: 'user-1',
          deliveryId: DELIVERY_ID,
        },
      }),
    ).resolves.toBe(1);
  });

  it('the same opaque delivery id remains isolated by tenant and recipient', async () => {
    await service.ensureNotification({
      tenantId: TENANT,
      userId: 'user-1',
      title: 'Summary',
      body: 'First recipient',
      deliveryId: 'shared-opaque-key',
    });
    await service.ensureNotification({
      tenantId: TENANT,
      userId: 'user-2',
      title: 'Summary',
      body: 'Second recipient',
      deliveryId: 'shared-opaque-key',
    });

    await expect(
      notificationRepository.count({ where: { deliveryId: 'shared-opaque-key' } }),
    ).resolves.toBe(2);
  });
});
