/**
 * Ünite → yemleyici atamasının VERİTABANI garantilerinin kanıtı.
 *
 * WHY this suite exists at all and why it uses raw SQL: the operator asked for a
 * database-level guarantee, not a service-layer check. A test that drives the
 * handler proves only that the handler behaves; it says nothing about a
 * data-fix script, a future service, or a psql session. Every write below goes
 * straight at the tables with `dataSource.query(...)`, bypassing NestJS,
 * TypeORM entities and the command handler entirely. If the guarantee lived in
 * the service layer, every one of these tests would pass while the invariant was
 * wide open.
 *
 * What is proved here:
 *   - a unit's active shares must sum to exactly 100, or the transaction dies;
 *   - a unit may carry SEVERAL feeders, and the transient state during a
 *     multi-row edit is legal only inside one transaction;
 *   - replacing a feeder preserves the replaced row (ENDED, share frozen);
 *   - a unit may have no feeder at all (hand-fed);
 *   - the feeder column only accepts an Equipment id — the same object
 *     `feeder_calibrations` calibrates. A sub-equipment id is unstorable.
 */
import 'reflect-metadata';

import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';

import { CreateFeederAssignments1808900000000 } from '../../database/migrations/1808900000000-CreateFeederAssignments';
import { BindExecutionFeederToEquipment1809000000000 } from '../../database/migrations/1809000000000-BindExecutionFeederToEquipment';

jest.setTimeout(180_000);

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT = '22222222-2222-4222-8222-222222222222';
const FEEDER_A = '33333333-3333-4333-8333-333333333333';
const FEEDER_B = '44444444-4444-4444-8444-444444444444';
const SUB_EQUIPMENT = '55555555-5555-4555-8555-555555555555';
const FEED = '66666666-6666-4666-8666-666666666666';

