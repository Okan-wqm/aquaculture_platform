import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ORPHAN-DIC-001 — `program_variables` gains a first-class `tenant_id`.
 *
 * The table was scoped only via its parent program (`program_id`), so RLS
 * and tenant-scoped queries could not act on it directly. The column is
 * added nullable, backfilled from the owning `automation_programs` row, and
 * then locked NOT NULL.
 *
 * Rolling-window safety: a BEFORE INSERT trigger derives `tenant_id` from
 * the parent program when a writer omits it, so pods still running the
 * previous code (which never set the column) keep inserting successfully
 * while the NOT NULL constraint already guarantees the invariant for every
 * row. New code always sets `tenant_id` explicitly — the trigger is a
 * bridge, not the write path. (Note: `CREATE TABLE ... LIKE ... INCLUDING
 * ALL` used for new-tenant provisioning copies the NOT NULL constraint but
 * not the trigger; that is fine because only current-code writers touch
 * newly provisioned tenants, and they always set the column.)
 *
 * Unqualified identifiers on purpose — db-migrate re-runs this per schema
 * (source `sensor` + every `tenant_*`) with `search_path` pinned, so each
 * schema gets its own column, backfill, trigger, and constraint.
 */
export class ProgramVariableTenantId1801200000000 implements MigrationInterface {
  name = 'ProgramVariableTenantId1801200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE program_variables ADD COLUMN IF NOT EXISTS tenant_id uuid`,
    );

    await queryRunner.query(`
      UPDATE program_variables pv
      SET tenant_id = ap.tenant_id
      FROM automation_programs ap
      WHERE ap.id::text = pv.program_id
        AND pv.tenant_id IS NULL
    `);

    // Rows whose parent program vanished cannot be tenant-attributed; they are
    // unreachable through every read path (all joins go through the program)
    // and blocking NOT NULL on them would wedge the migration forever.
    await queryRunner.query(`
      DELETE FROM program_variables pv
      WHERE pv.tenant_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM automation_programs ap WHERE ap.id::text = pv.program_id
        )
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION program_variables_fill_tenant_id()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.tenant_id IS NULL THEN
          SELECT ap.tenant_id INTO NEW.tenant_id
          FROM automation_programs ap
          WHERE ap.id::text = NEW.program_id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_program_variables_fill_tenant ON program_variables`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_program_variables_fill_tenant
      BEFORE INSERT ON program_variables
      FOR EACH ROW EXECUTE FUNCTION program_variables_fill_tenant_id()
    `);

    // Replay-idempotent NOT NULL: only apply while the column is still
    // nullable in THIS schema (the migration re-runs per tenant schema).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'program_variables'
            AND column_name = 'tenant_id'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE program_variables ALTER COLUMN tenant_id SET NOT NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_program_variables_tenant ON program_variables (tenant_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_program_variables_tenant`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_program_variables_fill_tenant ON program_variables`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS program_variables_fill_tenant_id()`);
    await queryRunner.query(`ALTER TABLE program_variables DROP COLUMN IF EXISTS tenant_id`);
  }
}
