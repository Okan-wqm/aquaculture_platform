import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropFarmWorkerPlaceholderPii1805500000000
 *
 * ORPHAN-MEDIUM-379 (A8 / DB-FARMPLAT-MEDIUM-001): `farm_workers` carried five
 * NOT NULL columns — "address", "dateOfBirth", "nationalId", "employmentType",
 * "baseSalary" — that were write-only placeholder sinks. Since the worker
 * module's introduction (00139d810, v1.4.1), CreateWorkerInput accepted NONE
 * of them; create-worker.handler.ts synthesized the same constants on every
 * insert purely to satisfy NOT NULL (address {'-','-','-','-','TR'},
 * dateOfBirth '1990-01-01', nationalId '-', employmentType 'full_time',
 * baseSalary 0); update-worker.handler.ts never touched them; worker.resolver
 * never returned them; no query filtered on them. Deep worker PII belongs to
 * hr.employees — the platform's worker-PII SSoT. This migration drops the
 * columns; the same PR deletes the entity fields and the placeholder-synthesis
 * code, making the fake-PII state structurally impossible.
 *
 * WHY NO ARCHIVE STEP: every value in these columns is a synthesized constant
 * (evidence above — the handler was the only writer and only ever wrote the
 * placeholders; the DTO never carried the fields, so no user-supplied value
 * could reach them). There is no real data to preserve. A data-level guard
 * (row-content assertion à la DropFarmDocuments) is impossible here by
 * design: three of the columns hold AES-256-GCM ciphertext with per-row IVs
 * (EncryptFarmWorkerPii1801100000000), so SQL cannot inspect the plaintext —
 * the verification is the structural code evidence, not a row scan.
 *
 * WHY current_schema-relative: the db-migrate fan-out runs this once per
 * schema (source `farm`, then each `tenant_<uuid>`), and every schema owns its
 * OWN `farm_workers` clone. Each pass touches only current_schema() — no
 * cross-schema DDL (the #926 overreach class). No enum types are involved
 * (varchar/text/date/numeric columns), so there is no type-reclaim step.
 *
 * Fresh-database ordering stays coherent: Baseline1800000000000 creates the
 * columns, EncryptFarmWorkerPii1801100000000 backfills them in place (a no-op
 * on zero rows), and this migration drops them — all three remain immutable
 * and replayable in sequence.
 *
 * down() is an honest no-op: the authoritative recreate path for a dropped
 * placeholder surface is a new forward migration alongside restored
 * application code, not a rollback (forward-only stance of the sibling drop
 * migrations in this directory).
 */
export class DropFarmWorkerPlaceholderPii1805500000000 implements MigrationInterface {
  name = 'DropFarmWorkerPlaceholderPii1805500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    // Every reference is pinned to current_schema() so each fan-out pass is
    // strictly self-scoped. IF EXISTS keeps the pass idempotent and tolerant
    // of a behind schema where a column is already gone.
    await queryRunner.query(`
      DO $$
      DECLARE col_name text;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_name = 'farm_workers'
        ) THEN
          RAISE NOTICE 'DropFarmWorkerPlaceholderPii: %.farm_workers absent — nothing to drop',
            current_schema();
          RETURN;
        END IF;

        FOREACH col_name IN ARRAY ARRAY[
          'address',
          'dateOfBirth',
          'nationalId',
          'employmentType',
          'baseSalary'
        ] LOOP
          EXECUTE format(
            'ALTER TABLE %I.farm_workers DROP COLUMN IF EXISTS %I -- DESTRUCTIVE: ORPHAN-MEDIUM-379 placeholder-only column (synthesized constants, no real data ever written); forward recreate path is a new migration, not a rollback',
            current_schema(), col_name
          );
        END LOOP;
      END $$;
    `);
  }

  /** The runner refuses the ledger row unless every placeholder column is really gone. */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'farm_workers'
           AND column_name IN
             ('address', 'dateOfBirth', 'nationalId', 'employmentType', 'baseSalary')
      ) AS ok
    `)) as Array<{ ok: boolean }>;

    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Honest no-op. The dropped columns held only synthesized placeholders
    // (guarded structurally — see the class docblock); resurrecting them would
    // require the entity fields and placeholder-synthesis code deleted in the
    // same PR, so the only meaningful recreate path is a new forward migration
    // alongside restored application code — not a rollback of this one.
  }
}