describe('feeder assignment share-sum guarantee (real Postgres, service layer bypassed)', () => {
  let pg: HarnessContext | undefined;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    await pg.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await pg.dataSource.query('CREATE SCHEMA farm');

    // Minimal stand-ins for the tables the migrations reference. Only the
    // columns the DDL and the trigger touch are needed — the trigger attaches by
    // name and fires exactly as it does in production.
    await pg.dataSource.query(`
      CREATE TABLE farm.equipment (
        "id" uuid PRIMARY KEY,
        "code" text NOT NULL
      )
    `);
    await pg.dataSource.query(`
      CREATE TABLE farm.sub_equipment (
        "id" uuid PRIMARY KEY,
        "name" text NOT NULL
      )
    `);
    await pg.dataSource.query(`
      CREATE TABLE farm.feeder_calibrations (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "equipment_id" uuid NOT NULL REFERENCES farm.equipment ("id"),
        "feed_id" uuid NOT NULL,
        "dosing_mode" character varying(20) NOT NULL,
        "grams_per_dispensing" numeric(8,2)
      )
    `);
    await pg.dataSource.query(`
      CREATE TABLE farm.daily_feeding_executions (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "equipmentId" uuid NOT NULL,
        "feederEquipmentId" uuid,
        "feederName" text
      )
    `);

    await pg.dataSource.query(`INSERT INTO farm.equipment ("id", "code") VALUES ($1, 'FEED-A')`, [
      FEEDER_A,
    ]);
    await pg.dataSource.query(`INSERT INTO farm.equipment ("id", "code") VALUES ($1, 'FEED-B')`, [
      FEEDER_B,
    ]);
    await pg.dataSource.query(`INSERT INTO farm.equipment ("id", "code") VALUES ($1, 'TANK-01')`, [
      UNIT,
    ]);
    await pg.dataSource.query(
      `INSERT INTO farm.sub_equipment ("id", "name") VALUES ($1, 'Hopper')`,
      [SUB_EQUIPMENT],
    );

    // Install the migrations the way the runner does: current_schema-relative,
    // with search_path pinned to farm on THIS connection.
    const qr = pg.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query('SET search_path TO farm, public');
      await new CreateFeederAssignments1808900000000().up(qr);
      await new BindExecutionFeederToEquipment1809000000000().up(qr);
      // Reset before releasing this connection back to the pool: every write
      // below then runs with the DEFAULT search_path and reaches the tables
      // schema-qualified. That is deliberate — it proves the trigger resolves
      // its own tables and helper regardless of the caller's search_path, which
      // is exactly what a raw psql session or a data-fix script looks like.
      await qr.query(`RESET search_path`);
    } finally {
      await qr.release();
    }
  });

  afterAll(async () => {
    await shutdownHarness(pg);
  });

  beforeEach(async () => {
    // Rows are ended, never deleted, in production. Between tests we do delete,
    // so each case starts from a clean unit. The trigger settles the total to 0.
    await pg!.dataSource.query('DELETE FROM farm.feeder_assignments');
    await pg!.dataSource.query('DELETE FROM farm.daily_feeding_executions');
  });

  /** Raw insert — no service layer, no entity, no handler. */
  function insertAssignmentSql(alias = 'r'): string {
    return `
      INSERT INTO farm.feeder_assignments
        ("tenantId", "unitId", "unitType", "unitName", "unitCode", "siteId",
         "feederEquipmentId", "feederName", "feederCode", "doseSharePercent",
         "status", "effectiveFrom", "version")
      VALUES ($1, $2, 'tank', 'Tank 01', 'TANK-01',
              '99999999-9999-4999-8999-999999999999',
              $3, $4, $4, $5, COALESCE($6, 'active')::farm.feeder_assignments_status_enum,
              CURRENT_DATE, 1)
      RETURNING "id" AS ${alias}`;
  }

  async function insertAssignment(
    feederEquipmentId: string,
    sharePercent: number,
    status: 'active' | 'ended' = 'active',
  ): Promise<string> {
    const rows: Array<{ r: string }> = await pg!.dataSource.query(insertAssignmentSql(), [
      TENANT,
      UNIT,
      feederEquipmentId,
      feederEquipmentId === FEEDER_A ? 'FEED-A' : 'FEED-B',
      sharePercent,
      status,
    ]);
    return rows[0]!.r;
  }

  async function unitTotal(): Promise<number | null> {
    const rows: Array<{ total: string }> = await pg!.dataSource.query(
      `SELECT "activeSharePercentTotal" AS total
         FROM farm.feeder_assignment_unit_totals
        WHERE "tenantId" = $1 AND "unitId" = $2`,
      [TENANT, UNIT],
    );
    return rows.length === 0 ? null : Number(rows[0]!.total);
  }

  it('accepts a single feeder that covers the whole daily dose', async () => {
    await expect(insertAssignment(FEEDER_A, 100)).resolves.toEqual(expect.any(String));
    expect(await unitTotal()).toBe(100);
  });

  it('REJECTS a single feeder at 90% — a silently underfed unit cannot commit', async () => {
    await expect(insertAssignment(FEEDER_A, 90)).rejects.toThrow(
      /sum(ming)? to|check constraint|CK_fault_total_is_zero_or_full/i,
    );

    // Nothing was committed: no active row, and the derived total never claims a
    // partial share (the anchor row may exist at 0 from an earlier lifecycle —
    // it is deliberately never deleted, because it is the serialization anchor).
    const rows: Array<{ count: string }> = await pg!.dataSource.query(
      `SELECT COUNT(*) AS count FROM farm.feeder_assignments
        WHERE "tenantId" = $1 AND "unitId" = $2`,
      [TENANT, UNIT],
    );
    expect(Number(rows[0]!.count)).toBe(0);
    expect(await unitTotal()).not.toBe(90);
    expect([null, 0]).toContain(await unitTotal());
  });

  it('REJECTS an over-fed unit at 110%', async () => {
    await expect(insertAssignment(FEEDER_A, 110)).rejects.toThrow(
      /sum(ming)? to|check constraint/i,
    );
  });

  it('carries two feeders on one unit when their shares split the dose', async () => {
    const qr = pg!.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      // The intermediate state after the first row is 60% — not 100. It is legal
      // ONLY because the constraint trigger fires at COMMIT; an immediate check
      // would make a two-feeder unit unreachable.
      await qr.query(insertAssignmentSql(), [TENANT, UNIT, FEEDER_A, 'FEED-A', 60, 'active']);
      await qr.query(insertAssignmentSql(), [TENANT, UNIT, FEEDER_B, 'FEED-B', 40, 'active']);
      await qr.commitTransaction();
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }

    const rows: Array<{ feederEquipmentId: string; doseSharePercent: string }> =
      await pg!.dataSource.query(
        `SELECT "feederEquipmentId", "doseSharePercent"
           FROM farm.feeder_assignments
          WHERE "tenantId" = $1 AND "unitId" = $2 AND "status" = 'active'
          ORDER BY "doseSharePercent" DESC`,
        [TENANT, UNIT],
      );
    expect(rows.map((row) => Number(row.doseSharePercent))).toEqual([60, 40]);
    expect(await unitTotal()).toBe(100);
  });

  it('REJECTS a second feeder added without redistributing (100 + 40)', async () => {
    await insertAssignment(FEEDER_A, 100);

    await expect(insertAssignment(FEEDER_B, 40)).rejects.toThrow(/sum(ming)? to|check constraint/i);

    // The committed state is untouched: the unit still has exactly one feeder.
    const rows: Array<{ count: string }> = await pg!.dataSource.query(
      `SELECT COUNT(*) AS count FROM farm.feeder_assignments
        WHERE "tenantId" = $1 AND "unitId" = $2 AND "status" = 'active'`,
      [TENANT, UNIT],
    );
    expect(Number(rows[0]!.count)).toBe(1);
    expect(await unitTotal()).toBe(100);
  });

  it('REJECTS an autocommit multi-row edit — feeder-set changes must be transactional', async () => {
    await insertAssignment(FEEDER_A, 100);

    // Outside a transaction each statement IS its own transaction, so the
    // commit-time check fires at the end of the first one. This is deliberate: a
    // half-applied redistribution must never reach the database.
    await expect(
      pg!.dataSource.query(
        `UPDATE farm.feeder_assignments SET "doseSharePercent" = 60
          WHERE "tenantId" = $1 AND "unitId" = $2 AND "status" = 'active'`,
        [TENANT, UNIT],
      ),
    ).rejects.toThrow(/sum(ming)? to|check constraint/i);
  });

  it('preserves the replaced row when a feeder is swapped', async () => {
    const oldId = await insertAssignment(FEEDER_A, 100);

    const qr = pg!.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(
        `UPDATE farm.feeder_assignments
            SET "status" = 'ended', "endedAt" = now()
          WHERE "id" = $1`,
        [oldId],
      );
      await qr.query(insertAssignmentSql(), [TENANT, UNIT, FEEDER_B, 'FEED-B', 100, 'active']);
      await qr.commitTransaction();
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
    }

    const history: Array<{
      id: string;
      status: string;
      doseSharePercent: string;
      endedAt: Date | null;
    }> = await pg!.dataSource.query(
      `SELECT "id", "status", "doseSharePercent", "endedAt"
         FROM farm.feeder_assignments
        WHERE "tenantId" = $1 AND "unitId" = $2
        ORDER BY "status" ASC`,
      [TENANT, UNIT],
    );

    expect(history).toHaveLength(2);
    const ended = history.find((row) => row.id === oldId);
    expect(ended?.status).toBe('ended');
    expect(ended?.endedAt).not.toBeNull();
    // The share the replaced feeder held is frozen, so a feeding record written
    // while it was active stays interpretable.
    expect(Number(ended?.doseSharePercent)).toBe(100);
    expect(await unitTotal()).toBe(100);
  });

  it('allows a unit with no active feeder at all (hand-fed)', async () => {
    const id = await insertAssignment(FEEDER_A, 100);

    await expect(
      pg!.dataSource.query(
        `UPDATE farm.feeder_assignments SET "status" = 'ended', "endedAt" = now() WHERE "id" = $1`,
        [id],
      ),
    ).resolves.toBeDefined();
    expect(await unitTotal()).toBe(0);
  });

  it('REJECTS an ended row that keeps claiming a live share (lifecycle CHECK)', async () => {
    await expect(insertAssignment(FEEDER_A, 100, 'ended')).rejects.toThrow(
      /CK_fa_ended_at_matches_status|check constraint/i,
    );
  });

  it('REJECTS a concurrent second writer that opened before the first committed', async () => {
    // Both transactions individually look valid: each adds one feeder at 100%.
    // Without the shared anchor row each would compute its own total from its own
    // snapshot and both would commit, leaving the unit at 200%. The anchor forces
    // the second transaction's trigger to re-read AFTER the first has committed.
    const first = pg!.dataSource.createQueryRunner();
    const second = pg!.dataSource.createQueryRunner();
    await first.connect();
    await second.connect();
    try {
      await first.startTransaction();
      await second.startTransaction();

      await first.query(insertAssignmentSql(), [TENANT, UNIT, FEEDER_A, 'FEED-A', 100, 'active']);
      // `second` opened before `first` committed and cannot see its row.
      await second.query(insertAssignmentSql(), [TENANT, UNIT, FEEDER_B, 'FEED-B', 100, 'active']);

      await first.commitTransaction();
      await expect(second.commitTransaction()).rejects.toThrow(
        /sum(ming)? to|check constraint|serialize/i,
      );
    } finally {
      if (second.isTransactionActive) await second.rollbackTransaction();
      await first.release();
      await second.release();
    }

    const rows: Array<{ feederEquipmentId: string }> = await pg!.dataSource.query(
      `SELECT "feederEquipmentId" FROM farm.feeder_assignments
        WHERE "tenantId" = $1 AND "unitId" = $2 AND "status" = 'active'`,
      [TENANT, UNIT],
    );
    expect(rows.map((row) => row.feederEquipmentId)).toEqual([FEEDER_A]);
    expect(await unitTotal()).toBe(100);
  });

  it('REJECTS deleting one of two feeders without redistributing', async () => {
    const qr = pg!.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    await qr.query(insertAssignmentSql(), [TENANT, UNIT, FEEDER_A, 'FEED-A', 60, 'active']);
    await qr.query(insertAssignmentSql(), [TENANT, UNIT, FEEDER_B, 'FEED-B', 40, 'active']);
    await qr.commitTransaction();
    await qr.release();

    await expect(
      pg!.dataSource.query(
        `DELETE FROM farm.feeder_assignments
          WHERE "tenantId" = $1 AND "unitId" = $2 AND "feederEquipmentId" = $3`,
        [TENANT, UNIT, FEEDER_B],
      ),
    ).rejects.toThrow(/sum(ming)? to|check constraint/i);
  });
});

