import {
  CONFIGURATION_CATALOG_DIGEST,
  ConfigurationChangeIntentV1,
  ConfigurationKeyId,
  ConfigurationSnapshotStateV1,
} from '@aquaculture/configuration-contracts';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEntityBase, OutboxPublisher } from '@platform/outbox';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, Entity } from 'typeorm';

import {
  ConfigEnvironment,
  Configuration,
  ConfigurationHistory,
} from '../entities/configuration.entity';
import {
  ConfigurationChangeJournal,
  ConfigurationOperationReceipt,
  ConfigurationScope,
} from '../entities/configuration-operation.entity';
import { SYSTEM_TENANT_ID } from '../configuration.constants';
import { ApplyConfigurationBatchInputV1 } from '../dto/configuration-snapshot.dto';
import { ConfigurationBatchAuthorityService } from './configuration-batch-authority.service';
import { ConfigurationSnapshotService } from './configuration-snapshot.service';
import { EncryptionService } from './encryption.service';

@Entity({ schema: 'config', name: 'configuration_authority_test_outbox' })
class ConfigurationAuthorityTestOutbox extends OutboxEntityBase {}

const ENVIRONMENT = ConfigEnvironment.ALL;
const ACTOR_ID = 'configuration-authority-postgres-test';

interface AuthorityCounts {
  readonly configurations: number;
  readonly configurationHistory: number;
  readonly configurationChangeJournal: number;
  readonly configurationOperationReceipts: number;
  readonly outbox: number;
}

