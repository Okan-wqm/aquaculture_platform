import {
  FEEDING_FORECAST_GENERATION_AUTHORITY,
  FEEDING_FORECAST_GENERATION_CATALOG_DIGEST,
  FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1,
  FEEDING_METHOD,
  compileFeedingForecastGenerationExactSetProofV1,
  compileFeedingRecordRollbackExactSetProofV1,
} from '@aquaculture/feeding-contracts';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
  withEphemeralDatabase,
  withEphemeralSchema,
} from '@platform/migration-harness';
import type { MigrationInterface, QueryRunner } from 'typeorm';

import { BackfillExecutionsToFeedingRecords1806600000000 } from '../../../farm-service/src/database/migrations/1806600000000-BackfillExecutionsToFeedingRecords';
import { AddTankOperationCountProvenance1808800000000 } from '../../../farm-service/src/database/migrations/1808800000000-AddTankOperationCountProvenance';
import { CreateFeedingHistoricalProvenanceAuthority1808900000000 } from '../../../farm-service/src/database/migrations/1808900000000-CreateFeedingHistoricalProvenanceAuthority';
import { CompleteFeedInventoryLedgerBackfillBySourceRow1809000000000 } from '../../../farm-service/src/database/migrations/1809000000000-CompleteFeedInventoryLedgerBackfillBySourceRow';
import { AddDayPlanLiveProtocolResolution1809100000000 } from '../../../farm-service/src/database/migrations/1809100000000-AddDayPlanLiveProtocolResolution';
import { BoundDayPlanRecalculationAudit1809200000000 } from '../../../farm-service/src/database/migrations/1809200000000-BoundDayPlanRecalculationAudit';
import { WidenMealWindowReemissionIndex1809300000000 } from '../../../farm-service/src/database/migrations/1809300000000-WidenMealWindowReemissionIndex';
import { EnforceSingleLiveProtocolAssignment1809400000000 } from '../../../farm-service/src/database/migrations/1809400000000-EnforceSingleLiveProtocolAssignment';
import { AlignFeedingMealMethodAuthority1809500000000 } from '../../../farm-service/src/database/migrations/1809500000000-AlignFeedingMealMethodAuthority';
import { CompileForecastPoolAuthority1809600000000 } from '../../../farm-service/src/database/migrations/1809600000000-CompileForecastPoolAuthority';
import { PreserveStockMovementLotReceiptProvenance1809800000000 } from '../../../farm-service/src/database/migrations/1809800000000-PreserveStockMovementLotReceiptProvenance';
import { BindStockCorrectionAllocationFamily1809900000000 } from '../../../farm-service/src/database/migrations/1809900000000-BindStockCorrectionAllocationFamily';
import { CreateFeedingRecordWriteProvenanceAuthority1810000000000 } from '../../../farm-service/src/database/migrations/1810000000000-CreateFeedingRecordWriteProvenanceAuthority';
import { DAY_PLAN_RECALC_AUDIT_POLICY_V1 } from '../../../farm-service/src/feeding-protocol/day-plan-recalc-audit.authority';
import { PROTOCOL_RESOLUTION_CONTRACT_V1 } from '../../../farm-service/src/feeding-protocol/protocol-resolution.contract';

jest.setTimeout(120_000);

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE_A = '22222222-2222-4222-8222-222222222222';
const SITE_B = '33333333-3333-4333-8333-333333333333';
const FEED = '44444444-4444-4444-8444-444444444444';
const PROTOCOL = '55555555-5555-4555-8555-555555555555';
const DAY_PLAN = '66666666-6666-4666-8666-666666666666';
const UNIT_A = '77777777-7777-4777-8777-777777777777';
const UNIT_B = '88888888-8888-4888-8888-888888888888';
const UNIT_C = '99999999-9999-4999-8999-999999999999';
const DAY_PLAN_MULTI = '66666666-6666-4666-8666-666666666667';
const DAY_PLAN_UNSTAMPED = '66666666-6666-4666-8666-666666666668';
const BATCH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const BATCH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const LOCATION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const LOCATION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const EXECUTION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const EXECUTION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const EXECUTION_NULL = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const EXECUTION_MISSING = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3';
const EXECUTION_OVERLAP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3';
const RECORD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const RECORD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4';
const RECORD_NULL = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4';
const RECORD_MISSING = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
const RECORD_OVERLAP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4';
const RECORD_AMBIGUOUS_WRITE = '10000000-0000-4000-8000-000000000001';
const RECORD_MIXED_BACKFILL = '10000000-0000-4000-8000-000000000002';
const RECORD_MIXED_LIVE = '10000000-0000-4000-8000-000000000003';
const RECORD_LIVE_ONLY = '10000000-0000-4000-8000-000000000004';
const RECORD_CHANGED_BACKFILL = '10000000-0000-4000-8000-000000000005';
const RECORD_SUCCESS_A = '10000000-0000-4000-8000-000000000006';
const RECORD_SUCCESS_B = '10000000-0000-4000-8000-000000000007';
const LOCATION_OVERLAP_A = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';
const LOCATION_OVERLAP_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
const PROVENANCE_RLS_TEST_ROLE = `feeding_provenance_rls_${process.pid}`;

interface VerifiableMigration extends MigrationInterface {
  postCondition?(queryRunner: QueryRunner): Promise<boolean>;
}

type MigrationConstructor = new () => VerifiableMigration;

interface FeedingMigrationFailureVectorBaseV1 {
  readonly name: string;
  readonly seed: (queryRunner: QueryRunner) => Promise<void>;
  readonly verifyRestored: (queryRunner: QueryRunner) => Promise<void>;
}

type FeedingMigrationFailureVectorV1 = FeedingMigrationFailureVectorBaseV1 &
  (
    | { readonly error: string | RegExp; readonly sqlState?: never }
    | { readonly error?: never; readonly sqlState: string }
  );

interface FeedingMigrationVectorV1 {
  readonly id: `18${number}`;
  readonly migration: MigrationConstructor;
  readonly arrange: (queryRunner: QueryRunner) => Promise<void>;
  readonly seed: (queryRunner: QueryRunner) => Promise<void>;
  readonly verify: (queryRunner: QueryRunner, migration: VerifiableMigration) => Promise<void>;
  readonly replay?: true;
  readonly failures: readonly FeedingMigrationFailureVectorV1[];
}

function freezeMigrationVectors(
  source: readonly FeedingMigrationVectorV1[],
): readonly FeedingMigrationVectorV1[] {
  const ids = new Set<string>();
  const migrations = new Set<MigrationConstructor>();
  for (const vector of source) {
    if (ids.has(vector.id) || migrations.has(vector.migration)) {
      throw new Error(`Duplicate feeding migration vector authority: ${vector.id}`);
    }
    ids.add(vector.id);
    migrations.add(vector.migration);
    const migrationName = new vector.migration().name ?? vector.migration.name;
    if (!migrationName.endsWith(vector.id)) {
      throw new Error(`Feeding migration vector ${vector.id} differs from ${migrationName}`);
    }
    const failureNames = vector.failures.map((failure) => failure.name);
    if (new Set(failureNames).size !== failureNames.length) {
      throw new Error(`Duplicate failure vector in feeding migration ${vector.id}`);
    }
    for (const failure of vector.failures) {
      if ((failure.error === undefined) === (failure.sqlState === undefined)) {
        throw new Error(
          `Feeding migration failure vector ${vector.id}/${failure.name} must own exactly one error contract`,
        );
      }
      if (failure.sqlState !== undefined && !/^[0-9A-Z]{5}$/.test(failure.sqlState)) {
        throw new Error(
          `Feeding migration failure vector ${vector.id}/${failure.name} has invalid SQLSTATE ${failure.sqlState}`,
        );
      }
    }
  }
  return Object.freeze(
    source.map((vector) =>
      Object.freeze({
        ...vector,
        failures: Object.freeze(vector.failures.map((failure) => Object.freeze({ ...failure }))),
      }),
    ),
  );
}

async function applyMigrationTransaction(
  queryRunner: QueryRunner,
  migration: VerifiableMigration,
): Promise<void> {
  await queryRunner.startTransaction();
  try {
    await migration.up(queryRunner);
    await queryRunner.commitTransaction();
  } catch (error) {
    if (!queryRunner.isTransactionActive) throw error;
    try {
      await queryRunner.rollbackTransaction();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `${migration.name ?? migration.constructor.name} failed and its transaction could not be restored`,
      );
    }
    throw error;
  }
}

