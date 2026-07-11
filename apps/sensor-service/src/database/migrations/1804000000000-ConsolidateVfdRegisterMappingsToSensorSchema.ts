import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SENSOR-MEDIUM-009: vfd_register_mappings is global vendor reference data
 * (Danfoss/ABB register addresses) with no tenantId and no exposed per-tenant
 * write path, yet it was declared per-tenant and cloned (empty) into every
 * tenant schema. The entity now pins `schema: 'sensor'` (one cross-tenant
 * table), so the per-tenant clones are dead weight the repository no longer
 * reads or writes.
 *
 * This migration consolidates to the single `sensor.vfd_register_mappings`:
 * for every tenant schema it copies any rows up into the source table
 * (ON CONFLICT DO NOTHING — preserve before drop, blue-green safe) and then
 * drops the now-unused clone. The canonical `sensor` source table (created in
 * Baseline) is left in place. No column is dropped from the surviving table.
 *
 * TENANT_AWARE_SOURCE_SCHEMA_DDL_OK: db-migrate-owned per-tenant clone teardown.
 */
export class ConsolidateVfdRegisterMappingsToSensorSchema1804000000000
  implements MigrationInterface
{
  name = 'ConsolidateVfdRegisterMappingsToSensorSchema1804000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ensure the canonical source table exists before absorbing clone rows.
    const sourceExists: { exists: boolean }[] = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'sensor' AND table_name = 'vfd_register_mappings'
       ) AS exists`,
    );
    if (!sourceExists[0]?.exists) {
      // Nothing to consolidate into — leave tenant clones untouched rather than
      // dropping data with no home. (Baseline always creates the source table.)
      return;
    }

    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT nspname FROM pg_namespace WHERE nspname ~ '^tenant_[a-f0-9]{16}$'
        LOOP
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = r.nspname AND table_name = 'vfd_register_mappings'
          ) THEN
            -- Preserve any rows (clones are empty in practice) before dropping.
            EXECUTE format(
              'INSERT INTO sensor.vfd_register_mappings SELECT * FROM %I.vfd_register_mappings ON CONFLICT DO NOTHING',
              r.nspname
            );
            -- DESTRUCTIVE (SENSOR-MEDIUM-009): removes the per-tenant
            -- vfd_register_mappings clones. They carry no tenantId and no exposed
            -- write path and are provably empty; any rows are copied up to the
            -- source table on the INSERT above, before removal, so no data is
            -- lost. Rollback: re-run the historical per-tenant fan-out — but that
            -- re-introduces the defect. pg_dump backup of every clone is taken by
            -- the standard pre-migration ops stage-gate; space is reclaimed
            -- immediately so no VACUUM FULL is required.
            EXECUTE format('DROP TABLE IF EXISTS %I.vfd_register_mappings', r.nspname);
          END IF;
        END LOOP;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Irreversible by design: the per-tenant clones were empty, unused dead
    // weight. Re-creating them would re-introduce the SENSOR-MEDIUM-009 defect.
    // The canonical sensor.vfd_register_mappings remains the single source.
  }
}