describe('feeder identity: calibration and feeding records name the same object', () => {
  let pg: HarnessContext | undefined;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    await pg.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await pg.dataSource.query('CREATE SCHEMA farm');
    await pg.dataSource.query(`
      CREATE TABLE farm.equipment ("id" uuid PRIMARY KEY, "code" text NOT NULL)
    `);
    await pg.dataSource.query(`
      CREATE TABLE farm.sub_equipment ("id" uuid PRIMARY KEY, "name" text NOT NULL)
    `);
    await pg.dataSource.query(`
      CREATE TABLE farm.feeder_calibrations (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "equipment_id" uuid NOT NULL REFERENCES farm.equipment ("id"),
        "feed_id" uuid NOT NULL,
        "dosing_mode" character varying(20) NOT NULL,
        "grams_per_dispensing" numeric(8,2)
      )
    `);
    await pg.dataSource.query(`
      CREATE TABLE farm.daily_feeding_executions (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "equipmentId" uuid NOT NULL,
        "feederEquipmentId" uuid,
        "feederName" text
      )
    `);
    await pg.dataSource.query(`INSERT INTO farm.equipment ("id", "code") VALUES ($1, 'FEED-A')`, [
      FEEDER_A,
    ]);
    await pg.dataSource.query(
      `INSERT INTO farm.sub_equipment ("id", "name") VALUES ($1, 'Hopper')`,
      [SUB_EQUIPMENT],
    );

    const qr = pg.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query('SET search_path TO farm, public');
      await new BindExecutionFeederToEquipment1809000000000().up(qr);
    } finally {
      await qr.release();
    }
  });

  afterAll(async () => {
    await shutdownHarness(pg);
  });

  it('lets a feeding record name the very equipment row that carries the calibration', async () => {
    await pg!.dataSource.query(
      `INSERT INTO farm.feeder_calibrations ("tenant_id", "equipment_id", "feed_id", "dosing_mode", "grams_per_dispensing")
       VALUES ($1, $2, $3, 'discrete', 120)`,
      [TENANT, FEEDER_A, FEED],
    );

    await expect(
      pg!.dataSource.query(
        `INSERT INTO farm.daily_feeding_executions ("tenantId", "equipmentId", "feederEquipmentId", "feederName")
         VALUES ($1, $2, $3, 'FEED-A')`,
        [TENANT, UNIT, FEEDER_A],
      ),
    ).resolves.toBeDefined();

    // The join that was meaningless before now resolves: one feeder, one row.
    const joined: Array<{ count: string }> = await pg!.dataSource.query(
      `SELECT COUNT(*) AS count
         FROM farm.daily_feeding_executions e
         JOIN farm.feeder_calibrations c ON c."equipment_id" = e."feederEquipmentId"
        WHERE e."tenantId" = $1`,
      [TENANT],
    );
    expect(Number(joined[0]!.count)).toBe(1);
  });

  it('REJECTS a sub-equipment id in the feeding record — the losing reading is unwritable', async () => {
    await expect(
      pg!.dataSource.query(
        `INSERT INTO farm.daily_feeding_executions ("tenantId", "equipmentId", "feederEquipmentId", "feederName")
         VALUES ($1, $2, $3, 'Hopper')`,
        [TENANT, UNIT, SUB_EQUIPMENT],
      ),
    ).rejects.toThrow(/FK_dfe_feeder_equipment|foreign key/i);
  });
});
