import 'reflect-metadata';

import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { assertTenantSchemaPrivileges } from '@aquaculture/backend-common/database';
import type { QueryRunner } from 'typeorm';

import { BackfillExecutionsToFeedingRecords1806600000000 } from '../../database/migrations/1806600000000-BackfillExecutionsToFeedingRecords';
import { ProtectFeedingRecordBackfillProvenance1808600000000 } from '../../database/migrations/1808600000000-ProtectFeedingRecordBackfillProvenance';

jest.setTimeout(120_000);

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BACKFILL_EXECUTION = '21111111-1111-4111-8111-111111111111';
const LIVE_RECORD = '33333333-3333-4333-8333-333333333333';
const LIVE_EXECUTION = '43333333-3333-4333-8333-333333333333';
const UNKNOWN_RECORD = '55555555-5555-4555-8555-555555555555';
const UNKNOWN_EXECUTION = '65555555-5555-4555-8555-555555555555';
const FEED = '77777777-7777-4777-8777-777777777777';
const EQUIPMENT = '88888888-8888-4888-8888-888888888888';
const USER = '99999999-9999-4999-8999-999999999999';
const COLLISION_RECORD = 'c1111111-1111-4111-8111-111111111111';
const COLLISION_EXECUTION = 'c2222222-2222-4222-8222-222222222222';
const NORMAL_DELETE_RECORD = 'd1111111-1111-4111-8111-111111111111';
const NORMAL_DELETE_EXECUTION = 'd2222222-2222-4222-8222-222222222222';
const INTERLEAVED_RECORD = 'e1111111-1111-4111-8111-111111111111';
const INTERLEAVED_EXECUTION = 'e2222222-2222-4222-8222-222222222222';
const LEGACY_SHAPE_RECORD = 'f1111111-1111-4111-8111-111111111111';
const SOURCE_ERASURE_RECORD = 'a3111111-1111-4111-8111-111111111111';
const SOURCE_ERASURE_EXECUTION = 'a3222222-2222-4222-8222-222222222222';

interface ProvenanceRow {
  feeding_record_id: string;
  origin: 'BACKFILL_180660' | 'LIVE_DRAIN' | 'UNKNOWN';
  source_xmin: string;
  content_hash: string;
}

interface Fixture {
  queryRunner: QueryRunner;
  ledgerTable: 'migrations' | 'migrations_farm';
  backfillRecordId: string;
}

