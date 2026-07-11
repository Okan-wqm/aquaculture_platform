/**
 * FARM-HIGH-182 — point-in-time standing-stock reconstruction, verified against
 * real Postgres (the finding's blocker #1: "no live DB to verify complex
 * reconstruction SQL"). Runs the EXACT production query (BATCH_RECONSTRUCTION_SQL)
 * + fold against a seeded ledger and asserts the period-end numbers, the
 * anti-double-count (mortality/harvest mirror rows in tank_operations must NOT
 * inflate the removal), the cancelled-harvest exclusion, the as-of-date weight,
 * the CROSS-SITE transfer (counted once at the destination, re-review FARM-HIGH-001),
 * the cleaner-fish exclusion (re-review FARM-HIGH-002), and the fail-closed guards.
 * Runs in CI (needs Docker Postgres); skipped in the sandbox.
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

// Sites / departments / tanks / species / batches.
const S1 = '11111111-1111-4111-8111-111111111111';
const SA = 'a1111111-1111-4111-8111-111111111111';
const SB = 'b1111111-1111-4111-8111-111111111111';
const SC = 'c1111111-1111-4111-8111-111111111111';
const S3 = '33333333-3333-4333-8333-333333333333';
const S4 = '44444444-4444-4444-8444-444444444444';
const S5 = '55555555-5555-4555-8555-555555555555';
const S6 = '66666666-6666-4666-8666-666666666666';

const D1 = 'd1111111-1111-4111-8111-111111111111';
const DA = 'daaaaaaa-1111-4111-8111-111111111111';
const DB = 'dbbbbbbb-1111-4111-8111-111111111111';
const DC = 'dccccccc-1111-4111-8111-111111111111';
const D3 = 'd3333333-3333-4333-8333-333333333333';
const D4 = 'd4444444-4444-4444-8444-444444444444';
const D5 = 'd5555555-5555-4555-8555-555555555555';
const D6 = 'd6666666-6666-4666-8666-666666666666';

const T1 = 'e1111111-1111-4111-8111-111111111111';
const TA = 'eaaaaaaa-1111-4111-8111-111111111111';
const TB = 'ebbbbbbb-1111-4111-8111-111111111111';
const TC = 'eccccccc-1111-4111-8111-111111111111';
const T3 = 'e3333333-3333-4333-8333-333333333333';
const T4 = 'e4444444-4444-4444-8444-444444444444';
const T5 = 'e5555555-5555-4555-8555-555555555555';
const T6 = 'e6666666-6666-4666-8666-666666666666';

const SP = 'f0000000-0000-4000-8000-000000000001';
const B = 'ba000000-0000-4000-8000-00000000000b';
const BT = 'ba000000-0000-4000-8000-0000000000a7';
const BP = 'ba000000-0000-4000-8000-0000000000b8';
const BC = 'ba000000-0000-4000-8000-0000000000c9';
const B4 = 'ba000000-0000-4000-8000-000000000004';
const B5 = 'ba000000-0000-4000-8000-000000000005';
const B6 = 'ba000000-0000-4000-8000-000000000006';
const B7 = 'ba000000-0000-4000-8000-000000000007';

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

    await pg.dataSource.query(`
      CREATE TABLE farm.departments ("id" uuid PRIMARY KEY, "siteId" uuid NOT NULL);
      CREATE TABLE farm.tanks ("id" uuid PRIMARY KEY, "tenantId" uuid NOT NULL, "departmentId" uuid NOT NULL);
      CREATE TABLE farm.species ("id" uuid PRIMARY KEY, "name" text NOT NULL, "code" text NOT NULL, "officialCode" text);
      CREATE TABLE farm.batches_v2 (
        "id" uuid PRIMARY KEY, "tenantId" uuid NOT NULL, "speciesId" uuid NOT NULL,
        "batchType" text NOT NULL DEFAULT 'production',
        "stockedAt" date NOT NULL DEFAULT '2026-01-01',
        "weight" jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE farm.tank_batches (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "tankId" uuid NOT NULL,
        "primaryBatchId" uuid, "batchDetails" jsonb
      );
      CREATE TABLE farm.tank_allocations (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "tankId" uuid NOT NULL,
        "batchId" uuid NOT NULL, "allocationType" text NOT NULL, "allocationDate" date NOT NULL,
        "quantity" int NOT NULL, "isDeleted" boolean DEFAULT false
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
        "averageWeight" numeric NOT NULL, "measurementDate" date NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
      );
    `);

    await pg.dataSource.query(
      `INSERT INTO farm.departments VALUES ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10),($11,$12),($13,$14)`,
      [D1, S1, DA, SA, DB, SB, DC, SC, D3, S3, D4, S4, D5, S5],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.tanks VALUES ($1,$15,$8),($2,$15,$9),($3,$15,$10),($4,$15,$11),($5,$15,$12),($6,$15,$13),($7,$15,$14)`,
      [T1, TA, TB, TC, T3, T4, T5, D1, DA, DB, DC, D3, D4, D5, TENANT],
    );
    await pg.dataSource.query(`INSERT INTO farm.species VALUES ($1,'Atlantic salmon','SAL','SAL')`, [SP]);

    const prodBatch = (id: string, w: number): Promise<unknown> =>
      pg!.dataSource.query(
        `INSERT INTO farm.batches_v2 ("id","tenantId","speciesId","batchType","weight")
         VALUES ($1,$2,$3,'production',$4::jsonb)`,
        [id, TENANT, SP, JSON.stringify({ initial: { avgWeight: w } })],
      );

    // ── Batch B — full lifecycle in SITE1/T1 ─────────────────────────────
    await prodBatch(B, 50);
    await pg.dataSource.query(
      `INSERT INTO farm.tank_allocations ("tenantId","tankId","batchId","allocationType","allocationDate","quantity")
       VALUES ($1,$2,$3,'initial_stocking','2026-01-05',10000)`,
      [TENANT, T1, B],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.growth_measurements ("tenantId","batchId","averageWeight","measurementDate")
       VALUES ($1,$2,300,'2026-02-10'),($1,$2,450,'2026-04-10')`,
      [TENANT, B],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.mortality_records ("tenantId","batchId","tankId","count","recordDate")
       VALUES ($1,$2,$3,500,'2026-02-15'),($1,$2,$3,300,'2026-05-20')`,
      [TENANT, B, T1],
    );
    // mortality mirror in tank_operations — must be ignored (no double-count).
    await pg.dataSource.query(
      `INSERT INTO farm.tank_operations ("tenantId","tankId","batchId","operationType","operationDate","quantity")
       VALUES ($1,$2,$3,'mortality','2026-02-15',500),($1,$2,$3,'mortality','2026-05-20',300),
              ($1,$2,$3,'cull','2026-03-01',200),
              ($1,$2,$3,'harvest','2026-04-25',2000),($1,$2,$3,'harvest','2026-05-10',1000)`,
      [TENANT, T1, B],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.harvest_records ("tenantId","batchId","tankId","quantityHarvested","harvestDate","status")
       VALUES ($1,$2,$3,2000,'2026-04-25','completed'),($1,$2,$3,1000,'2026-05-10','cancelled')`,
      [TENANT, B, T1],
    );

    // ── Batch BT — cross-site transfer SA/TA → SB/TB on Mar 15 ────────────
    await prodBatch(BT, 200);
    await pg.dataSource.query(
      `INSERT INTO farm.tank_allocations ("tenantId","tankId","batchId","allocationType","allocationDate","quantity")
       VALUES ($1,$2,$3,'initial_stocking','2026-01-10',5000),
              ($1,$2,$3,'transfer_out','2026-03-15',-5000),
              ($1,$4,$3,'transfer_in','2026-03-15',5000)`,
      [TENANT, TA, BT, TB],
    );

    // ── SITE_C — production BP + cleaner-fish BC (BC must be excluded) ────
    await prodBatch(BP, 100);
    await pg.dataSource.query(
      `INSERT INTO farm.tank_allocations ("tenantId","tankId","batchId","allocationType","allocationDate","quantity")
       VALUES ($1,$2,$3,'initial_stocking','2026-01-08',3000)`,
      [TENANT, TC, BP],
    );
    // BC is a cleaner-fish batch; even given a production-shaped allocation + mortality
    // it must be excluded by the batchType='production' filter.
    await pg.dataSource.query(
      `INSERT INTO farm.batches_v2 ("id","tenantId","speciesId","batchType","weight")
       VALUES ($1,$2,$3,'cleaner_fish','{"initial":{"avgWeight":30}}'::jsonb)`,
      [BC, TENANT, SP],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.tank_allocations ("tenantId","tankId","batchId","allocationType","allocationDate","quantity")
       VALUES ($1,$2,$3,'initial_stocking','2026-01-08',900)`,
      [TENANT, TC, BC],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.mortality_records ("tenantId","batchId","tankId","count","recordDate")
       VALUES ($1,$2,$3,50,'2026-02-01')`,
      [TENANT, BC, TC],
    );

    // ── Fail-closed fixtures ─────────────────────────────────────────────
    // S3: removals exceed inflow → negative.
    await prodBatch(B4, 100);
    await pg.dataSource.query(
      `INSERT INTO farm.tank_allocations ("tenantId","tankId","batchId","allocationType","allocationDate","quantity")
       VALUES ($1,$2,$3,'initial_stocking','2026-01-02',1000)`,
      [TENANT, T3, B4],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.mortality_records ("tenantId","batchId","tankId","count","recordDate")
       VALUES ($1,$2,$3,900,'2026-02-05')`,
      [TENANT, B4, T3],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.harvest_records ("tenantId","batchId","tankId","quantityHarvested","harvestDate","status")
       VALUES ($1,$2,$3,500,'2026-02-06','completed')`,
      [TENANT, B4, T3],
    );
    // S4: batch has a removal on a site tank but NO stocking allocation (pre-fix gap).
    await prodBatch(B5, 100);
    await pg.dataSource.query(
      `INSERT INTO farm.mortality_records ("tenantId","batchId","tankId","count","recordDate")
       VALUES ($1,$2,$3,100,'2026-02-03')`,
      [TENANT, B5, T4],
    );
    // S5: an un-attributable harvest (NULL tankId) on a resident batch.
    await prodBatch(B6, 100);
    await pg.dataSource.query(
      `INSERT INTO farm.tank_allocations ("tenantId","tankId","batchId","allocationType","allocationDate","quantity")
       VALUES ($1,$2,$3,'initial_stocking','2026-01-01',2000)`,
      [TENANT, T5, B6],
    );
    await pg.dataSource.query(
      `INSERT INTO farm.harvest_records ("tenantId","batchId","tankId","quantityHarvested","harvestDate","status")
       VALUES ($1,$2,NULL,500,'2026-02-10','completed')`,
      [TENANT, B6],
    );

    // S6 (FARM-MEDIUM-210): a production batch currently resident in a site tank
    // (tank_batches), stocked before T, but with NO tank_allocations at all
    // (pre-FARM-HIGH-112 stocking) and no removals — the silent-omission case.
    await pg.dataSource.query(`INSERT INTO farm.departments VALUES ($1,$2)`, [D6, S6]);
    await pg.dataSource.query(`INSERT INTO farm.tanks VALUES ($1,$2,$3)`, [T6, TENANT, D6]);
    await prodBatch(B7, 100);
    await pg.dataSource.query(
      `INSERT INTO farm.tank_batches ("tenantId","tankId","primaryBatchId") VALUES ($1,$2,$3)`,
      [TENANT, T6, B7],
    );
  });

  afterAll(async () => {
    await shutdownHarness(pg);
  });

  it('is empty (complete) for a period before any allocation into the site', async () => {
    const r = await reconstruct(S1, '2026-01-01');
    expect(r.complete).toBe(true);
    expect(r.totalQuantity).toBe(0);
  });

  it('reconstructs Feb month-end WITHOUT double-counting the tank_operations mortality mirror', async () => {
    const r = await reconstruct(S1, '2026-02-28');
    expect(r.complete).toBe(true);
    expect(r.totalQuantity).toBe(9500); // 10000 − 500 (mirror not added)
    expect(r.totalBiomassKg).toBe(2850); // 9500 × 300 / 1000
    expect(r.speciesBreakdown[0]?.avgWeightG).toBe(300);
  });

  it('reconstructs Apr month-end with cull + active harvest at the as-of weight', async () => {
    const r = await reconstruct(S1, '2026-04-30');
    expect(r.totalQuantity).toBe(7300); // 10000 − 500 − 200 − 2000
    expect(r.totalBiomassKg).toBe(3285); // 7300 × 450 / 1000
  });

  it('EXCLUDES a cancelled harvest at May month-end (no double removal)', async () => {
    const r = await reconstruct(S1, '2026-05-31');
    expect(r.totalQuantity).toBe(7000); // 10000 − 800 − 200 − 2000 (1000 cancelled NOT removed)
  });

  it('counts a cross-site-transferred batch ONCE at its destination, zero at the origin', async () => {
    // Before the Mar 15 transfer the fish are at site A.
    const before = await reconstruct(SA, '2026-02-28');
    expect(before.totalQuantity).toBe(5000);
    // After the transfer: gone from A (nets to 0), present at B — counted once.
    const originAfter = await reconstruct(SA, '2026-04-30');
    expect(originAfter.complete).toBe(true);
    expect(originAfter.totalQuantity).toBe(0);
    const destAfter = await reconstruct(SB, '2026-04-30');
    expect(destAfter.complete).toBe(true);
    expect(destAfter.totalQuantity).toBe(5000);
    expect(destAfter.totalBiomassKg).toBe(1000); // 5000 × 200 / 1000
  });

  it('EXCLUDES cleaner-fish batches from the production beholdning', async () => {
    const r = await reconstruct(SC, '2026-02-28');
    expect(r.complete).toBe(true);
    // Only the production batch BP (3000); the cleaner batch BC is filtered out.
    expect(r.totalQuantity).toBe(3000);
  });

  it('FAILS CLOSED when the ledger drives a tank/batch negative', async () => {
    const r = await reconstruct(S3, '2026-02-28');
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toMatch(/negative quantity/);
  });

  it('FAILS CLOSED when a resident batch has no stocking allocation (pre-fix gap)', async () => {
    const r = await reconstruct(S4, '2026-02-28');
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toMatch(/no stocking\/transfer-in allocation/);
  });

  it('FAILS CLOSED on an un-attributable (NULL-tank) harvest', async () => {
    const r = await reconstruct(S5, '2026-02-28');
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toMatch(/no tank/);
  });

  it('FAILS CLOSED (not a silent 0 kg) for a resident production batch with no allocation ledger (FARM-MEDIUM-210)', async () => {
    const r = await reconstruct(S6, '2026-02-28');
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toMatch(/no stocking\/transfer-in allocation/);
  });
});
