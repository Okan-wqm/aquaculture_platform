import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTankSetupMetadata1800900000000 implements MigrationInterface {
  name = 'AddTankSetupMetadata1800900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = current_schema() AND t.typname = 'tanks_containerkind_enum'
        ) THEN
          CREATE TYPE tanks_containerkind_enum AS ENUM ('TANK', 'POND', 'CAGE');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE tanks
      ADD COLUMN IF NOT EXISTS "containerKind" tanks_containerkind_enum NOT NULL DEFAULT 'TANK',
      ADD COLUMN IF NOT EXISTS "equipmentTypeId" uuid,
      ADD COLUMN IF NOT EXISTS "equipmentTypeCode" character varying(100)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tanks_tenant_container_kind"
      ON tanks ("tenantId", "containerKind")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tanks_tenant_equipment_type_id"
      ON tanks ("tenantId", "equipmentTypeId")
    `);

    await applyTenantRlsToSchema(queryRunner, {
      includeTables: ['tanks'],
      tenantIdColumns: ['tenantId'],
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tanks_tenant_equipment_type_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tanks_tenant_container_kind"`);
    await queryRunner.query(`
      ALTER TABLE tanks
      DROP COLUMN IF EXISTS "equipmentTypeCode",
      DROP COLUMN IF EXISTS "equipmentTypeId",
      DROP COLUMN IF EXISTS "containerKind"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS tanks_containerkind_enum`);
  }
}