describe('feeding-record rollback provenance fence (FARM-CRITICAL-241)', () => {
  let pg: HarnessContext | undefined;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await pg.dataSource.query(`
      DO $roles$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'db_migrate') THEN
          CREATE ROLE db_migrate NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farm_service') THEN
          CREATE ROLE farm_service NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farm_schema_owner') THEN
          CREATE ROLE farm_schema_owner NOLOGIN;
        END IF;
        EXECUTE format('GRANT db_migrate TO %I', current_user);
        EXECUTE format('GRANT farm_schema_owner TO %I', current_user);
        GRANT farm_schema_owner TO db_migrate;
      END
      $roles$;
    `);
  });

  afterAll(async () => {
    await shutdownHarness(pg);
  });

  async function set180660Context(
    queryRunner: QueryRunner,
    direction: 'up' | 'down',
  ): Promise<void> {
    await queryRunner.query(
      `SELECT pg_catalog.set_config('aqua.migration_name', $1, true),
              pg_catalog.set_config('aqua.migration_direction', $2, true)`,
      ['BackfillExecutionsToFeedingRecords1806600000000', direction],
    );
  }

  async function createFixtureSchema(
    schema: string,
    includeUnknown: boolean,
    installProtection = true,
  ): Promise<Fixture> {
    const ledgerTable = schema === 'farm' ? 'migrations' : 'migrations_farm';
    await pg!.dataSource.query(`CREATE SCHEMA "${schema}"`);
    await pg!.dataSource.query(`
      CREATE TABLE "${schema}"."${ledgerTable}" (
        id serial PRIMARY KEY,
        timestamp bigint NOT NULL,
        name varchar NOT NULL
      );
      CREATE TABLE "${schema}".batches_v2 (
        id uuid PRIMARY KEY,
        "totalFeedConsumed" numeric NOT NULL DEFAULT 0,
        "totalFeedCost" numeric NOT NULL DEFAULT 0
      );
      CREATE TABLE "${schema}".feeding_records (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "batchId" uuid NOT NULL,
        "tankId" uuid,
        "feedingDate" date NOT NULL DEFAULT CURRENT_DATE,
        "feedingTime" varchar(10) NOT NULL DEFAULT '12:00',
        "feedId" uuid NOT NULL DEFAULT '${FEED}',
        "plannedAmount" numeric NOT NULL DEFAULT 0,
        "sourceExecutionId" uuid,
        "mealId" uuid,
        "actualAmount" numeric NOT NULL,
        variance numeric NOT NULL DEFAULT 0,
        "variancePercent" numeric NOT NULL DEFAULT 0,
        "feedCost" numeric,
        currency varchar(3),
        "fedBy" uuid NOT NULL DEFAULT '${USER}',
        notes text,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idx_fixture_source_execution
        ON "${schema}".feeding_records ("sourceExecutionId")
        WHERE "sourceExecutionId" IS NOT NULL;
      CREATE TABLE "${schema}".tank_batches (
        "tenantId" uuid NOT NULL,
        "tankId" uuid NOT NULL,
        "primaryBatchId" uuid
      );
      CREATE TABLE "${schema}".feeds (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "pricePerKg" numeric
      );
      CREATE TABLE "${schema}".finance_settings (
        "tenantId" uuid NOT NULL,
        "defaultCurrency" varchar(3) NOT NULL
      );
      CREATE TABLE "${schema}".daily_feeding_executions (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "equipmentId" uuid NOT NULL,
        "executionDate" date NOT NULL,
        "completedAt" timestamptz,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        calculations jsonb NOT NULL,
        "actualResults" jsonb,
        "completedBy" uuid,
        "createdBy" uuid NOT NULL,
        notes text,
        status varchar(32) NOT NULL
      );
    `);
    await pg!.dataSource.query(
      `INSERT INTO "${schema}".batches_v2
         (id, "totalFeedConsumed", "totalFeedCost")
       VALUES ($1, $2, $3)`,
      [BATCH, includeUnknown ? 3 : 0, includeUnknown ? 6 : 0],
    );
    await pg!.dataSource.query(
      `INSERT INTO "${schema}".tank_batches ("tenantId", "tankId", "primaryBatchId")
       VALUES ($1, $2, $3)`,
      [TENANT, EQUIPMENT, BATCH],
    );
    await pg!.dataSource.query(
      `INSERT INTO "${schema}".feeds (id, "tenantId", "pricePerKg")
       VALUES ($1, $2, 2)`,
      [FEED, TENANT],
    );
    await pg!.dataSource.query(
      `INSERT INTO "${schema}".finance_settings ("tenantId", "defaultCurrency")
       VALUES ($1, 'NOK')`,
      [TENANT],
    );
    await pg!.dataSource.query(
      `INSERT INTO "${schema}".daily_feeding_executions
         (id, "tenantId", "equipmentId", "executionDate", "completedAt",
          calculations, "actualResults", "completedBy", "createdBy", status)
       VALUES
         ($1, $2, $3, CURRENT_DATE, now(),
          jsonb_build_object('activeFeedId', $4::text, 'plannedFeedKg', 10),
          jsonb_build_object('actualFeedGivenKg', 10), $5, $5, 'completed')`,
      [BACKFILL_EXECUTION, TENANT, EQUIPMENT, FEED, USER],
    );

    if (includeUnknown) {
      await pg!.dataSource.query(
        `INSERT INTO "${schema}".feeding_records
           (id, "tenantId", "batchId", "sourceExecutionId", "actualAmount", "feedCost")
         VALUES ($1, $2, $3, $4, 3, 6)`,
        [UNKNOWN_RECORD, TENANT, BATCH, UNKNOWN_EXECUTION],
      );
    }

    const queryRunner = pg!.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.query(`SET search_path TO "${schema}", public`);

    // Run the real 180660 up() and write the exact source/tenant TypeORM ledger
    // row in the same transaction, matching the canonical runner's contract.
    await queryRunner.startTransaction();
    await set180660Context(queryRunner, 'up');
    await new BackfillExecutionsToFeedingRecords1806600000000().up(queryRunner);
    await queryRunner.query(
      `INSERT INTO "${ledgerTable}" (timestamp, name)
       VALUES (1806600000000, 'BackfillExecutionsToFeedingRecords1806600000000')`,
    );
    await queryRunner.commitTransaction();
    const backfilled: Array<{ id: string }> = await queryRunner.query(
      `SELECT id FROM feeding_records WHERE "sourceExecutionId" = $1`,
      [BACKFILL_EXECUTION],
    );
    const backfillRecordId = backfilled[0]!.id;

    if (installProtection) {
      await queryRunner.startTransaction();
      await new ProtectFeedingRecordBackfillProvenance1808600000000().up(queryRunner);
      await queryRunner.commitTransaction();
    }
    return { queryRunner, ledgerTable, backfillRecordId };
  }

  async function provenanceRows(schema: string): Promise<ProvenanceRow[]> {
    return pg!.dataSource.query(
      `SELECT feeding_record_id, origin, source_xmin, content_hash
         FROM "${schema}".feeding_record_provenance
        ORDER BY feeding_record_id`,
    );
  }

  async function insertLiveDrain(queryRunner: QueryRunner, schema: string): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "${schema}".feeding_records
         (id, "tenantId", "batchId", "sourceExecutionId", "actualAmount", "feedCost")
       VALUES ($1, $2, $3, $4, 8, 16)`,
      [LIVE_RECORD, TENANT, BATCH, LIVE_EXECUTION],
    );
    await queryRunner.query(
      `UPDATE "${schema}".batches_v2
          SET "totalFeedConsumed" = "totalFeedConsumed" + 8,
              "totalFeedCost" = "totalFeedCost" + 16
        WHERE id = $1`,
      [BATCH],
    );
  }

  it.each([
    { schema: 'farm', expectedLedger: 'migrations' as const },
    { schema: 'tenant_2410000000000001', expectedLedger: 'migrations_farm' as const },
  ])(
    'uses exact xmin proof from $expectedLedger in $schema and preserves live drain writes',
    async ({ schema, expectedLedger }) => {
      const { queryRunner, ledgerTable, backfillRecordId } = await createFixtureSchema(
        schema,
        false,
      );
      expect(ledgerTable).toBe(expectedLedger);
      try {
        const initial = await provenanceRows(schema);
        expect(initial).toHaveLength(1);
        expect(initial[0]).toMatchObject({
          feeding_record_id: backfillRecordId,
          origin: 'BACKFILL_180660',
        });
        expect(initial[0]!.source_xmin).toMatch(/^\d+$/);
        expect(initial[0]!.content_hash).toMatch(/^[a-f0-9]{32}$/);

        await expect(
          queryRunner.query(`TRUNCATE TABLE "${schema}".feeding_record_provenance`),
        ).rejects.toThrow(/immutable|TRUNCATE|FARM-CRITICAL-241/i);

        // Trigger functions retain the schema in which the migration created
        // them; caller search_path cannot redirect provenance reads/writes.
        await queryRunner.query('SET search_path TO public');
        await insertLiveDrain(queryRunner, schema);
        const classified = new Map(
          (await provenanceRows(schema)).map((row) => [row.feeding_record_id, row.origin]),
        );
        expect(classified.get(backfillRecordId)).toBe('BACKFILL_180660');
        expect(classified.get(LIVE_RECORD)).toBe('LIVE_DRAIN');
        await queryRunner.query(
          `INSERT INTO "${schema}".feeding_records
             (id, "tenantId", "batchId", "sourceExecutionId", "actualAmount", "feedCost")
           VALUES ($1, $2, $3, $4, 1, 2)`,
          [NORMAL_DELETE_RECORD, TENANT, BATCH, NORMAL_DELETE_EXECUTION],
        );
        await queryRunner.query(`DELETE FROM "${schema}".feeding_records WHERE id = $1`, [
          NORMAL_DELETE_RECORD,
        ]);
        const normallyDeleted: Array<{ count: string }> = await queryRunner.query(
          `SELECT COUNT(*)::text AS count
             FROM "${schema}".feeding_records
            WHERE id = $1`,
          [NORMAL_DELETE_RECORD],
        );
        expect(normallyDeleted).toEqual([{ count: '0' }]);
        await queryRunner.query(`SET search_path TO "${schema}", public`);

        const liveChecksumBefore: Array<{ checksum: string }> = await queryRunner.query(
          `SELECT md5(to_jsonb(fr)::text) AS checksum
             FROM feeding_records fr
            WHERE id = $1`,
          [LIVE_RECORD],
        );

        await queryRunner.startTransaction();
        await set180660Context(queryRunner, 'down');
        await new BackfillExecutionsToFeedingRecords1806600000000().down(queryRunner);
        await queryRunner.commitTransaction();

        const remaining: Array<{ id: string }> = await queryRunner.query(
          `SELECT id FROM feeding_records ORDER BY id`,
        );
        expect(remaining).toEqual([{ id: LIVE_RECORD }]);
        const liveChecksumAfter: Array<{ checksum: string }> = await queryRunner.query(
          `SELECT md5(to_jsonb(fr)::text) AS checksum
             FROM feeding_records fr
            WHERE id = $1`,
          [LIVE_RECORD],
        );
        expect(liveChecksumAfter).toEqual(liveChecksumBefore);
        const batches: Array<{ consumed: string; cost: string }> = await queryRunner.query(
          `SELECT "totalFeedConsumed"::text AS consumed, "totalFeedCost"::text AS cost
             FROM batches_v2 WHERE id = $1`,
          [BATCH],
        );
        expect(Number(batches[0]!.consumed)).toBe(8);
        expect(Number(batches[0]!.cost)).toBe(16);

        // Provenance is an audit fact and survives deletion of its source row.
        const durableProvenance = new Map(
          (await provenanceRows(schema)).map((row) => [row.feeding_record_id, row.origin]),
        );
        expect(durableProvenance.get(NORMAL_DELETE_RECORD)).toBe('LIVE_DRAIN');
        expect(durableProvenance.size).toBe(3);
        await expect(
          queryRunner.query(
            `UPDATE feeding_record_provenance SET origin = 'UNKNOWN'
              WHERE feeding_record_id = $1`,
            [backfillRecordId],
          ),
        ).rejects.toThrow(/immutable|FARM-CRITICAL-241/i);
      } finally {
        await queryRunner.release();
      }
    },
  );

  it('classifies unproven pre-existing rows UNKNOWN and aborts rollback without partial deletion', async () => {
    const schema = 'tenant_2410000000000002';
    const { queryRunner, backfillRecordId } = await createFixtureSchema(schema, true);
    try {
      const classified = new Map(
        (await provenanceRows(schema)).map((row) => [row.feeding_record_id, row.origin]),
      );
      expect(classified.get(backfillRecordId)).toBe('BACKFILL_180660');
      expect(classified.get(UNKNOWN_RECORD)).toBe('UNKNOWN');

      await queryRunner.startTransaction();
      await set180660Context(queryRunner, 'down');
      await expect(
        new BackfillExecutionsToFeedingRecords1806600000000().down(queryRunner),
      ).rejects.toThrow(/refusing to delete|UNKNOWN|FARM-CRITICAL-241/i);
      await queryRunner.rollbackTransaction();

      const remaining: Array<{ id: string }> = await queryRunner.query(
        `SELECT id FROM feeding_records ORDER BY id`,
      );
      expect(remaining).toEqual(
        [{ id: backfillRecordId }, { id: UNKNOWN_RECORD }].sort((a, b) => a.id.localeCompare(b.id)),
      );
      const batches: Array<{ consumed: string; cost: string }> = await queryRunner.query(
        `SELECT "totalFeedConsumed"::text AS consumed, "totalFeedCost"::text AS cost
           FROM batches_v2 WHERE id = $1`,
        [BATCH],
      );
      expect(Number(batches[0]!.consumed)).toBe(13);
      expect(Number(batches[0]!.cost)).toBe(26);
    } finally {
      await queryRunner.release();
    }
  });

  it('aborts classification when an existing provenance row disagrees with exact xmin evidence', async () => {
    const schema = 'tenant_2410000000000006';
    const { queryRunner, backfillRecordId } = await createFixtureSchema(schema, false, false);
    try {
      await queryRunner.query(`
        CREATE TABLE feeding_record_provenance (
          feeding_record_id uuid PRIMARY KEY,
          tenant_id uuid NOT NULL,
          source_execution_id uuid NOT NULL,
          origin varchar(32) NOT NULL,
          source_xmin text NOT NULL,
          content_hash char(32) NOT NULL,
          classified_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);
      await queryRunner.query(
        `INSERT INTO feeding_record_provenance
           (feeding_record_id, tenant_id, source_execution_id, origin,
            source_xmin, content_hash)
         VALUES ($1, $2, $3, 'LIVE_DRAIN', 'forged-xmin', $4)`,
        [backfillRecordId, TENANT, BACKFILL_EXECUTION, '0'.repeat(32)],
      );

      await queryRunner.startTransaction();
      await expect(
        new ProtectFeedingRecordBackfillProvenance1808600000000().up(queryRunner),
      ).rejects.toThrow(/conflicting classified provenance|FARM-CRITICAL-241/i);
      await queryRunner.rollbackTransaction();

      const retained: Array<{ origin: string; source_xmin: string }> = await queryRunner.query(
        `SELECT origin, source_xmin
             FROM feeding_record_provenance
            WHERE feeding_record_id = $1`,
        [backfillRecordId],
      );
      expect(retained).toEqual([{ origin: 'LIVE_DRAIN', source_xmin: 'forged-xmin' }]);
    } finally {
      await queryRunner.release();
    }
  });

  it('reclassifies a re-applied 180660 transaction after the protected downgrade path', async () => {
    const schema = 'tenant_2410000000000003';
    const {
      queryRunner,
      ledgerTable,
      backfillRecordId: firstBackfillId,
    } = await createFixtureSchema(schema, false);
    try {
      await insertLiveDrain(queryRunner, schema);
      await queryRunner.query(
        `UPDATE feeding_records SET notes = 'edited after capture' WHERE id = $1`,
        [LIVE_RECORD],
      );

      await queryRunner.startTransaction();
      await new ProtectFeedingRecordBackfillProvenance1808600000000().down();
      await queryRunner.commitTransaction();

      await queryRunner.startTransaction();
      await set180660Context(queryRunner, 'down');
      await new BackfillExecutionsToFeedingRecords1806600000000().down(queryRunner);
      await queryRunner.query(
        `DELETE FROM "${ledgerTable}"
          WHERE timestamp = 1806600000000
            AND name = 'BackfillExecutionsToFeedingRecords1806600000000'`,
      );
      await queryRunner.commitTransaction();

      await queryRunner.startTransaction();
      await set180660Context(queryRunner, 'up');
      await new BackfillExecutionsToFeedingRecords1806600000000().up(queryRunner);
      await queryRunner.query(
        `INSERT INTO "${ledgerTable}" (timestamp, name)
         VALUES (1806600000000, 'BackfillExecutionsToFeedingRecords1806600000000')`,
      );
      await queryRunner.commitTransaction();

      const reappliedRows: Array<{ id: string }> = await queryRunner.query(
        `SELECT id FROM feeding_records WHERE "sourceExecutionId" = $1`,
        [BACKFILL_EXECUTION],
      );
      const secondBackfillId = reappliedRows[0]!.id;
      expect(secondBackfillId).not.toBe(firstBackfillId);

      // The retained capture trigger reads exact 180660/up context and labels
      // the new row BACKFILL before 180680 is re-applied. The new ledger xmin
      // independently agrees with that classification.
      await queryRunner.startTransaction();
      await new ProtectFeedingRecordBackfillProvenance1808600000000().up(queryRunner);
      await queryRunner.commitTransaction();

      const classified = new Map(
        (await provenanceRows(schema)).map((row) => [row.feeding_record_id, row.origin]),
      );
      expect(classified.get(firstBackfillId)).toBe('BACKFILL_180660');
      expect(classified.get(secondBackfillId)).toBe('BACKFILL_180660');
      expect(classified.get(LIVE_RECORD)).toBe('LIVE_DRAIN');
    } finally {
      await queryRunner.release();
    }
  });

  it('keeps the forward-only capture trigger harmless after a deep rollback removes 180640 columns', async () => {
    const schema = 'tenant_2410000000000007';
    const { queryRunner } = await createFixtureSchema(schema, false);
    try {
      await new ProtectFeedingRecordBackfillProvenance1808600000000().down();
      await queryRunner.startTransaction();
      await set180660Context(queryRunner, 'down');
      await new BackfillExecutionsToFeedingRecords1806600000000().down(queryRunner);
      await queryRunner.commitTransaction();

      // Exact older feeding_records shape reached by 180640.down. The
      // retained 180680 trigger must inspect NEW through jsonb and no-op.
      await queryRunner.query(
        `ALTER TABLE feeding_records
           DROP COLUMN "sourceExecutionId",
           DROP COLUMN "mealId"`,
      );
      await queryRunner.query(
        `INSERT INTO feeding_records
           (id, "tenantId", "batchId", "actualAmount", "feedCost")
         VALUES ($1, $2, $3, 1, 2)`,
        [LEGACY_SHAPE_RECORD, TENANT, BATCH],
      );

      const inserted: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*)::text AS count FROM feeding_records WHERE id = $1`,
        [LEGACY_SHAPE_RECORD],
      );
      const provenance: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*)::text AS count FROM feeding_record_provenance`,
      );
      expect(inserted).toEqual([{ count: '1' }]);
      expect(provenance).toEqual([{ count: '1' }]);
    } finally {
      await queryRunner.release();
    }
  });

  it('fails the live insert when an immutable provenance row already owns the record id', async () => {
    const schema = 'tenant_2410000000000004';
    const { queryRunner } = await createFixtureSchema(schema, false);
    try {
      await queryRunner.query('SET search_path TO public');
      await queryRunner.query(
        `INSERT INTO "${schema}".feeding_record_provenance
           (feeding_record_id, tenant_id, source_execution_id, origin,
            source_xmin, content_hash)
         VALUES ($1, $2, $3, 'UNKNOWN', 'pre-existing', $4)`,
        [COLLISION_RECORD, TENANT, COLLISION_EXECUTION, '0'.repeat(32)],
      );

      await expect(
        queryRunner.query(
          `INSERT INTO "${schema}".feeding_records
             (id, "tenantId", "batchId", "sourceExecutionId", "actualAmount", "feedCost")
           VALUES ($1, $2, $3, $4, 1, 2)`,
          [COLLISION_RECORD, TENANT, BATCH, COLLISION_EXECUTION],
        ),
      ).rejects.toThrow(/conflicting provenance|duplicate key|feeding_record_provenance|unique/i);

      const rows: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*)::text AS count
           FROM "${schema}".feeding_records
          WHERE id = $1`,
        [COLLISION_RECORD],
      );
      expect(rows).toEqual([{ count: '0' }]);
    } finally {
      await queryRunner.release();
    }
  });

  it('captures a concurrent live writer blocked across classification and trigger installation', async () => {
    const schema = 'tenant_2410000000000008';
    const { queryRunner } = await createFixtureSchema(schema, false, false);
    const writer = pg!.dataSource.createQueryRunner();
    await writer.connect();
    let insertPromise: Promise<unknown> | undefined;
    try {
      await queryRunner.startTransaction();
      // This is the first lock statement in 180680.up(); taking it explicitly
      // lets the second connection reach a deterministic blocked state before
      // the remainder of the real migration runs in the same transaction.
      await queryRunner.query(`LOCK TABLE feeding_records IN SHARE ROW EXCLUSIVE MODE`);
      const ownerPidRows: Array<{ pid: number }> = await queryRunner.query(
        `SELECT pg_backend_pid() AS pid`,
      );
      const writerPidRows: Array<{ pid: number }> = await writer.query(
        `SELECT pg_backend_pid() AS pid`,
      );
      const ownerPid = ownerPidRows[0]!.pid;
      const writerPid = writerPidRows[0]!.pid;

      await writer.startTransaction();
      insertPromise = writer.query(
        `INSERT INTO "${schema}".feeding_records
           (id, "tenantId", "batchId", "sourceExecutionId", "actualAmount", "feedCost")
         VALUES ($1, $2, $3, $4, 4, 8)`,
        [INTERLEAVED_RECORD, TENANT, BATCH, INTERLEAVED_EXECUTION],
      );

      let observedBlocked = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const blocked: Array<{ blocked: boolean }> = await pg!.dataSource.query(
          `SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked`,
          [ownerPid, writerPid],
        );
        if (blocked[0]?.blocked === true) {
          observedBlocked = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(observedBlocked).toBe(true);

      await new ProtectFeedingRecordBackfillProvenance1808600000000().up(queryRunner);
      await queryRunner.commitTransaction();
      await insertPromise;
      await writer.query(
        `UPDATE "${schema}".batches_v2
            SET "totalFeedConsumed" = "totalFeedConsumed" + 4,
                "totalFeedCost" = "totalFeedCost" + 8
          WHERE id = $1`,
        [BATCH],
      );
      await writer.commitTransaction();

      const captured: Array<{
        origin: string;
        content_hash: string;
        checksum: string;
      }> = await pg!.dataSource.query(
        `SELECT provenance.origin,
                provenance.content_hash,
                md5(to_jsonb(record)::text) AS checksum
           FROM "${schema}".feeding_record_provenance provenance
           JOIN "${schema}".feeding_records record
             ON record.id = provenance.feeding_record_id
          WHERE record.id = $1`,
        [INTERLEAVED_RECORD],
      );
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ origin: 'LIVE_DRAIN' });
      expect(captured[0]!.content_hash).toBe(captured[0]!.checksum);

      await queryRunner.startTransaction();
      await set180660Context(queryRunner, 'down');
      await new BackfillExecutionsToFeedingRecords1806600000000().down(queryRunner);
      await queryRunner.commitTransaction();

      const parity: Array<{
        id: string;
        checksum: string;
        consumed: string;
        cost: string;
      }> = await queryRunner.query(
        `SELECT record.id,
                md5(to_jsonb(record)::text) AS checksum,
                batch."totalFeedConsumed"::text AS consumed,
                batch."totalFeedCost"::text AS cost
           FROM feeding_records record
           JOIN batches_v2 batch ON batch.id = record."batchId"
          WHERE record.id = $1`,
        [INTERLEAVED_RECORD],
      );
      expect(parity).toEqual([
        {
          id: INTERLEAVED_RECORD,
          checksum: captured[0]!.checksum,
          consumed: '4',
          cost: '8.00',
        },
      ]);
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      await insertPromise?.catch(() => undefined);
      if (writer.isTransactionActive) {
        await writer.rollbackTransaction();
      }
      await writer.release();
      await queryRunner.release();
    }
  });

  it('denies service-role provenance forgery and migration-context spoofing', async () => {
    const schema = 'tenant_2410000000000005';
    const { queryRunner } = await createFixtureSchema(schema, false);
    try {
      await assertTenantSchemaPrivileges(pg!.dataSource, {
        tenantSchema: schema,
        sourceSchema: 'farm',
      });
      const privileges: Array<{
        has_select: boolean;
        has_insert: boolean;
        has_update: boolean;
        has_delete: boolean;
      }> = await queryRunner.query(
        `SELECT
           has_table_privilege('farm_service', $1, 'SELECT') AS has_select,
           has_table_privilege('farm_service', $1, 'INSERT') AS has_insert,
           has_table_privilege('farm_service', $1, 'UPDATE') AS has_update,
           has_table_privilege('farm_service', $1, 'DELETE') AS has_delete`,
        [`${schema}.feeding_record_provenance`],
      );
      expect(privileges).toEqual([
        {
          has_select: true,
          has_insert: false,
          has_update: false,
          has_delete: false,
        },
      ]);
      await queryRunner.query('SET SESSION AUTHORIZATION farm_service');

      await expect(
        queryRunner.query(
          `INSERT INTO "${schema}".feeding_record_provenance
             (feeding_record_id, tenant_id, source_execution_id, origin,
              source_xmin, content_hash)
           VALUES ($1, $2, $3, 'LIVE_DRAIN', 'forged', $4)`,
          [COLLISION_RECORD, TENANT, COLLISION_EXECUTION, '0'.repeat(32)],
        ),
      ).rejects.toThrow(/permission denied/i);

      // Normal service insert succeeds through the SECURITY DEFINER capture
      // function even though direct provenance writes are revoked.
      await queryRunner.query(
        `INSERT INTO "${schema}".feeding_records
           (id, "tenantId", "batchId", "sourceExecutionId", "actualAmount", "feedCost")
         VALUES ($1, $2, $3, $4, 1, 2)`,
        [COLLISION_RECORD, TENANT, BATCH, COLLISION_EXECUTION],
      );

      await queryRunner.startTransaction();
      await set180660Context(queryRunner, 'down');
      await expect(
        queryRunner.query(`DELETE FROM "${schema}".feeding_records WHERE id = $1`, [
          COLLISION_RECORD,
        ]),
      ).rejects.toThrow(/db_migrate authority|permission denied/i);
      await queryRunner.rollbackTransaction();
    } finally {
      await queryRunner.query('RESET SESSION AUTHORIZATION');
      await queryRunner.release();
    }
  });

  it('leaves final tenant/source provenance removal exclusively to the proof-gated db-migrate delete authority', async () => {
    const schema = 'tenant_aaaaaaaaaaaa4aaa';
    const { queryRunner } = await createFixtureSchema(schema, false);
    try {
      await assertTenantSchemaPrivileges(pg!.dataSource, {
        tenantSchema: schema,
        sourceSchema: 'farm',
      });
      await queryRunner.query(`ALTER SCHEMA "${schema}" OWNER TO farm_schema_owner`);
      await queryRunner.query(`ALTER SCHEMA farm OWNER TO farm_schema_owner`);
      await queryRunner.query(
        `ALTER TABLE farm.feeding_record_provenance OWNER TO farm_schema_owner`,
      );
      await queryRunner.query(
        `INSERT INTO farm.feeding_record_provenance
           (feeding_record_id, tenant_id, source_execution_id, origin,
            source_xmin, content_hash)
         VALUES ($1, $2, $3, 'UNKNOWN', 'legacy-source', $4)`,
        [SOURCE_ERASURE_RECORD, TENANT, SOURCE_ERASURE_EXECUTION, '1'.repeat(32)],
      );

      await queryRunner.query('SET SESSION AUTHORIZATION farm_service');
      await expect(queryRunner.query(`DROP SCHEMA "${schema}" CASCADE`)).rejects.toThrow(
        /permission denied|must be owner/i,
      );
      await queryRunner.query('RESET SESSION AUTHORIZATION');

      const before: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*)::text AS count
           FROM farm.feeding_record_provenance
          WHERE tenant_id = $1`,
        [TENANT],
      );
      expect(Number(before[0]!.count)).toBeGreaterThan(0);

      // Mirrors processDeleteJob after assertDeleteProof(job): the protected
      // control-plane role binds operation+tenant transaction-locally, removes
      // legacy source residue, then drops the tenant schema atomically.
      await queryRunner.startTransaction();
      await queryRunner.query(`SET LOCAL ROLE db_migrate`);
      await queryRunner.query(
        `SELECT pg_catalog.set_config(
                  'aqua.tenant_schema_delete_operation',
                  $1,
                  true
                ),
                pg_catalog.set_config(
                  'aqua.tenant_schema_delete_tenant',
                  $2,
                  true
                )`,
        ['24100000-0000-4000-8000-000000000241', TENANT],
      );
      await queryRunner.query(`DELETE FROM farm.feeding_record_provenance WHERE tenant_id = $1`, [
        TENANT,
      ]);
      await queryRunner.query(`DROP SCHEMA "${schema}" CASCADE`);
      await queryRunner.commitTransaction();

      const after: Array<{ count: string; schema_exists: boolean }> = await queryRunner.query(
        `SELECT
             (SELECT COUNT(*)::text
                FROM farm.feeding_record_provenance
               WHERE tenant_id = $1) AS count,
             to_regnamespace($2) IS NOT NULL AS schema_exists`,
        [TENANT, schema],
      );
      expect(after).toEqual([{ count: '0', schema_exists: false }]);
    } finally {
      await queryRunner.query('RESET SESSION AUTHORIZATION').catch(() => undefined);
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      await queryRunner.release();
    }
  });
});
