import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MoveEmployeesToHr1786000400000
 * ============================================================================
 *
 * Moves the employees table from public → hr:
 *
 *   public.employees → hr.employees
 *
 * Phase 8 of docs/plans/2026-04-14 public-schema teardown. Declared in
 * MODULE_SCHEMAS[hr].tables (schema-manager.service.ts:299) but
 * physically located in public because the hr-service Employee entity
 * (apps/hr-service/src/hr/entities/employee.entity.ts:142) omitted the
 * `schema:` option. This migration reconciles.
 *
 * # Complexity notes
 *
 *   - 19 columns (name parts, contact info, org hierarchy, salary,
 *     tax details — all PII, all travel unchanged via SET SCHEMA).
 *   - Composite indexes on (tenantId, personnelNumber),
 *     (tenantId, email), (tenantId, status), (tenantId, positionId) —
 *     preserved through SET SCHEMA catalog rename.
 *   - FK to departments_hr (which is in hr schema already). FK targets
 *     are stored by OID in pg_constraint; ALTER TABLE SET SCHEMA does
 *     NOT change any FK target OID, so this reference continues to
 *     resolve correctly after the move.
 *   - Cross-service reader in admin-api-service's
 *     tenant-admin.service.ts uses schema-manager keyed by module name,
 *     not a literal schema reference — unaffected.
 *
 * # nationalId encryption
 *
 * The nationalId column is stored encrypted at rest via the DBCrypto
 * transformer in the entity. The ciphertext is a plain bytea column;
 * SET SCHEMA does not interact with the encryption layer at all. No
 * key rotation needed.
 *
 * # See farm-service migration 1786000000000 for full architectural
 *   rationale (SET SCHEMA, RLS policy preservation, strict ownership).
 */
export class MoveEmployeesToHr1786000400000 implements MigrationInterface {
  name = 'MoveEmployeesToHr1786000400000';

  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'employees'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'hr' AND tablename = 'employees'
        ) THEN
          ALTER TABLE public.employees SET SCHEMA hr;
          ALTER TABLE hr.employees OWNER TO hr_service;
          ALTER TABLE hr.employees ENABLE ROW LEVEL SECURITY;
          ALTER TABLE hr.employees FORCE ROW LEVEL SECURITY;
        END IF;
      END $$;
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'hr' AND tablename = 'employees'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'employees'
        ) THEN
          ALTER TABLE hr.employees SET SCHEMA public;
          ALTER TABLE public.employees OWNER TO shared_public_owner;
        END IF;
      END $$;
    `);
  }
}
