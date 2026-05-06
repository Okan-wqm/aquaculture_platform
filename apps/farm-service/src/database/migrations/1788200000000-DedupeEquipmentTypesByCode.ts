import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * DedupeEquipmentTypesByCode1788200000000
 * ============================================================================
 *
 * Farm reference data is copied from `farm.equipment_types` into each tenant
 * schema during tenant provisioning. The table has always modelled `code` as
 * the business key, but older seed paths used read-then-write upserts and could
 * leave duplicate `code` rows in long-lived development databases. Once those
 * duplicates exist, two enterprise invariants break:
 *
 * 1. FarmSeedService cannot update the reference row deterministically.
 * 2. SchemaManagerService cannot copy reference data into a tenant schema
 *    because `CREATE TABLE ... LIKE INCLUDING ALL` carries the unique `code`
 *    index and the copied rows violate it.
 *
 * This migration repairs existing source and tenant schemas by keeping the
 * newest row per `code` and removing older duplicates. The seed service is
 * changed in the same work item to use atomic `ON CONFLICT (code) DO UPDATE`
 * so the corruption cannot be reintroduced by future boots.
 */
export class DedupeEquipmentTypesByCode1788200000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger(
    'DedupeEquipmentTypesByCode1788200000000',
  );

  name = 'DedupeEquipmentTypesByCode1788200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schemas = await this.listFarmSchemas(queryRunner);

    for (const schema of schemas) {
      if (!(await this.hasEquipmentTypes(queryRunner, schema))) {
        continue;
      }

      const result: Array<{ deleted: string }> = await queryRunner.query(`
        WITH ranked AS (
          SELECT
            ctid,
            ROW_NUMBER() OVER (
              PARTITION BY code
              ORDER BY "updatedAt" DESC NULLS LAST,
                       "createdAt" DESC NULLS LAST,
                       id DESC
            ) AS row_number
          FROM "${schema}"."equipment_types"
          WHERE code IS NOT NULL
        ),
        deleted AS (
          DELETE FROM "${schema}"."equipment_types" target
          USING ranked
          WHERE target.ctid = ranked.ctid
            AND ranked.row_number > 1
          RETURNING 1
        )
        SELECT COUNT(*)::text AS deleted FROM deleted
      `);

      const deleted = Number(result[0]?.deleted ?? 0);
      if (deleted > 0) {
        this.logger.log(
          `Deleted ${deleted} duplicate equipment_types row(s) in ${schema}`,
        );
      }
    }
  }

  public async down(): Promise<void> {
    // Data repair is intentionally irreversible. Recreating duplicate business
    // keys would violate the domain contract and break tenant provisioning.
  }

  private async listFarmSchemas(queryRunner: QueryRunner): Promise<string[]> {
    const rows: Array<{ schema_name: string }> = await queryRunner.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = 'farm'
         OR schema_name ~ '^tenant_[a-f0-9]{16}$'
      ORDER BY schema_name
    `);

    return rows
      .map((row) => row.schema_name)
      .filter((schema) => /^(farm|tenant_[a-f0-9]{16})$/.test(schema));
  }

  private async hasEquipmentTypes(
    queryRunner: QueryRunner,
    schema: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = $1
            AND table_name = 'equipment_types'
        ) AS exists
      `,
      [schema],
    );

    return rows[0]?.exists === true;
  }
}
