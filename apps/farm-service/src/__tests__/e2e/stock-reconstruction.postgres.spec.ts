/**
 * FARM-HIGH-182 — point-in-time standing-stock reconstruction, verified against
 * real Postgres (the finding's blocker #1: "no live DB to verify complex
 * reconstruction SQL"). This runs the EXACT production query
 * (BATCH_RECONSTRUCTION_SQL) + fold against a seeded ledger and asserts the
 * period-end numbers, the anti-double-count (mortality/harvest mirror rows in
 * tank_operations must NOT inflate the removal), the cancelled-harvest exclusion,
 * the as-of-date weight selection, and closed-batch membership. Runs in CI (needs
 * Docker Postgres); skipped in the sandbox.
 *
 * The tables are MINIMAL stand-ins (only the columns the query reads) so the test
 * needs no enums / RLS / full migrations — the query joins them by name exactly
 * as it does in production.
 */
import 'reflect-metadata';

import { bootPostgresContainer, HarnessContext, shutdownHarness } from '@platform/migration-harness';

import {
  BATCH_RECONSTRUCTION_SQL,
  StockReconstructionService,
} from '../../batch/services/stock-reconstruction.service';

jest.setTimeout(120_000);

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('StockReconstructionService period-end replay (FARM-HIGH-182)', () => {
  let pg: HarnessContext | undefined;

  async function reconstruct(
    siteId: string,
    periodEnd: string,
  ): Promise<ReturnType<typeof StockReconstructionService.fold>> {
    const rows = await pg!.dataSource.query(BATCH_RECONSTRUCTION_SQL, [TENANT, siteId, periodEnd]);
    return StockReconstructionService.fold(rows);
  }

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await pg.dataSource.query('CREATE SCHEMA farm');
    await pg.dataSource.query('SET search_path TO farm, public');

    // Minimal stand-in tables (only the columns BATCH_RECONSTRUCTION_SQL reads).
    await pg.dataSource.query(`
      CREATE TABLE farm.departments ("id" uuid PRIMARY KEY, "siteId" uuid NOT NULL);
      CREATE TABLE farm.tanks ("id" uuid PRIMARY KEY, "tenantId" uuid NOT NULL, "departmentId" uuid NOT NULL);
      CREATE TABLE farm.species ("id" uuid PRIMARY KEY, "name" text NOT NULL, "code" text NOT NULL, "officialCode" text);
      CREATE TABLE farm.batches_v2 (
        "id" uuid PRIMARY KEY, "tenantId" uuid NOT NULL, "speciesId" uuid NOT NULL,
        "initialQuantity" int, "stockedAt" date NOT NULL, "weight" jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE farm.tank_batches (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "tankId" uuid NOT NULL,
        "primaryBatchId" uuid, "batchDetails" jsonb
      );
      CREATE TABLE farm.tank_allocations (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "tankId" uuid NOT NULL,
        "batchId" uuid NOT NULL, "allocationType" text NOT NULL, "allocationDate" date NOT NULL
      );
      CREATE TABLE farm.tank_operations (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "tankId" uuid NOT NULL,
        "batchId" uuid NOT NULL, "operationType" text NOT NULL, "operationDate" date NOT NULL,
        "quantity" int NOT NULL, "isDeleted" boolean DEFAULT false
      );
      CREATE TABLE farm.mortality_records (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "batchId" uuid NOT NULL,
        "tankId" uuid, "count" int NOT NULL, "recordDate" date NOT NULL
      );
      CREATE TABLE farm.harvest_records (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "batchId" uuid NOT NULL,
        "tankId" uuid, "quantityHarvested" int NOT NULL, "harvestDate" date NOT NULL, "status" text NOT NULL DEFAULT 'completed'
      );
      CREATE TABLE farm.growth_measurements (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "batchId" uuid NOT NULL,
        "averageWeight" numeric NOT NULL, "measurementDate" date NOT NULL
      );
    `);

    const SITE1 = '11111111-1111-4111-8111-111111111111';
    const SITE2 = '22222222-2222-4222-8222-222222222222';
    const SITE3 = '33333333-3333-4333-8333-333333333333';
    const DEP1 = 'd1111111-1111-4111-8111-111111111111';
    const DEP2 = 'd2222222-2222-4222-8222-222222222222';
    const DEP3 = 'd3333333-3333-4333-8333-333333333333';
    const TK1 = 'c1111111-1111-4111-8111-111111111111';
    const TK2 = 'c2222222-2222-4222-8222-222222222222';
    const TK3 = 'c3333333-3333-4333-8333-333333333333';
    const SP = 'e0000000-0000-4000-8000-000000000001';
    const B = 'ba000000-0000-4000-8000-00000000000b';
    const B3 = 'ba000000-0000-4000-8000-000000000003';
    const B4 = 'ba000000-0000-4000-8000-000000000004';

    await pg.dataSource.query(`INSERT INTO farm.departments VALUES ($1,$2),($3,$4),($5,$6)`, [
      DEP1, SITE1, DEP2, SITE2, DEP3, SITE3,
    ]);
    await pg.dataSource.query(
      `INSERT INTO farm.tanks VALUES ($1,$7,$4),($2,$7,$5),($3,$7,$6)`,
      [TK1, TK2, TK3, DEP1, DEP2, DEP3, TENANT],
    );
    await pg.dataSource.query(`INSERT INTO farm.species VALUES ($1,'Atlantic salmon','SAL','SAL')`, [SP]);

    // Batch B — full lifecycle in SITE1 via tank_batches membership.
    await pg.dataSource.query(
      `INSERT INTO farm.batches_v2 VALUES ($1,$2,$3,10000,'2026-01-05','{"initial":{"avgWeight":50}}'::jsonb)`,
      [B, TENANT, SP],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.tank_batches ("tenantId","tankId","primaryBatchId") VALUES ($1,$2,$3)`,
      [TENANT, TK1, B],
    );
    // Two measurements: 300g @ Feb 10, 450g @ Apr 10.
    await pg.dataSource.query(
      `INSERT INTO farm.growth_measurements ("tenantId","batchId","averageWeight","measurementDate")
       VALUES ($1,$2,300,'2026-02-10'),($1,$2,450,'2026-04-10')`,
      [TENANT, B],
    );
    // Mortality 500 @ Feb 15, 300 @ May 20 — in mortality_records (SSoT) AND mirrored in tank_operations.
    await pg.dataSource.query(
      `INSERT INTO farm.mortality_records ("tenantId","batchId","tankId","count","recordDate")
       VALUES ($1,$2,$3,500,'2026-02-15'),($1,$2,$3,300,'2026-05-20')`,
      [TENANT, B, TK1],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.tank_operations ("tenantId","tankId","batchId","operationType","operationDate","quantity")
       VALUES ($1,$2,$3,'mortality','2026-02-15',500),($1,$2,$3,'mortality','2026-05-20',300)`,
      [TENANT, TK1, B],
    );
    // Cull 200 @ Mar 1 — ONLY in tank_operations.
    await pg.dataSource.query(
      `INSERT INTO farm.tank_operations ("tenantId","tankId","batchId","operationType","operationDate","quantity")
       VALUES ($1,$2,$3,'cull','2026-03-01',200)`,
      [TENANT, TK1, B],
    );
    // Harvest 2000 @ Apr 25 (active) + 1000 @ May 10 (CANCELLED) — in harvest_records AND mirrored in tank_operations.
    await pg.dataSource.query(
      `INSERT INTO farm.harvest_records ("tenantId","batchId","tankId","quantityHarvested","harvestDate","status")
       VALUES ($1,$2,$3,2000,'2026-04-25','completed'),($1,$2,$3,1000,'2026-05-10','cancelled')`,
      [TENANT, B, TK1],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.tank_operations ("tenantId","tankId","batchId","operationType","operationDate","quantity")
       VALUES ($1,$2,$3,'harvest','2026-04-25',2000),($1,$2,$3,'harvest','2026-05-10',1000)`,
      [TENANT, TK1, B],
    );

    // Batch B3 — SITE2, NO tank_batch row; membership only via a tank_operation on the site tank (closed-batch case).
    await pg.dataSource.query(
      `INSERT INTO farm.batches_v2 VALUES ($1,$2,$3,4000,'2026-01-03','{"initial":{"avgWeight":100}}'::jsonb)`,
      [B3, TENANT, SP],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.tank_operations ("tenantId","tankId","batchId","operationType","operationDate","quantity")
       VALUES ($1,$2,$3,'mortality','2026-02-01',1000)`,
      [TENANT, TK2, B3],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.mortality_records ("tenantId","batchId","tankId","count","recordDate")
       VALUES ($1,$2,$3,1000,'2026-02-01')`,
      [TENANT, B3, TK2],
    );

    // Batch B4 — SITE3, removals exceed initial by the period end (a ledger gap) → fail closed.
    await pg.dataSource.query(
      `INSERT INTO farm.batches_v2 VALUES ($1,$2,$3,1000,'2026-01-02','{"initial":{"avgWeight":100}}'::jsonb)`,
      [B4, TENANT, SP],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.tank_batches ("tenantId","tankId","primaryBatchId") VALUES ($1,$2,$3)`,
      [TENANT, TK3, B4],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.mortality_records ("tenantId","batchId","tankId","count","recordDate")
       VALUES ($1,$2,$3,900,'2026-02-05')`,
      [TENANT, B4, TK3],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.harvest_records ("tenantId","batchId","tankId","quantityHarvested","harvestDate","status")
       VALUES ($1,$2,$3,500,'2026-02-06','completed')`,
      [TENANT, B4, TK3],
    );
  });

  afterAll(async () => {
    await shutdownHarness(pg);
  });

  const SITE1 = '11111111-1111-4111-8111-111111111111';
  const SITE2 = '22222222-2222-4222-8222-222222222222';
  const SITE3 = '33333333-3333-4333-8333-333333333333';

  it('is empty (complete) for a period before the batch was stocked', async () => {
    const r = await reconstruct(SITE1, '2026-01-01');
    expect(r.complete).toBe(true);
    expect(r.totalQuantity).toBe(0);
  });

  it('reconstructs Feb month-end WITHOUT double-counting the tank_operations mortality mirror', async () => {
    const r = await reconstruct(SITE1, '2026-02-28');
    expect(r.complete).toBe(true);
    // 10000 − mortality 500 = 9500 (the mirrored tank_operations('mortality') row is NOT added).
    expect(r.totalQuantity).toBe(9500);
    // Latest measurement ≤ Feb 28 is 300 g → 9500 × 300 / 1000 = 2850 kg.
    expect(r.totalBiomassKg).toBe(2850);
    expect(r.speciesBreakdown[0]?.avgWeightG).toBe(300);
  });

  it('reconstructs Apr month-end with cull + active harvest at the as-of weight', async () => {
    const r = await reconstruct(SITE1, '2026-04-30');
    // 10000 − 500 (mort) − 200 (cull) − 2000 (harvest) = 7300.
    expect(r.totalQuantity).toBe(7300);
    // Latest measurement ≤ Apr 30 is 450 g → 7300 × 450 / 1000 = 3285 kg.
    expect(r.totalBiomassKg).toBe(3285);
  });

  it('EXCLUDES a cancelled harvest at May month-end (no double removal)', async () => {
    const r = await reconstruct(SITE1, '2026-05-31');
    // 10000 − (500+300 mort) − 200 cull − 2000 harvest = 7000.
    // The 1000 CANCELLED harvest is NOT removed (else it would be 6000).
    expect(r.totalQuantity).toBe(7000);
  });

  it('counts a batch whose only site link is a historical tank_operation (closed-batch membership)', async () => {
    const r = await reconstruct(SITE2, '2026-02-28');
    expect(r.complete).toBe(true);
    // 4000 − 1000 mortality = 3000 (membership resolved via the operations branch,
    // not tank_batches). The mortality mirror is again not double-counted.
    expect(r.totalQuantity).toBe(3000);
  });

  it('FAILS CLOSED for a site whose ledger drives a batch negative', async () => {
    const r = await reconstruct(SITE3, '2026-02-28');
    // 1000 − 900 mort − 500 harvest = −400 → incomplete, never a fabricated number.
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toMatch(/negative quantity/);
  });
});
