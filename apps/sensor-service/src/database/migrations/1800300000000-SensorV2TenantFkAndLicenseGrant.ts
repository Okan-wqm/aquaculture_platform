import { MigrationInterface, QueryRunner } from 'typeorm';

// TENANT_AWARE_SOURCE_SCHEMA_DDL_OK: db-migrate-owned sensor source-schema hardening.
// This migration adds tenant FK proof and billing-owned license grants to the canonical
// sensor schema; runtime services do not execute this DDL.
const TENANT_FKS: ReadonlyArray<{
  table: string;
  constraint: string;
}> = [
  { table: 'devices', constraint: 'FK_edge_devices_tenant' },
  { table: 'policies', constraint: 'FK_edge_policies_tenant' },
  { table: 'licenses', constraint: 'FK_edge_licenses_tenant' },
  { table: 'firmware_releases', constraint: 'FK_edge_firmware_releases_tenant' },
  { table: 'provisioning_records', constraint: 'FK_edge_provisioning_records_tenant' },
  { table: 'witnesses', constraint: 'FK_edge_witnesses_tenant' },
  { table: 'audit_archive_v1', constraint: 'FK_edge_audit_archive_tenant' },
];

export class SensorV2TenantFkAndLicenseGrant1800300000000 implements MigrationInterface {
  name = 'SensorV2TenantFkAndLicenseGrant1800300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const fk of TENANT_FKS) {
      await queryRunner.query(`
        DO $$
        BEGIN
          ALTER TABLE "sensor"."${fk.table}"
            ADD CONSTRAINT "${fk.constraint}"
            FOREIGN KEY ("tenant_id")
            REFERENCES "auth"."tenants"("id")
            ON DELETE RESTRICT
            ON UPDATE RESTRICT
            NOT VALID;
        EXCEPTION WHEN duplicate_object THEN
          NULL;
        END $$;
      `);
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'billing_service') THEN
          GRANT INSERT, UPDATE ON "sensor"."licenses" TO billing_service;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'billing_service') THEN
          REVOKE INSERT, UPDATE ON "sensor"."licenses" FROM billing_service;
        END IF;
      END $$;
    `);

    for (const fk of [...TENANT_FKS].reverse()) {
      await queryRunner.query(`
        ALTER TABLE "sensor"."${fk.table}"
          DROP CONSTRAINT IF EXISTS "${fk.constraint}"
      `);
    }
  }
}