async function expectColumnAbsent(
  queryRunner: QueryRunner,
  table: string,
  column: string,
): Promise<void> {
  const rows: Array<{ present: boolean }> = await queryRunner.query(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1
          AND column_name = $2
     ) AS present`,
    [table, column],
  );
  expect(rows[0]?.present).toBe(false);
}

async function expectMealMethodPriorState(queryRunner: QueryRunner): Promise<void> {
  const rows: Array<{
    dataType: string;
    enumType: string | null;
    constraintPresent: boolean;
  }> = await queryRunner.query(`
    SELECT c.data_type AS "dataType",
           to_regtype('feeding_meals_feedingmethod_enum')::text AS "enumType",
           EXISTS (
             SELECT 1 FROM pg_constraint constraint_row
              WHERE constraint_row.conrelid = 'feeding_meals'::regclass
                AND constraint_row.conname = 'CHK_feeding_meals_method_v1'
           ) AS "constraintPresent"
      FROM information_schema.columns c
     WHERE c.table_schema = current_schema()
       AND c.table_name = 'feeding_meals'
       AND c.column_name = 'feedingMethod'
  `);
  expect(rows[0]).toEqual({
    dataType: 'character varying',
    enumType: null,
    constraintPresent: false,
  });
}

async function expectHistoricalProjectionSchemaCatalog(queryRunner: QueryRunner): Promise<void> {
  const authority = FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1;
  type ProjectionKey = keyof typeof authority.projectionSchemas;
  for (const candidate of Object.keys(authority.projectionSchemas)) {
    const key = candidate as ProjectionKey;
    const schema = authority.projectionSchemas[key];
    let expected: readonly string[];
    if ('columns' in schema) {
      expected = schema.columns;
    } else {
      const sourceRows: Array<{ columns: string[] }> = await queryRunner.query(
        `SELECT jsonb_agg(column_name ORDER BY ordinal_position) AS columns
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1`,
        [schema.columnSourceRelation],
      );
      expected = sourceRows[0]?.columns ?? [];
    }
    const projectionRows: Array<{ columns: string[] }> = await queryRunner.query(
      `SELECT jsonb_agg(column_name ORDER BY ordinal_position) AS columns
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1`,
      [authority.projections[key]],
    );
    expect(projectionRows[0]?.columns).toEqual(expected);
  }
}

async function createLedgerSchema(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`CREATE SCHEMA farm`);
  await queryRunner.query(`
    CREATE TYPE farm.feeds_status_enum AS ENUM (
      'available', 'low_stock', 'out_of_stock', 'expired', 'discontinued'
    )
  `);
  await queryRunner.query(`
    CREATE TABLE sites (
      id uuid PRIMARY KEY,
      "tenantId" uuid NOT NULL
    );
    CREATE TABLE feeds (
      id uuid PRIMARY KEY,
      "tenantId" uuid NOT NULL,
      name text NOT NULL,
      unit text,
      quantity numeric NOT NULL DEFAULT 0,
      "minStock" numeric NOT NULL DEFAULT 0,
      status farm.feeds_status_enum NOT NULL DEFAULT 'available'
    );
    CREATE TABLE feed_inventory (
      id uuid PRIMARY KEY,
      "tenantId" uuid NOT NULL,
      "siteId" uuid NOT NULL,
      "feedId" uuid NOT NULL,
      "quantityKg" numeric(12,3) NOT NULL,
      "lotNumber" text,
      "expiryDate" date,
      "receivedDate" timestamptz
    );
    CREATE TABLE storage_locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      site_id uuid NOT NULL,
      name text NOT NULL,
      code varchar(50) NOT NULL,
      type text NOT NULL,
      capacity_unit text NOT NULL,
      used_capacity numeric NOT NULL,
      is_active boolean NOT NULL,
      is_deleted boolean NOT NULL,
      version integer NOT NULL,
      UNIQUE (tenant_id, code)
    );
    CREATE TABLE storage_inventory (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      storage_location_id uuid NOT NULL,
      item_type text NOT NULL,
      item_id uuid NOT NULL,
      quantity numeric(15,2) NOT NULL,
      unit text NOT NULL,
      lot_number text,
      expiry_date date,
      received_date timestamptz,
      version integer NOT NULL,
      created_by uuid,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE stock_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      movement_type text NOT NULL,
      item_type text NOT NULL,
      item_id uuid NOT NULL,
      item_name text NOT NULL,
      quantity numeric NOT NULL,
      unit text NOT NULL,
      to_location_id uuid,
      reference text,
      lot_number text,
      expiry_date date,
      idempotency_key text,
      performed_by uuid NOT NULL,
      performed_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX uq_stock_movement_idempotency
      ON stock_movements (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
}

async function createCorrectionAllocationSchema(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE stock_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      movement_type text NOT NULL,
      item_type text NOT NULL,
      item_id uuid NOT NULL,
      item_name text NOT NULL,
      quantity numeric(15,2) NOT NULL,
      unit text NOT NULL,
      from_location_id uuid,
      to_location_id uuid,
      lot_number text,
      expiry_date date,
      received_date timestamptz,
      idempotency_key text,
      performed_by uuid NOT NULL,
      performed_at timestamptz NOT NULL
    )
  `);
}

async function createLotReceiptProvenanceSchema(queryRunner: QueryRunner): Promise<void> {
  await createCorrectionAllocationSchema(queryRunner);
  await queryRunner.query(`
    CREATE TABLE storage_inventory (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      storage_location_id uuid NOT NULL,
      item_type text NOT NULL,
      item_id uuid NOT NULL,
      lot_number text,
      received_date timestamptz
    )
  `);
}

async function seedLotReceiptProvenance(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(
    `INSERT INTO storage_inventory
       (tenant_id, storage_location_id, item_type, item_id, lot_number, received_date)
     VALUES ($1, $2, 'feed', $3, 'LOT-A', '2026-01-02T00:00:00Z')`,
    [TENANT, LOCATION_A, FEED],
  );
  await queryRunner.query(
    `INSERT INTO stock_movements
       (id, tenant_id, movement_type, item_type, item_id, item_name, quantity, unit,
        from_location_id, lot_number, idempotency_key, performed_by, performed_at)
     VALUES
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', $1, 'out', 'feed', $2, 'Feed', 1,
        'kg', $3, 'LOT-A', 'receipt-proof-a', $4, now()),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', $1, 'out', 'feed', $2, 'Feed', 1,
        'kg', $3, 'LOT-UNKNOWN', 'receipt-proof-b', $4, now())`,
    [TENANT, FEED, LOCATION_A, BATCH_A],
  );
}

async function seedCorrectionAllocation(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(
    `INSERT INTO stock_movements
       (id, tenant_id, movement_type, item_type, item_id, item_name, quantity, unit,
        from_location_id, lot_number, idempotency_key, performed_by, performed_at)
     VALUES
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', $1, 'out', 'feed', $2, 'Feed', 0.30,
        'kg', $3, 'LOT-A', 'meal-deduct-meal-1-0', $4, '2026-08-01T08:00:00Z'),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', $1, 'out', 'feed', $2, 'Feed', 149.70,
        'kg', $3, 'LOT-B', 'meal-deduct-meal-1-0:1', $4, '2026-08-01T08:00:00Z'),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', $1, 'out', 'feed', $2, 'Feed', 1.00,
        'kg', $3, 'LOT-C', 'manual-stock-out', $4, '2026-08-01T08:00:00Z')`,
    [TENANT, FEED, LOCATION_A, BATCH_A],
  );
}

async function seedValidLedger(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`INSERT INTO sites VALUES ($1, $3), ($2, $3)`, [SITE_A, SITE_B, TENANT]);
  await queryRunner.query(
    `INSERT INTO feeds (id, "tenantId", name, unit, "minStock")
     VALUES ($1, $2, 'Feed', 'kg', 1)`,
    [FEED, TENANT],
  );
  const existingLocation: Array<{ id: string }> = await queryRunner.query(
    `INSERT INTO storage_locations
      (tenant_id, site_id, name, code, type, capacity_unit, used_capacity,
       is_active, is_deleted, version)
     VALUES ($1, $2, 'Existing', 'EXISTING', 'warehouse', 'm3', 0, true, false, 1)
     RETURNING id`,
    [TENANT, SITE_A],
  );
  const location = existingLocation[0];
  if (!location) throw new Error('Ledger fixture did not create its storage location');
  await queryRunner.query(
    `INSERT INTO storage_inventory
      (tenant_id, storage_location_id, item_type, item_id, quantity, unit,
       lot_number, version)
     VALUES ($1, $2, 'feed', $3, 5, 'kg', 'PREEXISTING', 1)`,
    [TENANT, location.id, FEED],
  );
  await queryRunner.query(
    `INSERT INTO feed_inventory
      (id, "tenantId", "siteId", "feedId", "quantityKg", "lotNumber")
     VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $1, $2, $4, 2, 'LOT-A'),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', $1, $3, $4, 3, 'LOT-B')`,
    [TENANT, SITE_A, SITE_B, FEED],
  );
}

async function createGrowthSchema(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE feeding_protocols_v2 (
      id uuid PRIMARY KEY,
      "tenantId" uuid NOT NULL,
      settings jsonb NOT NULL
    );
    CREATE TABLE feeding_day_plans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenantId" uuid NOT NULL,
      "protocolId" uuid NOT NULL,
      "siteId" uuid NOT NULL,
      "unitId" uuid NOT NULL,
      "planDate" date NOT NULL,
      status text NOT NULL,
      snapshot jsonb NOT NULL,
      "rollupAppliedAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE feeding_meals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenantId" uuid NOT NULL,
      "dayPlanId" uuid NOT NULL,
      "actualKg" numeric(12,3) NOT NULL,
      pours jsonb NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE feeding_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenantId" uuid NOT NULL,
      "batchId" uuid NOT NULL,
      "tankId" uuid,
      "pondId" uuid,
      "batchLocationId" uuid,
      "feedingDate" date NOT NULL,
      "feedingTime" varchar(10) NOT NULL,
      "actualAmount" numeric(10,3) NOT NULL,
      "feedCost" numeric(10,2),
      "sourceExecutionId" uuid,
      "mealId" uuid,
      "createdAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE daily_feeding_executions (
      id uuid PRIMARY KEY,
      "tenantId" uuid NOT NULL,
      "equipmentId" uuid NOT NULL,
      "equipmentType" text NOT NULL,
      "completedAt" timestamptz
    );
    CREATE TABLE batch_locations (
      id uuid PRIMARY KEY,
      "tenantId" uuid NOT NULL,
      "batchId" uuid NOT NULL,
      "tankId" uuid,
      "pondId" uuid,
      "movedAt" timestamptz NOT NULL,
      "exitedAt" timestamptz
    );
    CREATE TABLE batches_v2 (
      id uuid PRIMARY KEY,
      "tenantId" uuid NOT NULL,
      "totalFeedConsumed" numeric NOT NULL DEFAULT 0,
      "totalFeedCost" numeric NOT NULL DEFAULT 0
    );
    CREATE INDEX "IDX_fdp_rollup_pending"
      ON feeding_day_plans ("tenantId", "planDate")
      WHERE "rollupAppliedAt" IS NULL;
  `);
}

async function seedValidGrowth(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(
    `INSERT INTO feeding_protocols_v2
     VALUES ($1, $2, '{"growthApplicationMode":"per_meal"}')`,
    [PROTOCOL, TENANT],
  );
  await queryRunner.query(
    `INSERT INTO feeding_day_plans
      (id, "tenantId", "protocolId", "siteId", "unitId", "planDate", status,
       snapshot, "rollupAppliedAt")
     VALUES
       ($1, $4, $5, $6, $7, '2026-08-01', 'completed',
        '{"expectedFcr":2}', '2026-08-01T12:00:00Z'),
       ($2, $4, $5, $6, $8, '2026-08-01', 'completed',
        '{"expectedFcr":2}', '2026-08-01T12:00:00Z'),
       ($3, $4, $5, $6, $8, '2026-07-31', 'completed',
        '{"expectedFcr":2}', NULL)`,
    [DAY_PLAN, DAY_PLAN_MULTI, DAY_PLAN_UNSTAMPED, TENANT, PROTOCOL, SITE_A, UNIT_A, UNIT_B],
  );
  await queryRunner.query(
    `INSERT INTO feeding_meals ("tenantId", "dayPlanId", "actualKg", pours)
     VALUES ($1, $2, 6, $3::jsonb), ($1, $4, 4, $5::jsonb)`,
    [
      TENANT,
      DAY_PLAN,
      JSON.stringify([
        {
          pourIndex: 0,
          kg: 4,
          at: '2026-08-01T11:00:00Z',
          by: 'operator',
          originalKg: 6,
          correctedAt: '2026-08-01T13:00:00Z',
          correctedBy: 'reviewer',
          corrections: 1,
        },
        { pourIndex: 1, kg: 2, at: '2026-08-01T13:30:00Z', by: 'operator' },
      ]),
      DAY_PLAN_MULTI,
      JSON.stringify([
        {
          pourIndex: 0,
          kg: 4,
          at: '2026-08-01T11:00:00Z',
          by: 'operator',
          originalKg: 6,
          correctedAt: '2026-08-01T13:00:00Z',
          correctedBy: 'reviewer',
          corrections: 2,
        },
      ]),
    ],
  );
  await queryRunner.query(
    `INSERT INTO batches_v2
       (id, "tenantId", "totalFeedConsumed", "totalFeedCost")
     VALUES ($1, $3, 10, 20), ($2, $3, 7, 14)`,
    [BATCH_A, BATCH_B, TENANT],
  );
  await queryRunner.query(
    `INSERT INTO batch_locations
       (id, "tenantId", "batchId", "tankId", "movedAt", "exitedAt")
     VALUES
       ($1, $7, $5, $8, '2026-08-01T00:00:00Z', '2026-08-01T10:00:00Z'),
       ($2, $7, $6, $8, '2026-08-01T10:00:00Z', NULL),
       ($3, $7, $5, $9, '2026-08-01T00:00:00Z', NULL),
       ($4, $7, $6, $9, '2026-08-01T00:00:00Z', NULL)`,
    [
      LOCATION_A,
      LOCATION_B,
      LOCATION_OVERLAP_A,
      LOCATION_OVERLAP_B,
      BATCH_A,
      BATCH_B,
      TENANT,
      UNIT_A,
      UNIT_C,
    ],
  );
  await queryRunner.query(
    `INSERT INTO daily_feeding_executions
       (id, "tenantId", "equipmentId", "equipmentType", "completedAt")
     VALUES
       ($1, $6, $7, 'tank', '2026-08-01T09:59:00Z'),
       ($2, $6, $7, 'tank', '2026-08-01T10:01:00Z'),
       ($3, $6, $7, 'tank', NULL),
       ($4, $6, $8, 'tank', '2026-08-01T10:02:00Z'),
       ($5, $6, $9, 'tank', '2026-08-01T10:02:00Z')`,
    [
      EXECUTION_A,
      EXECUTION_B,
      EXECUTION_NULL,
      EXECUTION_MISSING,
      EXECUTION_OVERLAP,
      TENANT,
      UNIT_A,
      UNIT_B,
      UNIT_C,
    ],
  );
  await queryRunner.query(
    `INSERT INTO feeding_records
       (id, "tenantId", "batchId", "tankId", "batchLocationId", "feedingDate",
        "feedingTime", "actualAmount", "feedCost", "sourceExecutionId", "createdAt")
     VALUES
       ($1, $9, $10, $12, $11, '2026-08-01', '09:59', 2, 4, $6, '2026-08-01T09:59:00Z'),
       ($2, $9, $10, $12, $11, '2026-08-01', '10:01', 3, 6, $7, '2026-08-01T10:01:00Z'),
       ($3, $9, $10, $12, $13, '2026-08-01', '10:02', 1, 2, $8, '2026-08-01T10:02:00Z'),
       ($4, $9, $10, $14, NULL, '2026-08-01', '10:02', 1, 2, $15, '2026-08-01T10:02:00Z'),
       ($5, $9, $10, $16, NULL, '2026-08-01', '10:02', 1, 2, $17, '2026-08-01T10:02:00Z')`,
    [
      RECORD_A,
      RECORD_B,
      RECORD_NULL,
      RECORD_MISSING,
      RECORD_OVERLAP,
      EXECUTION_A,
      EXECUTION_B,
      EXECUTION_NULL,
      TENANT,
      BATCH_B,
      LOCATION_B,
      UNIT_A,
      LOCATION_A,
      UNIT_B,
      EXECUTION_MISSING,
      UNIT_C,
      EXECUTION_OVERLAP,
    ],
  );
}

async function createResolutionSchema(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE feeding_day_plans (
      id uuid PRIMARY KEY,
      "createdAt" timestamptz NOT NULL,
      snapshot jsonb NOT NULL
    )
  `);
}

