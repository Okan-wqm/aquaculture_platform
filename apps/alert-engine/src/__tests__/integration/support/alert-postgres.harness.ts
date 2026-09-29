import 'reflect-metadata';
import { randomBytes } from 'node:crypto';

import {
  createRlsConnectionBootstrap,
  createTenantConnectionBootstrap,
  getTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, type MigrationInterface } from 'typeorm';

import { AlertHistory } from '../../../alert/entities/alert-history.entity';
import { AlertAuditService } from '../../../audit/alert-audit.service';
import { AlertIncident } from '../../../database/entities/alert-incident.entity';
import { AlertRule } from '../../../database/entities/alert-rule.entity';
import { EscalationPolicy } from '../../../database/entities/escalation-policy.entity';
import { Baseline1800000000000 } from '../../../database/migrations/1800000000000-Baseline';
import { AlignAlertTenantColumnsToUuid1800100000000 } from '../../../database/migrations/1800100000000-AlignAlertTenantColumnsToUuid';
import { CreateAlertOutbox1800200000000 } from '../../../database/migrations/1800200000000-CreateAlertOutbox';
import { AddAlertHistorySourceEventId1801100000000 } from '../../../database/migrations/1801100000000-AddAlertHistorySourceEventId';
import { FarmSignalIncidentDelivery1801200000000 } from '../../../database/migrations/1801200000000-FarmSignalIncidentDelivery';
import { AlertOutbox } from '../../../outbox/alert-outbox.entity';
import { createRedisServiceMock } from '../../support/redis-service.mock';

/**
 * alert-engine's real-Postgres harness: the schema is built by replaying the
 * service's OWN migrations into the source schema and each tenant schema (the
 * provisioner's replay), and every service runs as a non-superuser role through
 * the production pool patches (search_path + RLS GUC), so RLS applies exactly
 * as in production.
 */
export const RUNTIME_ROLE = 'alert_runtime_s1';

/** Migrations a tenant schema receives (the source-only outbox/ledger ones excluded). */
export const TENANT_MIGRATIONS: MigrationInterface[] = [
  new Baseline1800000000000(),
  new AlignAlertTenantColumnsToUuid1800100000000(),
  new AddAlertHistorySourceEventId1801100000000(),
  new FarmSignalIncidentDelivery1801200000000(),
];

export async function replay(
  admin: DataSource,
  schema: string,
  migrations: MigrationInterface[],
): Promise<void> {
  // The replay plays aqua-db-migrate's part: the Baseline's RLS install is gated
  // to that process, so the authority is held only while migrations run.
  const previousAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
  process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
  const runner = admin.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    await runner.query(`SELECT pg_catalog.set_config('search_path', $1, true)`, [
      `"${schema}", public`,
    ]);
    for (const migration of migrations) {
      await migration.up(runner);
    }
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    if (previousAuthority === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
    else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousAuthority;
  }
}

export async function provisionTenant(admin: DataSource, tenantId: string): Promise<void> {
  const schema = getTenantSchemaName(tenantId);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await replay(admin, schema, TENANT_MIGRATIONS);
  await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${RUNTIME_ROLE}`);
  await admin.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${RUNTIME_ROLE}`,
  );
}

/** The db-migrate ledger's verified mapping, as a fixed set of committed tenants. */
export async function publishLedger(admin: DataSource, tenantIds: string[]): Promise<void> {
  const rows = tenantIds
    .map((id) => `('${getTenantSchemaName(id)}'::text, '${id}'::uuid, true, true)`)
    .join(', ');
  await admin.query(
    `CREATE OR REPLACE FUNCTION platform.list_active_tenant_schema_mappings()
       RETURNS TABLE(schema_name text, tenant_id uuid, schema_exists boolean, committed_proof boolean)
       LANGUAGE sql STABLE SECURITY DEFINER AS $fn$ VALUES ${rows} $fn$`,
  );
  await admin.query(
    `GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings() TO ${RUNTIME_ROLE}`,
  );
}

export interface AlertPostgres {
  harness: HarnessContext;
  admin: DataSource;
  moduleRef: TestingModule;
  close(): Promise<void>;
}

/**
 * Boot Postgres, build the source schema and the given tenants, and compile a
 * Nest module whose repositories run as the runtime role with the production
 * pool patches. `providers` are the services under test and their doubles; the
 * outbox, Redis, event emitter, event bus, scheduler runner and audit are
 * provided here.
 */
export async function bootAlertPostgres(input: {
  tenantIds: string[];
  providers: NonNullable<Parameters<typeof Test.createTestingModule>[0]['providers']>;
}): Promise<AlertPostgres> {
  const harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
  const admin = harness.dataSource;
  const password = randomBytes(24).toString('hex');

  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${password}'`);
  await admin.query('CREATE SCHEMA alert');
  await admin.query('CREATE SCHEMA platform');
  await admin.query(`GRANT USAGE ON SCHEMA alert, platform TO ${RUNTIME_ROLE}`);

  // Source schema: every migration, the source-only outbox included.
  await replay(admin, 'alert', [
    new Baseline1800000000000(),
    new AlignAlertTenantColumnsToUuid1800100000000(),
    new CreateAlertOutbox1800200000000(),
    new AddAlertHistorySourceEventId1801100000000(),
    new FarmSignalIncidentDelivery1801200000000(),
  ]);
  await admin.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA alert TO ${RUNTIME_ROLE}`,
  );
  for (const tenantId of input.tenantIds) {
    await provisionTenant(admin, tenantId);
  }
  await publishLedger(admin, input.tenantIds);

  const connection = harness.connectionOptions;
  // The lease/heartbeat runner is infrastructure; the job body runs inline.
  const scheduledJobs: ScheduledJobExecutor = {
    run: async (_name: string, work: () => Promise<void>) => {
      await work();
      return 'ran';
    },
  };
  const entities = [AlertRule, AlertIncident, AlertHistory, EscalationPolicy, AlertOutbox];
  const moduleRef = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'postgres',
        host: connection.host,
        port: connection.port,
        database: connection.database,
        username: RUNTIME_ROLE,
        password,
        entities,
        synchronize: false,
        logging: false,
        extra: { options: '-c search_path=alert,public' },
      }),
      TypeOrmModule.forFeature(entities),
    ],
    providers: [
      ...input.providers,
      { provide: OutboxPublisher, useValue: new OutboxPublisher(AlertOutbox) },
      { provide: RedisService, useValue: createRedisServiceMock() },
      { provide: EventEmitter2, useValue: new EventEmitter2() },
      { provide: 'EVENT_BUS', useValue: { subscribeWildcard: jest.fn() } },
      { provide: ScheduledJobRunner, useValue: scheduledJobs },
      { provide: AlertAuditService, useValue: { log: jest.fn(), recordInTransaction: jest.fn() } },
    ],
  }).compile();

  const runtime = moduleRef.get(DataSource);
  // The production pool patches, in production's init order (RlsModule is an
  // imported module, so it patches before AppModule's TenantConnectionBootstrap):
  // RLS GUC + search_path from the ALS context on every checkout.
  new (createRlsConnectionBootstrap('alert'))(runtime).onModuleInit();
  new (createTenantConnectionBootstrap('alert'))(runtime).onModuleInit();

  return {
    harness,
    admin,
    moduleRef,
    close: async () => {
      await moduleRef.close();
      await shutdownHarness(harness);
    },
  };
}
