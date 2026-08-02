import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import { LegalHoldEntity, LegalHoldService } from '@aquaculture/backend-common/compliance';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';

import { TenantErasureAuditEntity } from '../entities/tenant-erasure-audit.entity';
import { TenantErasureService } from '../services/tenant-erasure.service';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';

@Entity('sites')
class ErasureSiteRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;
}

@Entity('weather_observations')
class ErasureWeatherRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;
}

@Entity('marine_observations')
class ErasureMarineRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;
}

@Entity('satellite_scene_observations')
class ErasureSceneRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;
}

@Entity('satellite_scene_coverage_assessments')
class ErasureSceneCoverageRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;
}

@Entity('site_environment_sync_state')
class ErasureSyncStateRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;
}

@Entity('environment_metric_sync_outcomes')
class ErasureMetricOutcomeRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;
}

const ENVIRONMENT_TABLES = [
  'weather_observations',
  'marine_observations',
  'satellite_scene_observations',
  'satellite_scene_coverage_assessments',
  'site_environment_sync_state',
  'environment_metric_sync_outcomes',
] as const;

jest.setTimeout(120_000);

describe('farm tenant-erasure live topology on real Postgres', () => {
  let harness: HarnessContext | undefined;
  let runtime: DataSource | undefined;
  let legalHoldTestingModule: TestingModule | undefined;
  let legalHoldService: LegalHoldService | undefined;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    const admin = requireAdmin();
    const tenantSchema = getTenantSchemaName(TENANT_ID);

    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await admin.query('CREATE SCHEMA farm');
    await admin.query(`CREATE SCHEMA "${tenantSchema}"`);
    await admin.query(`
      CREATE TABLE farm.tenant_erasure_target_proofs (
        "operationId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "targetService" text NOT NULL,
        "eventId" uuid NOT NULL,
        "proofHash" text NOT NULL,
        "erasedAt" timestamptz NOT NULL,
        "dryRun" boolean NOT NULL,
        "matchedRecordCount" integer NOT NULL,
        "erasedRecordCount" integer NOT NULL,
        PRIMARY KEY ("operationId", "targetService")
      );

      CREATE TABLE farm.tenant_erasure_audit (
        "tenantId" uuid PRIMARY KEY,
        "confirmedAt" timestamptz NOT NULL,
        "requestedBy" varchar(255) NOT NULL,
        "totalDeleted" integer NOT NULL,
        "auditRowsAnonymised" integer NOT NULL,
        "tableCount" integer NOT NULL,
        "deletedRowsByTable" jsonb NOT NULL,
        "retainedRowsByTable" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "retainedRowsAnonymised" integer NOT NULL DEFAULT 0
      );

      CREATE TABLE farm.farm_audit_logs (
        "tenantId" uuid NOT NULL,
        "userId" uuid,
        "userName" text
      );

      CREATE TABLE "${tenantSchema}".sites (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        UNIQUE ("tenantId", id)
      );

      CREATE TABLE "${tenantSchema}".site_environment_sync_state (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        provider text NOT NULL,
        monitoring_location_revision integer NOT NULL,
        UNIQUE (tenant_id, site_id, provider, monitoring_location_revision),
        FOREIGN KEY (tenant_id, site_id)
          REFERENCES "${tenantSchema}".sites ("tenantId", id)
      );

      CREATE TABLE "${tenantSchema}".weather_observations (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        FOREIGN KEY (tenant_id, site_id)
          REFERENCES "${tenantSchema}".sites ("tenantId", id)
      );

      CREATE TABLE "${tenantSchema}".marine_observations (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        FOREIGN KEY (tenant_id, site_id)
          REFERENCES "${tenantSchema}".sites ("tenantId", id)
      );

      CREATE TABLE "${tenantSchema}".satellite_scene_observations (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        scene_id varchar(512) NOT NULL DEFAULT 'scene-1',
        monitoring_location_revision integer NOT NULL DEFAULT 1,
        UNIQUE (tenant_id, site_id, scene_id, monitoring_location_revision),
        FOREIGN KEY (tenant_id, site_id)
          REFERENCES "${tenantSchema}".sites ("tenantId", id)
      );

      CREATE TABLE "${tenantSchema}".satellite_scene_coverage_assessments (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        scene_id varchar(512) NOT NULL,
        monitoring_location_revision integer NOT NULL,
        FOREIGN KEY (tenant_id, site_id)
          REFERENCES "${tenantSchema}".sites ("tenantId", id),
        FOREIGN KEY (tenant_id, site_id, scene_id, monitoring_location_revision)
          REFERENCES "${tenantSchema}".satellite_scene_observations (
            tenant_id,
            site_id,
            scene_id,
            monitoring_location_revision
          )
      );

      CREATE TABLE "${tenantSchema}".environment_metric_sync_outcomes (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        site_id uuid NOT NULL,
        provider text NOT NULL,
        monitoring_location_revision integer NOT NULL,
        FOREIGN KEY (tenant_id, site_id, provider, monitoring_location_revision)
          REFERENCES "${tenantSchema}".site_environment_sync_state (
            tenant_id,
            site_id,
            provider,
            monitoring_location_revision
          )
      );
    `);

    await admin.query(`INSERT INTO "${tenantSchema}".sites (id, "tenantId") VALUES ($1, $2)`, [
      SITE_ID,
      TENANT_ID,
    ]);
    await admin.query(
      `INSERT INTO farm.farm_audit_logs ("tenantId", "userId", "userName")
       VALUES ($1, $2, 'Original operator')`,
      [TENANT_ID, USER_ID],
    );
    await admin.query(
      `
        INSERT INTO "${tenantSchema}".site_environment_sync_state (
          id, tenant_id, site_id, provider, monitoring_location_revision
        ) VALUES ('44444444-4444-4444-8444-444444444444', $1, $2, 'CMEMS', 1)
      `,
      [TENANT_ID, SITE_ID],
    );
    for (const [tableName, id] of [
      ['weather_observations', '55555555-5555-4555-8555-555555555555'],
      ['marine_observations', '66666666-6666-4666-8666-666666666666'],
      ['satellite_scene_observations', '77777777-7777-4777-8777-777777777777'],
    ] as const) {
      await admin.query(
        `INSERT INTO "${tenantSchema}"."${tableName}" (id, tenant_id, site_id)
         VALUES ($1, $2, $3)`,
        [id, TENANT_ID, SITE_ID],
      );
    }
    await admin.query(
      `INSERT INTO "${tenantSchema}".satellite_scene_coverage_assessments (
         id, tenant_id, site_id, scene_id, monitoring_location_revision
       ) VALUES ('99999999-9999-4999-8999-999999999999', $1, $2, 'scene-1', 1)`,
      [TENANT_ID, SITE_ID],
    );
    await admin.query(
      `
        INSERT INTO "${tenantSchema}".environment_metric_sync_outcomes (
          id, tenant_id, site_id, provider, monitoring_location_revision
        ) VALUES ('88888888-8888-4888-8888-888888888888', $1, $2, 'CMEMS', 1)
      `,
      [TENANT_ID, SITE_ID],
    );

    runtime = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: 'farm-tenant-erasure-topology-postgres',
      entities: [
        ErasureSiteRow,
        ErasureWeatherRow,
        ErasureMarineRow,
        ErasureSceneRow,
        ErasureSceneCoverageRow,
        ErasureSyncStateRow,
        ErasureMetricOutcomeRow,
        TenantErasureAuditEntity,
      ],
      synchronize: false,
      logging: false,
    });
    await runtime.initialize();

    legalHoldTestingModule = await Test.createTestingModule({
      providers: [
        LegalHoldService,
        {
          provide: getRepositoryToken(LegalHoldEntity),
          useValue: {},
        },
      ],
    }).compile();
    legalHoldService = legalHoldTestingModule.get(LegalHoldService);
  });

  afterAll(async () => {
    if (runtime?.isInitialized) {
      await runtime.destroy();
    }
    await legalHoldTestingModule?.close();
    await shutdownHarness(harness);
  });

  it('deletes child-first and proves zero residue for every environmental table', async () => {
    const outboxPublisher = new OutboxPublisher(FarmOutbox);
    const enqueue = jest.spyOn(outboxPublisher, 'enqueue').mockResolvedValue(undefined);
    const holdService = requireLegalHoldService();
    jest.spyOn(holdService, 'assertNoHold').mockResolvedValue(undefined);
    const service = new TenantErasureService(requireRuntime(), outboxPublisher, holdService);

    const ticket = service.initiate(TENANT_ID, USER_ID);
    const result = await service.confirm(TENANT_ID, ticket.token);

    expect(result.totalDeleted).toBe(7);
    expect(result.matchedRecordCount).toBe(8);
    expect(result.auditRowsAnonymised).toBe(1);
    expect(result.deletedRowsByTable).toMatchObject({
      weather_observations: 1,
      marine_observations: 1,
      satellite_scene_observations: 1,
      satellite_scene_coverage_assessments: 1,
      site_environment_sync_state: 1,
      environment_metric_sync_outcomes: 1,
      sites: 1,
    });

    const tenantSchema = getTenantSchemaName(TENANT_ID);
    for (const tableName of ['sites', ...ENVIRONMENT_TABLES]) {
      const rows: Array<{ count: string }> = await requireAdmin().query(
        `SELECT COUNT(*)::text AS count FROM "${tenantSchema}"."${tableName}"`,
      );
      expect(rows[0]?.count).toBe('0');
    }
    const auditRows: Array<{ userId: string; userName: string }> = await requireAdmin().query(
      `SELECT "userId", "userName"
         FROM farm.farm_audit_logs
        WHERE "tenantId" = $1`,
      [TENANT_ID],
    );
    expect(auditRows).toEqual([
      {
        userId: TenantErasureService.hashUserId(USER_ID),
        userName: '[ERASED]',
      },
    ]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  function requireAdmin(): DataSource {
    if (!harness) {
      throw new Error('Postgres harness is unavailable');
    }
    return harness.dataSource;
  }

  function requireRuntime(): DataSource {
    if (!runtime) {
      throw new Error('Postgres runtime is unavailable');
    }
    return runtime;
  }

  function requireLegalHoldService(): LegalHoldService {
    if (!legalHoldService) {
      throw new Error('Legal hold test service is unavailable');
    }
    return legalHoldService;
  }
});
