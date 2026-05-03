import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateStorageLotMixes
 * ============================================================================
 *
 * WHAT: Creates the `farm.storage_lot_mixes` source table owned by the
 * StorageLotMix entity before the follow-up GIN index migration runs.
 *
 * WHY: Source-schema bootstrap is strict: every entity-backed table must be
 * migration-owned before startup validation. Relying on synchronize to create
 * this table makes E2E/prod boot order non-deterministic and caused the
 * 1787200000000 index migration to fail against fresh databases.
 */
export class CreateStorageLotMixes1787150000000 implements MigrationInterface {
  name = 'CreateStorageLotMixes1787150000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.storage_lot_mixes (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL,
        "storageLocationId" UUID NOT NULL,
        "itemType" VARCHAR(20) NOT NULL,
        "itemId" UUID NOT NULL,
        "effectiveLotNumber" VARCHAR(255) NOT NULL,
        "contributingLots" JSONB NOT NULL,
        "totalQuantityKg" NUMERIC(14, 2) NOT NULL,
        "mixedAt" TIMESTAMPTZ NOT NULL,
        "createdBy" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_storage_lot_mixes_tenant_location"
      ON farm.storage_lot_mixes ("tenantId", "storageLocationId");
      CREATE INDEX IF NOT EXISTS "IDX_storage_lot_mixes_tenant_item"
      ON farm.storage_lot_mixes ("tenantId", "itemId");
      CREATE INDEX IF NOT EXISTS "IDX_storage_lot_mixes_tenant_effective_lot"
      ON farm.storage_lot_mixes ("tenantId", "effectiveLotNumber");
      CREATE INDEX IF NOT EXISTS "IDX_storage_lot_mixes_tenant"
      ON farm.storage_lot_mixes ("tenantId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS farm.storage_lot_mixes');
  }
}