const VALID_RESOLUTION_SNAPSHOT = Object.freeze({
  bandIndex: 2,
  feed: { id: FEED, code: 'FEED-01', name: 'Starter Feed' },
  baseRatePercent: 1.25,
  tempMultiplier: 0.8,
  effectiveRatePercent: 1,
  expectedFcr: 1.5,
  fcrResolvedSource: 'band',
  avgWeightG: 250,
  waterTempC: 14.25,
  temperatureSource: 'sensor',
});

async function createRecalcSchema(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE feeding_day_plans (
      id uuid PRIMARY KEY,
      "recalcLog" jsonb NOT NULL
    )
  `);
}

async function createMealWindowSchema(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE feeding_meals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenantId" uuid NOT NULL,
      "scheduledAt" timestamptz NOT NULL,
      "windowNotifiedAt" timestamptz,
      status text NOT NULL
    );
    CREATE INDEX "IDX_fm_window_pending"
      ON feeding_meals ("tenantId", "scheduledAt")
      WHERE status = 'scheduled' AND "windowNotifiedAt" IS NULL;
  `);
}

async function createAssignmentSchema(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TYPE feeding_protocol_assignments_status_enum
      AS ENUM ('active', 'paused', 'ended');
    CREATE TABLE feeding_protocol_assignments (
      id uuid PRIMARY KEY,
      "tenantId" uuid NOT NULL,
      "unitId" uuid NOT NULL,
      status feeding_protocol_assignments_status_enum NOT NULL,
      "effectiveFrom" date NOT NULL,
      "endedAt" timestamptz,
      "createdAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL,
      version integer NOT NULL
    );
    CREATE UNIQUE INDEX "IDX_fpa_tenant_unit_active"
      ON feeding_protocol_assignments ("tenantId", "unitId")
      WHERE status = 'active';
  `);
}

async function createMealMethodSchema(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE feeding_meals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "feedingMethod" varchar(50),
      pours jsonb NOT NULL DEFAULT '[]'::jsonb
    )
  `);
}

async function createForecastPoolSchema(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE feeding_forecast_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenantId" uuid NOT NULL,
      "siteScopeKey" varchar(100) NOT NULL
    )
  `);
}

async function createFeedingRecordWriteProvenanceSchema(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE batches_v2 (
      id uuid PRIMARY KEY,
      "totalFeedConsumed" numeric(18,3) NOT NULL,
      "totalFeedCost" numeric(18,3) NOT NULL
    );
    CREATE TABLE feeding_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenantId" uuid NOT NULL,
      "batchId" uuid NOT NULL,
      "tankId" uuid,
      "pondId" uuid,
      "batchLocationId" uuid,
      "feedingDate" date NOT NULL,
      "feedingTime" varchar(10) NOT NULL,
      "feedId" uuid NOT NULL,
      "plannedAmount" numeric(10,3) NOT NULL,
      "actualAmount" numeric(10,3) NOT NULL,
      "feedCost" numeric(15,2),
      currency varchar(3),
      "fedBy" uuid NOT NULL,
      "mealId" uuid,
      "pourIndex" integer,
      "dayPlanId" uuid,
      "sourceExecutionId" uuid,
      "createdAt" timestamptz NOT NULL
    )
  `);
}

interface WriteProvenanceFixtureV1 {
  readonly recordId: string;
  readonly sourceExecutionId: string;
  readonly operationId: string;
  readonly origin: 'BACKFILL_180660' | 'LIVE_DRAIN';
  readonly actualAmount: number;
  readonly feedCost: number;
}

async function insertWriteProvenanceFixture(
  queryRunner: QueryRunner,
  fixture: WriteProvenanceFixtureV1,
): Promise<void> {
  await queryRunner.startTransaction();
  try {
    await queryRunner.query(
      `INSERT INTO feeding_records
         (id, "tenantId", "batchId", "tankId", "feedingDate", "feedingTime", "feedId",
          "plannedAmount", "actualAmount", "feedCost", currency, "fedBy",
          "sourceExecutionId", "createdAt")
       VALUES ($1, $2, $3, $4, DATE '2026-07-20', '08:00', $5,
               $6, $6, $7, 'NOK', $8, $9, TIMESTAMPTZ '2026-07-20T08:00:00Z')`,
      [
        fixture.recordId,
        TENANT,
        BATCH_A,
        UNIT_A,
        FEED,
        fixture.actualAmount,
        fixture.feedCost,
        UNIT_B,
        fixture.sourceExecutionId,
      ],
    );
    if (fixture.origin === 'BACKFILL_180660') {
      await queryRunner.query(
        `SELECT * FROM register_feeding_record_backfill_write_v1($1,$2,$3,now())`,
        [TENANT, fixture.recordId, fixture.operationId],
      );
    } else {
      await queryRunner.query(
        `SELECT * FROM append_feeding_record_write_provenance_v1($1,$2,$3,$4,now())`,
        [TENANT, fixture.recordId, fixture.operationId, fixture.origin],
      );
    }
    await queryRunner.commitTransaction();
  } catch (error) {
    if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
    throw error;
  }
}

async function rollbackProofForOperation(
  queryRunner: QueryRunner,
  operationId: string,
): Promise<ReturnType<typeof compileFeedingRecordRollbackExactSetProofV1>> {
  const targets: Array<{ feedingRecordId: string; recordDigest: string }> = await queryRunner.query(
    `SELECT "feedingRecordId"::text AS "feedingRecordId", "recordDigest"::text AS "recordDigest"
         FROM feeding_record_write_provenance
        WHERE "tenantId" = $1 AND "operationId" = $2
        ORDER BY "feedingRecordId"`,
    [TENANT, operationId],
  );
  return compileFeedingRecordRollbackExactSetProofV1(targets);
}

/**
 * One table-driven authority for every post-control-plane feeding migration.
 * Each vector owns its exact prior state, admitted history, success proof and
 * fail-closed restoration proof; the runner owns transaction/database lifecycle.
 */
