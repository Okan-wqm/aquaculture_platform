import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'feeding_day_plans';
const COLUMN = 'rationBasisKg';

/**
 * AddDayPlanRationBasis1809300000000
 *
 * WHAT: the biomass a day plan's ration is priced from, separate from the unit's
 * live biomass.
 *
 * WHY: the intra-day recalculation priced the day from `TankBatch.totalBiomassKg`,
 * and in `per_meal` growth mode finalising a meal writes FCR-projected growth
 * straight into that column. The morning meal therefore enlarged the noon meal,
 * the noon meal the evening one, and the day's total quietly exceeded the rate
 * the protocol prescribed at 06:00 — every day, once per meal, in every tenant
 * (every protocol on this platform carries `per_meal`: it is the GraphQL input's
 * default and what the legacy converter emits). The ration is now anchored to the
 * biomass at the start of the day and moves ONLY for real stock movements
 * (stocking, mortality, cull, transfer, harvest and its reversal, ledger
 * reconciliation) and for a weighing, which supersedes the model.
 *
 * The difference between this column and the live biomass is now a readable
 * number: it is the growth the day's own feed produced.
 *
 * NULLABLE + BACKFILLED, deliberately: plans written before this column existed
 * are anchored to their generation snapshot, which is the identical value the
 * writer persists at generation (`snapshot.biomassKg`), so the backfill below is
 * the same expression the code falls back to. A NOT NULL without a default would
 * have made a pod that predates the column fail its 06:00 INSERT mid-rollout —
 * a unit with no plan is worse than a unit whose plan re-derives its own basis.
 *
 * TENANT-SCOPED table, so the DDL is SCHEMA-UNQUALIFIED (each pass lands the
 * column in its own tenant schema).
 */
export class AddDayPlanRationBasis1809300000000 implements MigrationInterface {
  name = 'AddDayPlanRationBasis1809300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(
      `ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "${COLUMN}" numeric(12,3)`,
    );

    // Backfill: every existing plan was priced from its generation snapshot, so
    // that IS its basis. Rows whose day is already over are backfilled too —
    // the audit trail should read the same as a plan generated today.
    await queryRunner.query(
      `UPDATE "${TABLE}"
          SET "${COLUMN}" = (snapshot->>'biomassKg')::numeric
        WHERE "${COLUMN}" IS NULL
          AND snapshot ? 'biomassKg'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "${COLUMN}"`);
  }
}