describe('configuration authority PostgreSQL transaction contract', () => {
  jest.setTimeout(180_000);

  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let snapshots: ConfigurationSnapshotService;
  let authority: ConfigurationBatchAuthorityService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('configuration_authority')
      .withUsername('configuration_authority')
      .withPassword('configuration-authority-test-password')
      .start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: [
        Configuration,
        ConfigurationHistory,
        ConfigurationScope,
        ConfigurationOperationReceipt,
        ConfigurationChangeJournal,
        ConfigurationAuthorityTestOutbox,
      ],
    });
    await dataSource.initialize();
    await dataSource.query('CREATE SCHEMA "config"');
    await dataSource.synchronize();
    await dataSource.query(`
      CREATE TABLE "config"."tenant_erasure_target_proofs" (
        "tenantId" uuid NOT NULL,
        "targetService" varchar(100) NOT NULL,
        "dryRun" boolean NOT NULL
      )
    `);

    snapshots = new ConfigurationSnapshotService(dataSource);
    const encryption = new EncryptionService(
      new ConfigService({
        CONFIG_ENCRYPTION_KEY: '9a5bd22347e13838d825e01f673d2809bc96ac6808a32398c498150d46a60743',
        NODE_ENV: 'test',
      }),
    );
    encryption.onModuleInit();
    authority = new ConfigurationBatchAuthorityService(
      dataSource,
      snapshots,
      encryption,
      new OutboxPublisher(ConfigurationAuthorityTestOutbox, {
        allowSystemRouting: false,
        allowSecurityRecovery: false,
      }),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await dataSource.query(`
      TRUNCATE TABLE
        "config"."configuration_authority_test_outbox",
        "config"."configuration_operation_receipts",
        "config"."configuration_change_journal",
        "config"."configuration_history",
        "config"."configurations",
        "config"."configuration_scopes",
        "config"."tenant_erasure_target_proofs"
      RESTART IDENTITY CASCADE
    `);
  });

  it('projects explicit absent, invalid, and catalog-mismatch states fail-red', async () => {
    const empty = await snapshots.getSnapshot(SYSTEM_TENANT_ID, ENVIRONMENT);
    expect(empty.readiness).toBe('RED');
    expect(entryState(empty, ConfigurationKeyId.PLATFORM_NAME)).toBe(
      ConfigurationSnapshotStateV1.MISSING_REQUIRED,
    );
    expect(entryState(empty, ConfigurationKeyId.EMAIL_SMTP_HOST)).toBe(
      ConfigurationSnapshotStateV1.OPTIONAL_ABSENT,
    );
    expect(empty.invalidKeys).toEqual([]);
    expect(empty.catalogMismatches).toEqual([]);

    await insertConfiguration('30000000-0000-0000-0000-000000000001', 'PLATFORM_NAME', '');
    const invalid = await snapshots.getSnapshot(SYSTEM_TENANT_ID, ENVIRONMENT);
    expect(invalid.readiness).toBe('RED');
    expect(invalid.invalidKeys).toEqual([ConfigurationKeyId.PLATFORM_NAME]);
    expect(entryState(invalid, ConfigurationKeyId.PLATFORM_NAME)).toBe(
      ConfigurationSnapshotStateV1.INVALID,
    );

    await insertConfiguration(
      '30000000-0000-0000-0000-000000000002',
      'UNREGISTERED_RUNTIME_KEY',
      'unowned',
    );
    const mismatch = await snapshots.getSnapshot(SYSTEM_TENANT_ID, ENVIRONMENT);
    expect(mismatch.readiness).toBe('RED');
    expect(mismatch.catalogMismatches).toEqual([`${SYSTEM_TENANT_ID}:UNREGISTERED_RUNTIME_KEY`]);
    expect(
      mismatch.entries.every(
        (entry) => entry.state === ConfigurationSnapshotStateV1.CATALOG_MISMATCH,
      ),
    ).toBe(true);
  });

  it('commits value, audit, journal, receipt, outbox, and revision atomically and replays idempotently', async () => {
    const before = await snapshots.getSnapshot(SYSTEM_TENANT_ID, ENVIRONMENT);
    const request = batchInput(
      '10000000-0000-0000-0000-000000000001',
      before.snapshotToken,
      'Aquaculture Control Plane',
    );

    const receipt = await authority.apply(request, SYSTEM_TENANT_ID, ACTOR_ID, true);
    expect(receipt.replayed).toBe(false);
    expect(receipt.scopeRevision).toBe('1');
    await expect(authority.apply(request, SYSTEM_TENANT_ID, ACTOR_ID, true)).resolves.toMatchObject(
      {
        operationId: request.operationId,
        replayed: true,
        scopeRevision: '1',
        resultingSnapshotToken: receipt.resultingSnapshotToken,
      },
    );

    await expect(authorityCounts()).resolves.toEqual({
      configurations: 1,
      configurationHistory: 1,
      configurationChangeJournal: 1,
      configurationOperationReceipts: 1,
      outbox: 1,
    });
    await expect(scopeRevision()).resolves.toBe('1');

    await expect(
      authority.apply(
        { ...request, reason: 'operation ID cannot be rebound' },
        SYSTEM_TENANT_ID,
        ACTOR_ID,
        true,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      authority.apply(
        batchInput('10000000-0000-0000-0000-000000000002', before.snapshotToken, 'Stale writer'),
        SYSTEM_TENANT_ID,
        ACTOR_ID,
        true,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows exactly one writer to advance a shared scope revision', async () => {
    await insertScope();
    const before = await snapshots.getSnapshot(SYSTEM_TENANT_ID, ENVIRONMENT);
    const results = await Promise.allSettled([
      authority.apply(
        batchInput(
          '10000000-0000-0000-0000-000000000011',
          before.snapshotToken,
          'Concurrent writer A',
        ),
        SYSTEM_TENANT_ID,
        ACTOR_ID,
        true,
      ),
      authority.apply(
        batchInput(
          '10000000-0000-0000-0000-000000000012',
          before.snapshotToken,
          'Concurrent writer B',
        ),
        SYSTEM_TENANT_ID,
        ACTOR_ID,
        true,
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status !== 'rejected') {
      throw new Error('concurrent configuration write did not reject one writer');
    }
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    await expect(scopeRevision()).resolves.toBe('1');
    await expect(authorityCounts()).resolves.toEqual({
      configurations: 1,
      configurationHistory: 1,
      configurationChangeJournal: 1,
      configurationOperationReceipts: 1,
      outbox: 1,
    });
  });

  it('rolls back the full authority transaction when outbox persistence fails', async () => {
    await insertScope();
    const before = await snapshots.getSnapshot(SYSTEM_TENANT_ID, ENVIRONMENT);
    await dataSource.query(`
      CREATE FUNCTION "config"."fail_configuration_test_outbox_insert"()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION 'injected outbox failure';
      END;
      $function$
    `);
    await dataSource.query(`
      CREATE TRIGGER "configuration_test_outbox_failure"
      BEFORE INSERT ON "config"."configuration_authority_test_outbox"
      FOR EACH ROW EXECUTE FUNCTION "config"."fail_configuration_test_outbox_insert"()
    `);

    try {
      await expect(
        authority.apply(
          batchInput(
            '10000000-0000-0000-0000-000000000021',
            before.snapshotToken,
            'Must roll back',
          ),
          SYSTEM_TENANT_ID,
          ACTOR_ID,
          true,
        ),
      ).rejects.toThrow('injected outbox failure');
    } finally {
      await dataSource.query(
        'DROP TRIGGER IF EXISTS "configuration_test_outbox_failure" ON "config"."configuration_authority_test_outbox"',
      );
      await dataSource.query(
        'DROP FUNCTION IF EXISTS "config"."fail_configuration_test_outbox_insert"()',
      );
    }

    await expect(scopeRevision()).resolves.toBe('0');
    await expect(authorityCounts()).resolves.toEqual({
      configurations: 0,
      configurationHistory: 0,
      configurationChangeJournal: 0,
      configurationOperationReceipts: 0,
      outbox: 0,
    });
  });

  function batchInput(
    operationId: string,
    expectedSnapshotToken: string,
    value: string,
  ): ApplyConfigurationBatchInputV1 {
    return {
      operationId,
      catalogDigest: CONFIGURATION_CATALOG_DIGEST,
      expectedSnapshotToken,
      reason: 'PostgreSQL authority contract verification',
      environment: ENVIRONMENT,
      changes: [
        {
          keyId: ConfigurationKeyId.PLATFORM_NAME,
          intent: ConfigurationChangeIntentV1.SET,
          value,
        },
      ],
    };
  }

  async function insertConfiguration(id: string, catalogId: string, value: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO "config"."configurations"
        ("id", "tenant_id", "catalog_id", "value", "environment", "is_active", "suppress_fallback", "version")
       VALUES ($1, $2, $3, $4, $5, true, false, 1)`,
      [id, SYSTEM_TENANT_ID, catalogId, value, ENVIRONMENT],
    );
  }

  async function insertScope(): Promise<void> {
    await dataSource.query(
      `INSERT INTO "config"."configuration_scopes" ("tenant_id", "environment", "revision")
       VALUES ($1, $2, 0)`,
      [SYSTEM_TENANT_ID, ENVIRONMENT],
    );
  }

  async function scopeRevision(): Promise<string | null> {
    const rows: Array<{ revision: string }> = await dataSource.query(
      `SELECT "revision"::text AS "revision"
         FROM "config"."configuration_scopes"
        WHERE "tenant_id" = $1 AND "environment" = $2`,
      [SYSTEM_TENANT_ID, ENVIRONMENT],
    );
    return rows[0]?.revision ?? null;
  }

  async function authorityCounts(): Promise<AuthorityCounts> {
    const rows: AuthorityCounts[] = await dataSource.query(`
      SELECT
        (SELECT count(*)::integer FROM "config"."configurations") AS "configurations",
        (SELECT count(*)::integer FROM "config"."configuration_history") AS "configurationHistory",
        (SELECT count(*)::integer FROM "config"."configuration_change_journal") AS "configurationChangeJournal",
        (SELECT count(*)::integer FROM "config"."configuration_operation_receipts") AS "configurationOperationReceipts",
        (SELECT count(*)::integer FROM "config"."configuration_authority_test_outbox") AS "outbox"
    `);
    const counts = rows[0];
    if (!counts) throw new Error('configuration authority count query returned no row');
    return counts;
  }
});

function entryState(
  snapshot: Awaited<ReturnType<ConfigurationSnapshotService['getSnapshot']>>,
  keyId: ConfigurationKeyId,
): ConfigurationSnapshotStateV1 | undefined {
  return snapshot.entries.find((entry) => entry.keyId === keyId)?.state;
}