const FEEDING_MIGRATION_VECTOR_SOURCE = [
  {
    id: '1808800000000',
    migration: AddTankOperationCountProvenance1808800000000,
    arrange: (queryRunner) =>
      queryRunner.query(`CREATE TABLE tank_operations (id uuid PRIMARY KEY)`).then(() => undefined),
    seed: (queryRunner) =>
      queryRunner
        .query(`INSERT INTO tank_operations VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')`)
        .then(() => undefined),
    verify: async (queryRunner) => {
      const rows: Array<{ countDerived: boolean }> = await queryRunner.query(
        `SELECT "countDerived" FROM tank_operations`,
      );
      expect(rows).toEqual([{ countDerived: false }]);
    },
    failures: [],
  },
  {
    id: '1808900000000',
    migration: CreateFeedingHistoricalProvenanceAuthority1808900000000,
    arrange: createGrowthSchema,
    seed: seedValidGrowth,
    verify: async (queryRunner) => {
      await queryRunner.query(`SELECT set_config('app.current_tenant', $1, false)`, [TENANT]);
      await expectHistoricalProjectionSchemaCatalog(queryRunner);
      const rows: Array<{
        version: number;
        mode: string;
        applied: string;
        growth: string;
      }> = await queryRunner.query(`
        SELECT "growthPolicyVersion" AS version, "growthApplicationMode" AS mode,
               "rollupAppliedKg"::text AS applied, "rollupGrowthKg"::text AS growth
          FROM feeding_day_plans
         WHERE id = '${DAY_PLAN}'
      `);
      expect(rows[0]).toEqual({ version: 1, mode: 'daily', applied: '6.000', growth: '3.000' });

      const rollupIndex: Array<{ definition: string; predicate: string }> =
        await queryRunner.query(`
          SELECT pg_get_indexdef(index_row.indexrelid) AS definition,
                 pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
            FROM pg_index index_row
            JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
           WHERE index_relation.relname = 'IDX_fdp_rollup_pending'
        `);
      expect(rollupIndex).toHaveLength(1);
      expect(rollupIndex[0]?.definition).toContain('("tenantId", "siteId", "planDate", "unitId")');
      expect(rollupIndex[0]?.predicate).toBe(
        `((("growthApplicationMode")::text = 'daily'::text) AND (status = ANY (ARRAY['in_progress'::text, 'completed'::text])))`,
      );

      const quarantine: Array<{ id: string; status: string; reason: string }> =
        await queryRunner.query(`
          SELECT projection."dayPlanId"::text AS id, projection.status,
                 projection."reasonCode" AS reason
            FROM feeding_historical_day_plan_growth_v1 projection
           WHERE projection."dayPlanId" IN ('${DAY_PLAN_MULTI}', '${DAY_PLAN_UNSTAMPED}')
           ORDER BY projection."dayPlanId"
        `);
      expect(quarantine).toEqual([
        {
          id: DAY_PLAN_MULTI,
          status: 'QUARANTINED',
          reason: 'MULTIPLE_POST_STAMP_CORRECTIONS',
        },
        {
          id: DAY_PLAN_UNSTAMPED,
          status: 'QUARANTINED',
          reason: 'UNSTAMPED_HISTORICAL_PLAN',
        },
      ]);

      const attribution: Array<{
        id: string;
        status: string;
        batchId: string | null;
        batchLocationId: string | null;
        sourceKind: string;
      }> = await queryRunner.query(`
        SELECT records.id::text, projection.status,
               records."batchId"::text AS "batchId",
               records."batchLocationId"::text AS "batchLocationId",
               projection.payload->>'sourceKind' AS "sourceKind"
          FROM feeding_records records
          JOIN feeding_historical_record_attribution_v1 projection
            ON projection."tenantId" = records."tenantId"
           AND projection."feedingRecordId" = records.id
         WHERE records.id IN ('${RECORD_A}', '${RECORD_B}', '${RECORD_NULL}')
         ORDER BY records.id
      `);
      expect(attribution).toEqual([
        {
          id: RECORD_A,
          status: 'QUALIFIED',
          batchId: BATCH_A,
          batchLocationId: LOCATION_A,
          sourceKind: 'LEGACY_EXECUTION',
        },
        {
          id: RECORD_B,
          status: 'QUALIFIED',
          batchId: BATCH_B,
          batchLocationId: LOCATION_B,
          sourceKind: 'LEGACY_EXECUTION',
        },
        {
          id: RECORD_NULL,
          status: 'QUARANTINED',
          batchId: BATCH_B,
          batchLocationId: LOCATION_A,
          sourceKind: 'LEGACY_EXECUTION',
        },
      ]);
      const ambiguity: Array<{ id: string; reason: string }> = await queryRunner.query(`
        SELECT "feedingRecordId"::text AS id, "reasonCode" AS reason
          FROM feeding_historical_record_attribution_v1
         WHERE "feedingRecordId" IN ('${RECORD_MISSING}', '${RECORD_OVERLAP}')
         ORDER BY "feedingRecordId"
      `);
      expect(ambiguity).toEqual([
        { id: RECORD_MISSING, reason: 'MISSING_OCCUPANCY_INTERVAL' },
        { id: RECORD_OVERLAP, reason: 'OVERLAPPING_OCCUPANCY_INTERVALS' },
      ]);
      const aggregateDelta: Array<{ id: string; feed: string; cost: string }> =
        await queryRunner.query(`
          SELECT id::text, "totalFeedConsumed"::text AS feed, "totalFeedCost"::text AS cost
            FROM batches_v2 ORDER BY id
        `);
      expect(aggregateDelta).toEqual([
        { id: BATCH_A, feed: '12.000', cost: '24.00' },
        { id: BATCH_B, feed: '5.000', cost: '10.00' },
      ]);
      const qualified: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*)::text AS count FROM feeding_historical_qualified_records_v1`,
      );
      expect(qualified).toEqual([{ count: '2' }]);

      await expect(
        queryRunner.query(
          `UPDATE feeding_day_plans SET "growthApplicationMode" = 'per_meal' WHERE id = $1`,
          [DAY_PLAN],
        ),
      ).rejects.toThrow('differs from append-only provenance');

      const predecessor: Array<{ digest: string }> = await queryRunner.query(
        `SELECT "eventDigest" AS digest
           FROM feeding_historical_provenance_events
          WHERE "subjectId" = $1 ORDER BY sequence DESC LIMIT 1`,
        [DAY_PLAN],
      );
      const appendParameters = [
        TENANT,
        'DAY_PLAN',
        DAY_PLAN,
        'GROWTH_APPLIED',
        JSON.stringify({
          applicationMode: 'DAILY_ROLLUP',
          appliedAt: '2026-08-02T12:00:00.000Z',
          expectedFcr: '2.000000',
          feedDeltaKg: '1.000',
          growthDeltaKg: '0.500',
          schemaVersion: 'feeding-historical-provenance/v1',
          sourceRef: 'test:daily-rollup:2',
        }),
        'test/operation/daily-rollup-2',
        'test:growth:daily-rollup-2',
        predecessor[0]?.digest,
        '2026-08-02T12:00:00.000Z',
        'test-runner',
      ];
      const appendSql = `SELECT * FROM append_feeding_historical_provenance_v1(
        $1::uuid, $2::text, $3::uuid, $4::text, $5::jsonb, $6::text,
        $7::text, $8::text, $9::timestamptz, $10::text
      )`;
      const firstAppend = await queryRunner.query(appendSql, appendParameters);
      const replayAppend = await queryRunner.query(appendSql, appendParameters);
      expect(replayAppend).toEqual(firstAppend);
      expect(
        await queryRunner.query(
          `SELECT "rollupAppliedKg"::text AS feed, "rollupGrowthKg"::text AS growth
             FROM feeding_day_plans WHERE id = $1`,
          [DAY_PLAN],
        ),
      ).toEqual([{ feed: '7.000', growth: '3.500' }]);
      await expect(
        queryRunner.query(appendSql, [
          ...appendParameters.slice(0, 6),
          'test:growth:stale-predecessor',
          '0'.repeat(64),
          ...appendParameters.slice(8),
        ]),
      ).rejects.toMatchObject({ code: '40001' });

      const assertedAttribution: Array<{ digest: string; payload: Record<string, string> }> =
        await queryRunner.query(
          `SELECT "eventDigest" AS digest, payload
             FROM feeding_historical_provenance_events
            WHERE "subjectKind" = 'FEEDING_RECORD' AND "subjectId" = $1
            ORDER BY sequence DESC LIMIT 1`,
          [RECORD_A],
        );
      const asserted = assertedAttribution[0];
      if (!asserted) throw new Error('Missing asserted attribution provenance fixture');
      const assertedResolutionPayload = {
        batchId: BATCH_A,
        batchLocationId: LOCATION_A,
        completedAt: '2026-08-01T09:59:00.000Z',
        equipmentId: UNIT_A,
        locationType: 'tank',
        originalRecordDigest: asserted.payload.originalRecordDigest,
        resolutionNote: 'asserted events are terminal',
        resolvesEventDigest: asserted.digest,
        schemaVersion: 'feeding-historical-provenance/v1',
        sourceExecutionId: EXECUTION_A,
        sourceKind: 'LEGACY_EXECUTION',
      };
      await expect(
        queryRunner.query(appendSql, [
          TENANT,
          'FEEDING_RECORD',
          RECORD_A,
          'ATTRIBUTION_RESOLVED',
          JSON.stringify(assertedResolutionPayload),
          'test/operation/illegal-asserted-resolution',
          'test:attribution:illegal-asserted-resolution',
          asserted.digest,
          '2026-08-02T13:00:00.000Z',
          'test-runner',
        ]),
      ).rejects.toMatchObject({ code: '55000' });

      const quarantinedAttribution: Array<{ digest: string; payload: Record<string, string> }> =
        await queryRunner.query(
          `SELECT "eventDigest" AS digest, payload
             FROM feeding_historical_provenance_events
            WHERE "subjectKind" = 'FEEDING_RECORD' AND "subjectId" = $1
            ORDER BY sequence DESC LIMIT 1`,
          [RECORD_NULL],
        );
      const quarantined = quarantinedAttribution[0];
      if (!quarantined) throw new Error('Missing quarantined attribution provenance fixture');
      const resolvedAt = '2026-08-02T13:15:00.000Z';
      const resolutionPayload = {
        batchId: BATCH_B,
        batchLocationId: LOCATION_A,
        completedAt: '2026-08-01T10:02:00.000Z',
        equipmentId: UNIT_A,
        locationType: 'tank',
        originalRecordDigest: quarantined.payload.originalRecordDigest,
        resolutionNote: 'completion time verified against source log',
        resolvesEventDigest: quarantined.digest,
        schemaVersion: 'feeding-historical-provenance/v1',
        sourceExecutionId: EXECUTION_NULL,
        sourceKind: 'LEGACY_EXECUTION',
      };
      await expect(
        queryRunner.query(appendSql, [
          TENANT,
          'FEEDING_RECORD',
          RECORD_NULL,
          'ATTRIBUTION_RESOLVED',
          JSON.stringify({ ...resolutionPayload, originalRecordDigest: 'f'.repeat(64) }),
          'test/operation/wrong-original-record',
          'test:attribution:wrong-original-record',
          quarantined.digest,
          resolvedAt,
          'test-runner',
        ]),
      ).rejects.toMatchObject({ code: '55000' });

      const resolutionParameters = [
        TENANT,
        'FEEDING_RECORD',
        RECORD_NULL,
        'ATTRIBUTION_RESOLVED',
        JSON.stringify(resolutionPayload),
        'test/operation/resolve-quarantine',
        'test:attribution:resolve-quarantine',
        quarantined.digest,
        resolvedAt,
        'test-runner',
      ];
      const firstResolution: Array<{
        event_id: string;
        event_sequence: string;
        event_digest: string;
      }> = await queryRunner.query(appendSql, resolutionParameters);
      expect(await queryRunner.query(appendSql, resolutionParameters)).toEqual(firstResolution);
      const resolved = firstResolution[0];
      if (!resolved) throw new Error('Attribution resolution did not return its journal identity');

      await expect(
        queryRunner.query(appendSql, [
          ...resolutionParameters.slice(0, 4),
          JSON.stringify({ ...resolutionPayload, resolutionNote: 'conflicting replay' }),
          resolutionParameters[5],
          resolutionParameters[6],
          resolved.event_digest,
          ...resolutionParameters.slice(8),
        ]),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        queryRunner.query(appendSql, [
          TENANT,
          'FEEDING_RECORD',
          RECORD_NULL,
          'ATTRIBUTION_RESOLVED',
          JSON.stringify({
            ...resolutionPayload,
            resolutionNote: 'second resolution is illegal',
            resolvesEventDigest: resolved.event_digest,
          }),
          'test/operation/second-resolution',
          'test:attribution:second-resolution',
          resolved.event_digest,
          '2026-08-02T13:30:00.000Z',
          'test-runner',
        ]),
      ).rejects.toMatchObject({ code: '55000' });

      const raceQuarantine: Array<{ digest: string; payload: Record<string, string> }> =
        await queryRunner.query(
          `SELECT "eventDigest" AS digest, payload
             FROM feeding_historical_provenance_events
            WHERE "subjectKind" = 'FEEDING_RECORD' AND "subjectId" = $1
            ORDER BY sequence DESC LIMIT 1`,
          [RECORD_MISSING],
        );
      const racePredecessor = raceQuarantine[0];
      if (!racePredecessor) throw new Error('Missing concurrent attribution provenance fixture');
      const racePayload = {
        batchId: BATCH_B,
        batchLocationId: LOCATION_A,
        completedAt: '2026-08-01T10:02:00.000Z',
        equipmentId: UNIT_B,
        locationType: 'tank',
        originalRecordDigest: racePredecessor.payload.originalRecordDigest,
        resolutionNote: 'concurrent resolution A',
        resolvesEventDigest: racePredecessor.digest,
        schemaVersion: 'feeding-historical-provenance/v1',
        sourceExecutionId: EXECUTION_MISSING,
        sourceKind: 'LEGACY_EXECUTION',
      };
      const raceSchemaRows: Array<{ schema: string }> = await queryRunner.query(
        `SELECT current_schema() AS schema`,
      );
      const raceSchema = raceSchemaRows[0]?.schema;
      if (!raceSchema || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raceSchema)) {
        throw new Error(`Unsafe provenance race schema: ${raceSchema ?? '<missing>'}`);
      }
      const raceRunnerA = queryRunner.connection.createQueryRunner();
      const raceRunnerB = queryRunner.connection.createQueryRunner();
      await Promise.all([raceRunnerA.connect(), raceRunnerB.connect()]);
      try {
        await Promise.all(
          [raceRunnerA, raceRunnerB].map(async (raceRunner) => {
            await raceRunner.query(`SET search_path TO "${raceSchema}"`);
            await raceRunner.query(`SELECT set_config('app.current_tenant', $1, false)`, [TENANT]);
          }),
        );
        const raceBase = [TENANT, 'FEEDING_RECORD', RECORD_MISSING, 'ATTRIBUTION_RESOLVED'];
        const raceTail = [
          'test/operation/concurrent-resolution',
          'test:attribution:concurrent-resolution',
          racePredecessor.digest,
          '2026-08-02T13:45:00.000Z',
          'test-runner',
        ];
        const results = await Promise.allSettled([
          raceRunnerA.query(appendSql, [...raceBase, JSON.stringify(racePayload), ...raceTail]),
          raceRunnerB.query(appendSql, [
            ...raceBase,
            JSON.stringify({ ...racePayload, resolutionNote: 'concurrent resolution B' }),
            ...raceTail,
          ]),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toMatchObject({ code: '23505' });
      } finally {
        await Promise.all([raceRunnerA.release(), raceRunnerB.release()]);
      }

      await expect(
        queryRunner.query(
          `INSERT INTO feeding_historical_provenance_events
             ("tenantId", "subjectKind", "subjectId", sequence, "prevDigest", "eventKind",
              payload, "payloadCanonical", "operationId", "idempotencyKey", "recordedAt",
              "recordedBy", "schemaVersion", "catalogDigest", "eventDigest")
           SELECT "tenantId", "subjectKind", "subjectId", sequence + 100, "eventDigest", "eventKind",
                  payload, "payloadCanonical", 'forged', 'forged', now(), 'forged',
                  "schemaVersion", "catalogDigest", repeat('f', 64)
             FROM feeding_historical_provenance_events LIMIT 1`,
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        queryRunner.query(
          `UPDATE feeding_historical_provenance_events
              SET payload = payload
            WHERE "eventId" = (SELECT "eventId" FROM feeding_historical_provenance_events LIMIT 1)`,
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        queryRunner.query(
          `DELETE FROM feeding_historical_provenance_events
            WHERE "eventId" = (SELECT "eventId" FROM feeding_historical_provenance_events LIMIT 1)`,
        ),
      ).rejects.toMatchObject({ code: '55000' });
      expect(
        await queryRunner.query(`
          SELECT bool_and(
                   "eventDigest" = feeding_historical_event_digest_v1(
                     "tenantId", "subjectKind", "subjectId", sequence, "prevDigest", "eventKind",
                     "payloadCanonical", "operationId", "idempotencyKey", "recordedAt", "recordedBy"
                   )
                 ) AS valid
            FROM feeding_historical_provenance_events
        `),
      ).toEqual([{ valid: true }]);

      const schemaRows: Array<{ schema: string }> = await queryRunner.query(
        `SELECT current_schema() AS schema`,
      );
      const testSchema = schemaRows[0]?.schema;
      if (!testSchema || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(testSchema)) {
        throw new Error(`Unsafe provenance RLS test schema: ${testSchema ?? '<missing>'}`);
      }
      await queryRunner.query(`CREATE ROLE "${PROVENANCE_RLS_TEST_ROLE}" NOLOGIN`);
      try {
        await queryRunner.query(
          `GRANT USAGE ON SCHEMA "${testSchema}" TO "${PROVENANCE_RLS_TEST_ROLE}"`,
        );
        await queryRunner.query(
          `GRANT SELECT ON
             feeding_historical_provenance_events,
             feeding_historical_current_events_v1,
             feeding_historical_record_attribution_v1
           TO "${PROVENANCE_RLS_TEST_ROLE}"`,
        );
        await queryRunner.query(
          `GRANT EXECUTE ON FUNCTION append_feeding_historical_provenance_v1(
             uuid, text, uuid, text, jsonb, text, text, text, timestamptz, text
           ) TO "${PROVENANCE_RLS_TEST_ROLE}"`,
        );
        await queryRunner.query(`SET ROLE "${PROVENANCE_RLS_TEST_ROLE}"`);
        await queryRunner.query(`SELECT set_config('app.current_tenant', $1, false)`, [TENANT]);
        const ownTenantRows: Array<{ count: string }> = await queryRunner.query(
          `SELECT COUNT(*)::text AS count FROM feeding_historical_provenance_events`,
        );
        expect(Number(ownTenantRows[0]?.count ?? '0')).toBeGreaterThan(0);
        const ownTenantProjection: Array<{ count: string }> = await queryRunner.query(
          `SELECT COUNT(*)::text AS count FROM feeding_historical_record_attribution_v1`,
        );
        expect(Number(ownTenantProjection[0]?.count ?? '0')).toBeGreaterThan(0);

        await queryRunner.query(`SELECT set_config('app.current_tenant', $1, false)`, [SITE_B]);
        expect(
          await queryRunner.query(
            `SELECT COUNT(*)::text AS count FROM feeding_historical_provenance_events`,
          ),
        ).toEqual([{ count: '0' }]);
        expect(
          await queryRunner.query(
            `SELECT COUNT(*)::text AS count FROM feeding_historical_record_attribution_v1`,
          ),
        ).toEqual([{ count: '0' }]);
        await expect(queryRunner.query(appendSql, appendParameters)).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await queryRunner.query(`RESET ROLE`);
        await queryRunner.query(`SELECT set_config('app.current_tenant', $1, false)`, [TENANT]);
        await queryRunner.query(`DROP OWNED BY "${PROVENANCE_RLS_TEST_ROLE}"`);
        await queryRunner.query(`DROP ROLE "${PROVENANCE_RLS_TEST_ROLE}"`);
      }

      const beforeCrash: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*)::text AS count FROM feeding_historical_provenance_events`,
      );
      const beforeCrashDigest: Array<{ digest: string }> = await queryRunner.query(
        `SELECT "eventDigest" AS digest FROM feeding_historical_provenance_events
          WHERE "subjectId" = $1 ORDER BY sequence DESC LIMIT 1`,
        [DAY_PLAN],
      );
      await queryRunner.startTransaction();
      try {
        await queryRunner.query(appendSql, [
          TENANT,
          'DAY_PLAN',
          DAY_PLAN,
          'GROWTH_APPLIED',
          JSON.stringify({
            applicationMode: 'DAILY_ROLLUP',
            appliedAt: '2026-08-03T12:00:00.000Z',
            expectedFcr: '2.000000',
            feedDeltaKg: '1.000',
            growthDeltaKg: '0.500',
            schemaVersion: 'feeding-historical-provenance/v1',
            sourceRef: 'test:forced-crash',
          }),
          'test/operation/forced-crash',
          'test:growth:forced-crash',
          beforeCrashDigest[0]?.digest,
          '2026-08-03T12:00:00.000Z',
          'test-runner',
        ]);
      } finally {
        await queryRunner.rollbackTransaction();
      }
      expect(
        await queryRunner.query(
          `SELECT COUNT(*)::text AS count FROM feeding_historical_provenance_events`,
        ),
      ).toEqual(beforeCrash);

      const rollbackSnapshot = await queryRunner.query(`
        SELECT
          (SELECT COUNT(*)::text FROM feeding_records) AS records,
          (SELECT string_agg(id::text || ':' || "batchId"::text, ',' ORDER BY id)
             FROM feeding_records) AS attribution,
          (SELECT string_agg(id::text || ':' || "totalFeedConsumed"::text, ',' ORDER BY id)
             FROM batches_v2) AS aggregates,
          (SELECT string_agg("eventDigest", ',' ORDER BY "eventDigest")
             FROM feeding_historical_provenance_events) AS journal
      `);
      await queryRunner.startTransaction();
      try {
        await expect(
          new BackfillExecutionsToFeedingRecords1806600000000().down(queryRunner),
        ).rejects.toMatchObject({ code: '55000' });
      } finally {
        await queryRunner.rollbackTransaction();
      }
      expect(
        await queryRunner.query(`
          SELECT
            (SELECT COUNT(*)::text FROM feeding_records) AS records,
            (SELECT string_agg(id::text || ':' || "batchId"::text, ',' ORDER BY id)
               FROM feeding_records) AS attribution,
            (SELECT string_agg(id::text || ':' || "totalFeedConsumed"::text, ',' ORDER BY id)
               FROM batches_v2) AS aggregates,
            (SELECT string_agg("eventDigest", ',' ORDER BY "eventDigest")
               FROM feeding_historical_provenance_events) AS journal
        `),
      ).toEqual(rollbackSnapshot);
    },
    failures: [],
  },
  {
    id: '1809000000000',
    migration: CompleteFeedInventoryLedgerBackfillBySourceRow1809000000000,
    arrange: createLedgerSchema,
    seed: seedValidLedger,
    replay: true,
    verify: async (queryRunner) => {
      const rows: Array<{ movements: string; inventory: string; quantity: string }> =
        await queryRunner.query(`
          SELECT (SELECT COUNT(*) FROM stock_movements
                   WHERE idempotency_key LIKE 'fi-migrate-%')::text AS movements,
                 (SELECT COUNT(*) FROM storage_inventory)::text AS inventory,
                 (SELECT quantity::text FROM feeds WHERE id = '${FEED}') AS quantity
        `);
      expect(rows[0]).toEqual({ movements: '2', inventory: '3', quantity: '10.00' });
    },
    failures: [
      {
        name: 'unowned legacy row',
        seed: (queryRunner) =>
          queryRunner
            .query(
              `INSERT INTO feed_inventory
                (id, "tenantId", "siteId", "feedId", "quantityKg")
               VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', $1, $2, $3, 4)`,
              [TENANT, SITE_A, FEED],
            )
            .then(() => undefined),
        error: 'cannot be placed',
        verifyRestored: async (queryRunner) => {
          const rows: Array<{ movements: string; locations: string }> = await queryRunner.query(`
            SELECT (SELECT COUNT(*) FROM stock_movements)::text AS movements,
                   (SELECT COUNT(*) FROM storage_locations)::text AS locations
          `);
          expect(rows[0]).toEqual({ movements: '0', locations: '0' });
          expect(
            await queryRunner.query(`SELECT to_regclass('"UQ_storage_inventory_canonical_lot"')`),
          ).toEqual([{ to_regclass: null }]);
        },
      },
    ],
  },
  {
    id: '1809100000000',
    migration: AddDayPlanLiveProtocolResolution1809100000000,
    arrange: createResolutionSchema,
    seed: (queryRunner) =>
      queryRunner
        .query(`INSERT INTO feeding_day_plans VALUES ($1, '2026-08-01T12:34:56.789Z', $2::jsonb)`, [
          DAY_PLAN,
          JSON.stringify(VALID_RESOLUTION_SNAPSHOT),
        ])
        .then(() => undefined),
    verify: async (queryRunner) => {
      const rows: Array<{ resolution: Record<string, unknown>; hasDefault: boolean }> =
        await queryRunner.query(`
          SELECT resolution,
                 EXISTS (
                   SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'feeding_day_plans'
                      AND column_name = 'resolution'
                      AND column_default IS NOT NULL
                 ) AS "hasDefault"
            FROM feeding_day_plans
        `);
      expect(Object.keys(rows[0]?.resolution ?? {}).sort()).toEqual(
        [...PROTOCOL_RESOLUTION_CONTRACT_V1.exactKeys].sort(),
      );
      expect(rows[0]).toMatchObject({
        hasDefault: false,
        resolution: {
          schemaVersion: PROTOCOL_RESOLUTION_CONTRACT_V1.schemaVersion,
          resolvedAt: '2026-08-01T12:34:56.789Z',
          expectedFcr: 1.5,
        },
      });
    },
    failures: [
      {
        name: 'snapshot without exact live provenance',
        seed: (queryRunner) =>
          queryRunner
            .query(`INSERT INTO feeding_day_plans VALUES ($1, now(), '{"expectedFcr":1.5}')`, [
              DAY_PLAN,
            ])
            .then(() => undefined),
        error: `Cannot derive ${PROTOCOL_RESOLUTION_CONTRACT_V1.schemaVersion}`,
        verifyRestored: (queryRunner) =>
          expectColumnAbsent(queryRunner, 'feeding_day_plans', 'resolution'),
      },
    ],
  },
  {
    id: '1809200000000',
    migration: BoundDayPlanRecalculationAudit1809200000000,
    arrange: createRecalcSchema,
    seed: (queryRunner) =>
      queryRunner
        .query(`INSERT INTO feeding_day_plans VALUES ($1, $2::jsonb)`, [
          DAY_PLAN,
          JSON.stringify(Array.from({ length: 55 }, (_, index) => ({ sequence: index + 1 }))),
        ])
        .then(() => undefined),
    verify: async (queryRunner) => {
      const rows: Array<{ count: number; retained: number; first: string; last: string }> =
        await queryRunner.query(`
          SELECT "recalcCount" AS count,
                 jsonb_array_length("recalcLog") AS retained,
                 "recalcLog"->0->>'sequence' AS first,
                 "recalcLog"->-1->>'sequence' AS last
            FROM feeding_day_plans
        `);
      expect(rows[0]).toEqual({
        count: 55,
        retained: DAY_PLAN_RECALC_AUDIT_POLICY_V1.retainedEntries,
        first: '6',
        last: '55',
      });
      await expect(
        queryRunner.query(`UPDATE feeding_day_plans SET "recalcLog" = $1::jsonb`, [
          JSON.stringify(Array.from({ length: 51 }, () => ({}))),
        ]),
      ).rejects.toThrow();
    },
    failures: [
      {
        name: 'non-array audit history',
        seed: (queryRunner) =>
          queryRunner
            .query(`INSERT INTO feeding_day_plans VALUES ($1, '{}')`, [DAY_PLAN])
            .then(() => undefined),
        sqlState: '22023',
        verifyRestored: (queryRunner) =>
          expectColumnAbsent(queryRunner, 'feeding_day_plans', 'recalcCount'),
      },
    ],
  },
  {
    id: '1809300000000',
    migration: WidenMealWindowReemissionIndex1809300000000,
    arrange: createMealWindowSchema,
    seed: (queryRunner) =>
      queryRunner
        .query(
          `INSERT INTO feeding_meals ("tenantId", "scheduledAt", status)
           VALUES ($1, '2026-08-01T12:00:00Z', 'scheduled')`,
          [TENANT],
        )
        .then(() => undefined),
    verify: async (queryRunner) => {
      const rows: Array<{ oldIndex: string | null; newIndex: string | null; definition: string }> =
        await queryRunner.query(`
          SELECT to_regclass('"IDX_fm_window_pending"')::text AS "oldIndex",
                 to_regclass('"IDX_fm_window_sweep"')::text AS "newIndex",
                 pg_get_indexdef('"IDX_fm_window_sweep"'::regclass) AS definition
        `);
      expect(rows[0]?.oldIndex).toBeNull();
      expect(rows[0]?.newIndex).toBe('"IDX_fm_window_sweep"');
      expect(rows[0]?.definition).toContain('("tenantId", "scheduledAt", "windowNotifiedAt")');
      expect(rows[0]?.definition).toContain("WHERE (status = 'scheduled'::text)");
    },
    failures: [],
  },
  {
    id: '1809400000000',
    migration: EnforceSingleLiveProtocolAssignment1809400000000,
    arrange: createAssignmentSchema,
    seed: async (queryRunner) => {
      await queryRunner.query(
        `INSERT INTO feeding_protocol_assignments VALUES
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', $1, $2, 'active', '2026-01-01', NULL,
           '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 1),
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', $1, $2, 'paused', '2026-02-01', NULL,
           '2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z', 3),
          ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', $1, $3, 'paused', '2026-01-01', NULL,
           '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 4),
          ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', $1, $3, 'paused', '2026-03-01', NULL,
           '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', 5)`,
        [TENANT, UNIT_A, UNIT_B],
      );
    },
    verify: async (queryRunner) => {
      const rows: Array<{ id: string; status: string; endedAt: Date | null; version: number }> =
        await queryRunner.query(`
          SELECT id::text, status::text, "endedAt" AS "endedAt", version
            FROM feeding_protocol_assignments
           ORDER BY id
        `);
      expect(rows.map(({ id, status, version }) => ({ id, status, version }))).toEqual([
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', status: 'active', version: 1 },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', status: 'ended', version: 4 },
        { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', status: 'ended', version: 5 },
        { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', status: 'paused', version: 5 },
      ]);
      expect(rows[1]?.endedAt?.toISOString()).toBe('2026-02-02T00:00:00.000Z');
      expect(rows[2]?.endedAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
      await expect(
        queryRunner.query(
          `INSERT INTO feeding_protocol_assignments VALUES
            ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', $1, $2, 'paused', '2026-04-01', NULL,
             now(), now(), 1)`,
          [TENANT, UNIT_A],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    },
    failures: [],
  },
  {
    id: '1809500000000',
    migration: AlignFeedingMealMethodAuthority1809500000000,
    arrange: createMealMethodSchema,
    seed: async (queryRunner) => {
      for (const [index, method] of Object.values(FEEDING_METHOD).entries()) {
        await queryRunner.query(
          `INSERT INTO feeding_meals ("feedingMethod", pours)
           VALUES ($1, $2::jsonb)`,
          [
            method,
            JSON.stringify([
              { pourIndex: index + 1, kg: 1, feedingMethod: method },
              { pourIndex: index + 2, kg: 2 },
            ]),
          ],
        );
      }
    },
    verify: async (queryRunner) => {
      const rows: Array<{ udtName: string; labels: string[]; constraintPresent: boolean }> =
        await queryRunner.query(`
          SELECT c.udt_name AS "udtName",
                 (SELECT jsonb_agg(e.enumlabel::text ORDER BY e.enumsortorder)
                    FROM pg_type t
                    JOIN pg_namespace n ON n.oid = t.typnamespace
                    JOIN pg_enum e ON e.enumtypid = t.oid
                   WHERE n.nspname = current_schema()
                     AND t.typname = 'feeding_meals_feedingmethod_enum') AS labels,
                 EXISTS (
                   SELECT 1 FROM pg_constraint constraint_row
                    WHERE constraint_row.conrelid = 'feeding_meals'::regclass
                      AND constraint_row.conname = 'CHK_feeding_meals_method_v1'
                 ) AS "constraintPresent"
            FROM information_schema.columns c
           WHERE c.table_schema = current_schema()
             AND c.table_name = 'feeding_meals'
             AND c.column_name = 'feedingMethod'
        `);
      expect(rows[0]).toEqual({
        udtName: 'feeding_meals_feedingmethod_enum',
        labels: Object.values(FEEDING_METHOD),
        constraintPresent: true,
      });
      await expect(
        queryRunner.query(`INSERT INTO feeding_meals ("feedingMethod") VALUES ('robot')`),
      ).rejects.toMatchObject({ code: '22P02' });
      await expect(
        queryRunner.query(
          `INSERT INTO feeding_meals ("feedingMethod", pours)
           VALUES ('manual', '[{"feedingMethod":"robot"}]')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    },
    failures: [
      {
        name: 'unknown column method',
        seed: (queryRunner) =>
          queryRunner
            .query(`INSERT INTO feeding_meals ("feedingMethod") VALUES ('robot')`)
            .then(() => undefined),
        error: 'outside the signed vocabulary',
        verifyRestored: expectMealMethodPriorState,
      },
      {
        name: 'unknown embedded pour method',
        seed: (queryRunner) =>
          queryRunner
            .query(
              `INSERT INTO feeding_meals ("feedingMethod", pours)
               VALUES ('manual', '[{"feedingMethod":"robot"}]')`,
            )
            .then(() => undefined),
        error: 'non-canonical feeding method',
        verifyRestored: expectMealMethodPriorState,
      },
      {
        name: 'pre-existing enum label drift',
        seed: async (queryRunner) => {
          await queryRunner.query(
            `CREATE TYPE feeding_meals_feedingmethod_enum AS ENUM ('manual', 'robot')`,
          );
          await queryRunner.query(
            `INSERT INTO feeding_meals ("feedingMethod", pours) VALUES ('manual', '[]')`,
          );
        },
        error: 'differs from FEEDING_METHOD',
        verifyRestored: async (queryRunner) => {
          const rows: Array<{ labels: string[]; dataType: string }> = await queryRunner.query(`
            SELECT (SELECT jsonb_agg(e.enumlabel::text ORDER BY e.enumsortorder)
                      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
                     WHERE t.typname = 'feeding_meals_feedingmethod_enum') AS labels,
                   c.data_type AS "dataType"
              FROM information_schema.columns c
             WHERE c.table_schema = current_schema()
               AND c.table_name = 'feeding_meals'
               AND c.column_name = 'feedingMethod'
          `);
          expect(rows[0]).toEqual({ labels: ['manual', 'robot'], dataType: 'character varying' });
        },
      },
    ],
  },
  {
    id: '1809600000000',
    migration: CompileForecastPoolAuthority1809600000000,
    arrange: createForecastPoolSchema,
    seed: (queryRunner) =>
      queryRunner
        .query(
          `INSERT INTO feeding_forecast_snapshots ("tenantId", "siteScopeKey")
           VALUES ($1, $2)`,
          [TENANT, SITE_A],
        )
        .then(() => undefined),
    verify: async (queryRunner) => {
      const rows: Array<{
        rows: number;
        activeRows: number;
        quarantinedRows: number;
        legacyState: string;
        preserved: boolean;
      }> = await queryRunner.query(`
          SELECT (SELECT count(*)::int FROM feeding_forecast_snapshots) AS rows,
                 (SELECT count(*)::int FROM feeding_forecast_active_snapshots_v1) AS "activeRows",
                 (SELECT count(*)::int FROM feeding_forecast_legacy_quarantine) AS "quarantinedRows",
                 (SELECT state FROM feeding_forecast_generations
                   WHERE "operationId" LIKE 'migration/180960/legacy/%') AS "legacyState",
                 (SELECT NOT ("originalSnapshot" ? 'poolScope')
                         AND "originalDigest" = encode(
                           pg_catalog.sha256(convert_to("originalCanonicalJson", 'UTF8')), 'hex'
                         )
                    FROM feeding_forecast_legacy_quarantine) AS preserved
        `);
      expect(rows).toEqual([
        {
          rows: 1,
          activeRows: 0,
          quarantinedRows: 1,
          legacyState: 'RETIRED',
          preserved: true,
        },
      ]);

      const snapshots = [
        { siteScopeKey: 'tenant', poolScope: 'TENANT' as const, payload: { stock: 10 } },
        { siteScopeKey: SITE_A, poolScope: 'SITE' as const, payload: { stock: 4 } },
      ];
      const proof = compileFeedingForecastGenerationExactSetProofV1(snapshots);
      const generationRows: Array<{ id: string }> = await queryRunner.query(
        `INSERT INTO feeding_forecast_generations
          ("tenantId", "operationId", state, "catalogRevision", "catalogDigest",
           "sourceWatermark", "exactSetDigest", "membershipDigest", "snapshotCount")
         VALUES ($1, 'test/forecast-generation', 'BUILDING', $2, $3, now(), $4, $5, $6)
         RETURNING id`,
        [
          TENANT,
          FEEDING_FORECAST_GENERATION_AUTHORITY.schemaVersion,
          FEEDING_FORECAST_GENERATION_CATALOG_DIGEST,
          proof.exactSetDigest,
          proof.membershipDigest,
          proof.snapshotCount,
        ],
      );
      const generationId = generationRows[0]?.id;
      if (!generationId) throw new Error('Missing forecast generation fixture');
      for (const snapshot of proof.snapshots) {
        await queryRunner.query(
          `INSERT INTO feeding_forecast_snapshots
             ("tenantId", "generationId", "siteScopeKey", "poolScope", "payloadDigest")
           VALUES ($1, $2, $3, $4, $5)`,
          [TENANT, generationId, snapshot.siteScopeKey, snapshot.poolScope, snapshot.payloadDigest],
        );
      }
      await queryRunner.query(
        `SELECT ${FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.qualify}(
          $1,$2,$3,$4,$5,now()
        )`,
        [TENANT, generationId, proof.exactSetDigest, proof.membershipDigest, proof.snapshotCount],
      );
      await queryRunner.query(
        `SELECT ${FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.activate}(
          $1,$2,NULL,now()
        )`,
        [TENANT, generationId],
      );
      expect(
        await queryRunner.query(
          `SELECT "siteScopeKey", "poolScope" FROM feeding_forecast_active_snapshots_v1
            ORDER BY "siteScopeKey" COLLATE "C"`,
        ),
      ).toEqual([
        { siteScopeKey: SITE_A, poolScope: 'SITE' },
        { siteScopeKey: 'tenant', poolScope: 'TENANT' },
      ]);

      const replacementProof = compileFeedingForecastGenerationExactSetProofV1([
        { siteScopeKey: 'tenant', poolScope: 'TENANT', payload: { stock: 6 } },
      ]);
      const replacementRows: Array<{ id: string }> = await queryRunner.query(
        `INSERT INTO feeding_forecast_generations
          ("tenantId", "operationId", state, "catalogRevision", "catalogDigest",
           "sourceWatermark", "exactSetDigest", "membershipDigest", "snapshotCount",
           "previousActiveGenerationId")
         VALUES ($1, 'test/forecast-generation/replacement', 'BUILDING', $2, $3, now(),
                 $4, $5, $6, $7)
         RETURNING id`,
        [
          TENANT,
          FEEDING_FORECAST_GENERATION_AUTHORITY.schemaVersion,
          FEEDING_FORECAST_GENERATION_CATALOG_DIGEST,
          replacementProof.exactSetDigest,
          replacementProof.membershipDigest,
          replacementProof.snapshotCount,
          generationId,
        ],
      );
      const replacementId = replacementRows[0]?.id;
      if (!replacementId) throw new Error('Missing forecast replacement generation fixture');
      const replacementSnapshot = replacementProof.snapshots[0];
      if (!replacementSnapshot) throw new Error('Missing forecast replacement snapshot proof');
      await queryRunner.query(
        `INSERT INTO feeding_forecast_snapshots
           ("tenantId", "generationId", "siteScopeKey", "poolScope", "payloadDigest")
         VALUES ($1, $2, $3, $4, $5)`,
        [
          TENANT,
          replacementId,
          replacementSnapshot.siteScopeKey,
          replacementSnapshot.poolScope,
          replacementSnapshot.payloadDigest,
        ],
      );
      await queryRunner.query(
        `SELECT ${FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.qualify}(
          $1,$2,$3,$4,$5,now()
        )`,
        [
          TENANT,
          replacementId,
          replacementProof.exactSetDigest,
          replacementProof.membershipDigest,
          replacementProof.snapshotCount,
        ],
      );
      await queryRunner.query(
        `SELECT ${FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.activate}(
          $1,$2,$3,now()
        )`,
        [TENANT, replacementId, generationId],
      );
      expect(
        await queryRunner.query(
          `SELECT "siteScopeKey", "poolScope" FROM feeding_forecast_active_snapshots_v1
            ORDER BY "siteScopeKey" COLLATE "C"`,
        ),
      ).toEqual([{ siteScopeKey: 'tenant', poolScope: 'TENANT' }]);

      const purgeRows: Array<{ count: string }> = await queryRunner.query(
        `SELECT ${FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.purgeRetired}(
          $1, now() + interval '1 day'
        )::text AS count`,
        [TENANT],
      );
      expect(purgeRows).toEqual([{ count: '3' }]);
      expect(
        await queryRunner.query(
          `
          SELECT
            (SELECT count(*)::int FROM feeding_forecast_generations) AS generations,
            (SELECT count(*)::int FROM feeding_forecast_snapshots) AS snapshots,
            (SELECT count(*)::int FROM feeding_forecast_active_snapshots_v1) AS active,
            (SELECT count(*)::int FROM feeding_forecast_legacy_quarantine) AS quarantine,
            (SELECT state FROM feeding_forecast_generations WHERE id = $1) AS state
        `,
          [replacementId],
        ),
      ).toEqual([{ generations: 1, snapshots: 1, active: 1, quarantine: 1, state: 'ACTIVE' }]);
      expect(
        await queryRunner.query(
          `SELECT ${FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.purgeRetired}(
            $1, now() + interval '1 day'
          )::text AS count`,
          [TENANT],
        ),
      ).toEqual([{ count: '0' }]);
      await expect(
        queryRunner.query(
          `UPDATE feeding_forecast_generations SET state = 'BUILDING' WHERE id = $1`,
          [replacementId],
        ),
      ).rejects.toMatchObject({ code: '55000' });
    },
    failures: [],
  },
  {
    id: '1809800000000',
    migration: PreserveStockMovementLotReceiptProvenance1809800000000,
    arrange: createLotReceiptProvenanceSchema,
    seed: seedLotReceiptProvenance,
    replay: true,
    verify: async (queryRunner) => {
      const rows: Array<{ id: string; receivedDate: Date | null }> = await queryRunner.query(`
        SELECT id::text, received_date AS "receivedDate"
          FROM stock_movements ORDER BY id
      `);
      expect(rows).toEqual([
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          receivedDate: new Date('2026-01-02T00:00:00.000Z'),
        },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', receivedDate: null },
      ]);
    },
    failures: [],
  },
  {
    id: '1809900000000',
    migration: BindStockCorrectionAllocationFamily1809900000000,
    arrange: createCorrectionAllocationSchema,
    seed: seedCorrectionAllocation,
    replay: true,
    verify: async (queryRunner) => {
      await queryRunner.query(
        `INSERT INTO stock_movements
           (id, tenant_id, movement_type, item_type, item_id, item_name, quantity, unit,
            to_location_id, lot_number, idempotency_key, allocation_family_key,
            source_movement_id, performed_by, performed_at)
         VALUES
           ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', $1, 'return', 'feed', $2, 'Feed',
            0.30, 'kg', $3, 'LOT-A', 'meal-correct-meal-1-0-1', 'meal-deduct-meal-1-0',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', $4, '2026-08-02T08:00:00Z')
         ON CONFLICT (id) DO NOTHING`,
        [TENANT, FEED, LOCATION_A, BATCH_A],
      );
      const families: Array<{ idempotencyKey: string; familyKey: string | null }> =
        await queryRunner.query(`
          SELECT idempotency_key AS "idempotencyKey",
                 allocation_family_key AS "familyKey"
            FROM stock_movements
           ORDER BY idempotency_key
        `);
      expect(families).toEqual([
        { idempotencyKey: 'manual-stock-out', familyKey: null },
        {
          idempotencyKey: 'meal-correct-meal-1-0-1',
          familyKey: 'meal-deduct-meal-1-0',
        },
        { idempotencyKey: 'meal-deduct-meal-1-0', familyKey: 'meal-deduct-meal-1-0' },
        { idempotencyKey: 'meal-deduct-meal-1-0:1', familyKey: 'meal-deduct-meal-1-0' },
      ]);
      await expect(
        queryRunner.query(
          `INSERT INTO stock_movements
             (tenant_id, movement_type, item_type, item_id, item_name, quantity, unit,
              from_location_id, idempotency_key, allocation_family_key, source_movement_id,
              performed_by, performed_at)
           VALUES ($1, 'out', 'feed', $2, 'Feed', 1, 'kg', $3, 'illegal-source-link',
                   'meal-deduct-meal-1-0', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
                   $4, '2026-08-02T08:00:00Z')`,
          [TENANT, FEED, LOCATION_A, BATCH_A],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        queryRunner.query(
          `INSERT INTO stock_movements
             (tenant_id, movement_type, item_type, item_id, item_name, quantity, unit,
              to_location_id, idempotency_key, allocation_family_key, source_movement_id,
              performed_by, performed_at)
           VALUES ($1, 'return', 'feed', $2, 'Feed', 1, 'kg', $3, 'cross-tenant-link',
                   'meal-deduct-meal-1-0', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
                   $4, '2026-08-02T08:00:00Z')`,
          [SITE_B, FEED, LOCATION_A, BATCH_A],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        queryRunner.query(
          `DELETE FROM stock_movements
            WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'`,
        ),
      ).rejects.toMatchObject({ code: '23503' });
    },
    failures: [
      {
        name: 'allocation identity exceeds the durable schema',
        seed: (queryRunner) =>
          queryRunner
            .query(
              `INSERT INTO stock_movements
                 (tenant_id, movement_type, item_type, item_id, item_name, quantity, unit,
                  idempotency_key, performed_by, performed_at)
               VALUES ($1, 'out', 'feed', $2, 'Feed', 1, 'kg', $3, $4, now())`,
              [TENANT, FEED, `meal-deduct-${'x'.repeat(64)}`, BATCH_A],
            )
            .then(() => undefined),
        sqlState: '22001',
        verifyRestored: (queryRunner) =>
          expectColumnAbsent(queryRunner, 'stock_movements', 'allocation_family_key'),
      },
    ],
  },
  {
    id: '1810000000000',
    migration: CreateFeedingRecordWriteProvenanceAuthority1810000000000,
    arrange: createFeedingRecordWriteProvenanceSchema,
    seed: async (queryRunner) => {
      await queryRunner.query(
        `INSERT INTO batches_v2 (id, "totalFeedConsumed", "totalFeedCost")
           VALUES ($1, 100, 200)`,
        [BATCH_A],
      );
      await queryRunner.query(
        `INSERT INTO feeding_records
             (id, "tenantId", "batchId", "tankId", "feedingDate", "feedingTime", "feedId",
              "plannedAmount", "actualAmount", "feedCost", currency, "fedBy",
              "sourceExecutionId", "createdAt")
           VALUES ($1, $2, $3, $4, DATE '2026-07-19', '08:00', $5,
                   5, 5, 10, 'NOK', $6, $7, TIMESTAMPTZ '2026-07-19T08:00:00Z')`,
        [RECORD_AMBIGUOUS_WRITE, TENANT, BATCH_A, UNIT_A, FEED, UNIT_B, EXECUTION_A],
      );
    },
    verify: async (queryRunner) => {
      const quarantined: Array<{ origin: string; operationId: string }> = await queryRunner.query(`
          SELECT origin, "operationId" FROM feeding_record_write_provenance_quarantine_v1
        `);
      expect(quarantined).toEqual([
        {
          origin: 'AMBIGUOUS_PRE_AUTHORITY',
          operationId: `migration/181000/ambiguous/${RECORD_AMBIGUOUS_WRITE}`,
        },
      ]);
      await expect(
        queryRunner.query(`DELETE FROM feeding_records WHERE id = $1`, [RECORD_AMBIGUOUS_WRITE]),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        queryRunner.query(
          `UPDATE feeding_record_write_provenance
              SET "operationId" = 'forged' WHERE "feedingRecordId" = $1`,
          [RECORD_AMBIGUOUS_WRITE],
        ),
      ).rejects.toMatchObject({ code: '55000' });

      const mixedOperation = 'migration/180660/mixed-origin';
      const liveOperation = 'feeding-operation/live-only';
      const changedOperation = 'migration/180660/changed-record';
      const successOperation = 'migration/180660/exact-success';
      await insertWriteProvenanceFixture(queryRunner, {
        recordId: RECORD_MIXED_BACKFILL,
        sourceExecutionId: '20000000-0000-4000-8000-000000000002',
        operationId: mixedOperation,
        origin: 'BACKFILL_180660',
        actualAmount: 1,
        feedCost: 2,
      });
      await insertWriteProvenanceFixture(queryRunner, {
        recordId: RECORD_MIXED_LIVE,
        sourceExecutionId: '20000000-0000-4000-8000-000000000003',
        operationId: mixedOperation,
        origin: 'LIVE_DRAIN',
        actualAmount: 1,
        feedCost: 2,
      });
      await insertWriteProvenanceFixture(queryRunner, {
        recordId: RECORD_LIVE_ONLY,
        sourceExecutionId: '20000000-0000-4000-8000-000000000004',
        operationId: liveOperation,
        origin: 'LIVE_DRAIN',
        actualAmount: 1,
        feedCost: 2,
      });
      await insertWriteProvenanceFixture(queryRunner, {
        recordId: RECORD_CHANGED_BACKFILL,
        sourceExecutionId: '20000000-0000-4000-8000-000000000005',
        operationId: changedOperation,
        origin: 'BACKFILL_180660',
        actualAmount: 2,
        feedCost: 4,
      });
      await insertWriteProvenanceFixture(queryRunner, {
        recordId: RECORD_SUCCESS_A,
        sourceExecutionId: '20000000-0000-4000-8000-000000000006',
        operationId: successOperation,
        origin: 'BACKFILL_180660',
        actualAmount: 3,
        feedCost: 6,
      });
      await insertWriteProvenanceFixture(queryRunner, {
        recordId: RECORD_SUCCESS_B,
        sourceExecutionId: '20000000-0000-4000-8000-000000000007',
        operationId: successOperation,
        origin: 'BACKFILL_180660',
        actualAmount: 4,
        feedCost: 8,
      });

      const requestedAt = '2026-08-09T12:00:00.000Z';
      const requestedBy = 'db-migrate/rollback-test';
      const rollback = (
        operationId: string,
        proof: { readonly targetSetDigest: string; readonly recordCount: number },
        rollbackOperationId: string,
      ): Promise<unknown> =>
        queryRunner.query(
          `SELECT * FROM rollback_feeding_record_backfill_v1($1,$2,$3,$4,$5,$6,$7)`,
          [
            TENANT,
            operationId,
            proof.targetSetDigest,
            proof.recordCount,
            rollbackOperationId,
            requestedAt,
            requestedBy,
          ],
        );

      await expect(
        rollback(
          'migration/180660/unknown',
          { targetSetDigest: '0'.repeat(64), recordCount: 1 },
          'rollback/unknown',
        ),
      ).rejects.toMatchObject({ code: '55000' });

      const liveProof = await rollbackProofForOperation(queryRunner, liveOperation);
      await expect(rollback(liveOperation, liveProof, 'rollback/live-only')).rejects.toMatchObject({
        code: '55000',
      });
      await expect(
        queryRunner.query(`DELETE FROM feeding_records WHERE id = $1`, [RECORD_LIVE_ONLY]),
      ).rejects.toMatchObject({ code: '55000' });

      const mixedProof = await rollbackProofForOperation(queryRunner, mixedOperation);
      await expect(rollback(mixedOperation, mixedProof, 'rollback/mixed')).rejects.toMatchObject({
        code: '55000',
      });

      const changedProof = await rollbackProofForOperation(queryRunner, changedOperation);
      await queryRunner.query(`UPDATE feeding_records SET "actualAmount" = 2.5 WHERE id = $1`, [
        RECORD_CHANGED_BACKFILL,
      ]);
      await expect(
        rollback(changedOperation, changedProof, 'rollback/changed'),
      ).rejects.toMatchObject({ code: '55000' });

      const successProof = await rollbackProofForOperation(queryRunner, successOperation);
      await expect(
        rollback(
          successOperation,
          { ...successProof, targetSetDigest: 'f'.repeat(64) },
          'rollback/digest-mismatch',
        ),
      ).rejects.toMatchObject({ code: '55000' });

      const first: Array<{
        deleted_count: number;
        target_set_digest: string;
        journal_digest: string;
        replayed: boolean;
      }> = (await rollback(successOperation, successProof, 'rollback/exact-success')) as Array<{
        deleted_count: number;
        target_set_digest: string;
        journal_digest: string;
        replayed: boolean;
      }>;
      expect(first).toEqual([
        {
          deleted_count: 2,
          target_set_digest: successProof.targetSetDigest,
          journal_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
          replayed: false,
        },
      ]);
      const retry = (await rollback(
        successOperation,
        successProof,
        'rollback/exact-success',
      )) as typeof first;
      expect(retry).toEqual([
        {
          deleted_count: 2,
          target_set_digest: successProof.targetSetDigest,
          journal_digest: first[0]?.journal_digest,
          replayed: true,
        },
      ]);

      const evidence: Array<{
        phase: string;
        prevDigest: string;
        eventDigest: string;
      }> = await queryRunner.query(`
        SELECT phase, "prevDigest"::text AS "prevDigest", "eventDigest"::text AS "eventDigest"
          FROM feeding_record_backfill_rollback_journal
         WHERE "rollbackOperationId" = 'rollback/exact-success'
         ORDER BY CASE phase WHEN 'PREPARED' THEN 1 ELSE 2 END
      `);
      expect(evidence).toHaveLength(2);
      expect(evidence[0]).toMatchObject({ phase: 'PREPARED', prevDigest: '0'.repeat(64) });
      expect(evidence[1]).toMatchObject({
        phase: 'APPLIED',
        prevDigest: evidence[0]?.eventDigest,
      });
      expect(
        await queryRunner.query(
          `SELECT COUNT(*)::int AS count FROM feeding_records WHERE id = ANY($1::uuid[])`,
          [[RECORD_SUCCESS_A, RECORD_SUCCESS_B]],
        ),
      ).toEqual([{ count: 0 }]);
      expect(
        await queryRunner.query(
          `SELECT "totalFeedConsumed"::text AS consumed, "totalFeedCost"::text AS cost
             FROM batches_v2 WHERE id = $1`,
          [BATCH_A],
        ),
      ).toEqual([{ consumed: '93.000', cost: '186.000' }]);
      expect(
        await queryRunner.query(
          `SELECT COUNT(*)::int AS count FROM feeding_record_backfill_rollback_journal`,
        ),
      ).toEqual([{ count: 2 }]);
    },
    failures: [],
  },
] as const satisfies readonly FeedingMigrationVectorV1[];

export const FEEDING_MIGRATION_VECTORS_V1 = freezeMigrationVectors(FEEDING_MIGRATION_VECTOR_SOURCE);

describe('feeding migration vector authority — isolated real PostgreSQL', () => {
  let postgres: HarnessContext;

  beforeAll(async () => {
    postgres = await bootPostgresContainer({ startTimeoutMs: 90_000 });
  });

  afterAll(async () => {
    await shutdownHarness(postgres);
  });

  describe.each(FEEDING_MIGRATION_VECTORS_V1)('$id $migration.name', (vector) => {
    const withVectorSchema = <T>(work: (queryRunner: QueryRunner) => Promise<T>): Promise<T> =>
      withEphemeralDatabase(postgres, (_database, isolated) =>
        withEphemeralSchema(isolated, (_schema, queryRunner) => work(queryRunner)),
      );

    it('converges the admitted prior state and proves its postcondition', async () => {
      await withVectorSchema(async (queryRunner) => {
        await vector.arrange(queryRunner);
        await vector.seed(queryRunner);
        const migration = new vector.migration();
        await applyMigrationTransaction(queryRunner, migration);
        if (migration.postCondition) {
          await expect(migration.postCondition(queryRunner)).resolves.toBe(true);
        }
        await vector.verify(queryRunner, migration);

        if (vector.replay) {
          await applyMigrationTransaction(queryRunner, new vector.migration());
          await vector.verify(queryRunner, migration);
        }
      });
    });

    if (vector.failures.length > 0) {
      it.each(vector.failures)(
        'rejects $name and restores the exact prior state',
        async (failure) => {
          await withVectorSchema(async (queryRunner) => {
            await vector.arrange(queryRunner);
            await failure.seed(queryRunner);
            const migrationResult = applyMigrationTransaction(queryRunner, new vector.migration());
            if (failure.sqlState !== undefined) {
              await expect(migrationResult).rejects.toMatchObject({ code: failure.sqlState });
            } else {
              await expect(migrationResult).rejects.toThrow(failure.error);
            }
            await failure.verifyRestored(queryRunner);
          });
        },
      );
    }
  });
});
