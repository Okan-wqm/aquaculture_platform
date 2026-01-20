import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Make Department siteId Nullable
 *
 * This migration allows departments to exist without a site (orphaned departments).
 * When a site is deleted, departments will have their siteId set to NULL instead of being deleted.
 *
 * Changes:
 * 1. Make site_id column nullable in departments table
 * 2. Drop old unique index on (tenant_id, site_id, code)
 * 3. Create new unique index on (tenant_id, code) for non-deleted records
 * 4. Update foreign key constraint to SET NULL on delete
 */
export class MakeDepartmentSiteIdNullable1765012800000 implements MigrationInterface {
  name = 'MakeDepartmentSiteIdNullable1765012800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await queryRunner.query(`SELECT current_schema()`);
    console.log('Running migration in schema:', schema);

    // 1. Drop the existing foreign key constraint (if exists)
    const fkExists = await this.constraintExists(queryRunner, 'departments', 'FK_departments_site');
    if (fkExists) {
      await queryRunner.query(`
        ALTER TABLE "departments"
        DROP CONSTRAINT "FK_departments_site"
      `);
      console.log('Dropped FK_departments_site constraint');
    }

    // Also check for auto-generated constraint name
    const fkAutoExists = await this.constraintExists(queryRunner, 'departments', 'departments_site_id_fkey');
    if (fkAutoExists) {
      await queryRunner.query(`
        ALTER TABLE "departments"
        DROP CONSTRAINT "departments_site_id_fkey"
      `);
      console.log('Dropped departments_site_id_fkey constraint');
    }

    // 2. Make site_id column nullable
    await queryRunner.query(`
      ALTER TABLE "departments"
      ALTER COLUMN "site_id" DROP NOT NULL
    `);
    console.log('Made site_id column nullable');

    // 3. Drop old unique index on (tenant_id, site_id, code)
    const oldIndexExists = await this.indexExists(queryRunner, 'IDX_departments_tenant_site_code');
    if (oldIndexExists) {
      await queryRunner.query(`DROP INDEX "IDX_departments_tenant_site_code"`);
      console.log('Dropped old unique index IDX_departments_tenant_site_code');
    }

    // Also check TypeORM auto-generated index name
    const oldIndex2Exists = await this.indexExists(queryRunner, 'departments_tenant_id_site_id_code_idx');
    if (oldIndex2Exists) {
      await queryRunner.query(`DROP INDEX "departments_tenant_id_site_id_code_idx"`);
      console.log('Dropped old unique index departments_tenant_id_site_id_code_idx');
    }

    // 4. Create new unique index on (tenant_id, code) for non-deleted records
    const newIndexExists = await this.indexExists(queryRunner, 'IDX_departments_tenant_code_unique');
    if (!newIndexExists) {
      await queryRunner.query(`
        CREATE UNIQUE INDEX "IDX_departments_tenant_code_unique"
        ON "departments" ("tenant_id", "code")
        WHERE "is_deleted" = false
      `);
      console.log('Created new unique index IDX_departments_tenant_code_unique');
    }

    // 5. Add new foreign key constraint with ON DELETE SET NULL
    await queryRunner.query(`
      ALTER TABLE "departments"
      ADD CONSTRAINT "FK_departments_site"
      FOREIGN KEY ("site_id")
      REFERENCES "sites"("id")
      ON DELETE SET NULL
    `);
    console.log('Added FK_departments_site constraint with ON DELETE SET NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Note: Down migration cannot restore data if siteId was set to NULL
    // This is a one-way migration for safety

    // 1. Drop new foreign key constraint
    const fkExists = await this.constraintExists(queryRunner, 'departments', 'FK_departments_site');
    if (fkExists) {
      await queryRunner.query(`
        ALTER TABLE "departments"
        DROP CONSTRAINT "FK_departments_site"
      `);
    }

    // 2. Drop new unique index
    const newIndexExists = await this.indexExists(queryRunner, 'IDX_departments_tenant_code_unique');
    if (newIndexExists) {
      await queryRunner.query(`DROP INDEX "IDX_departments_tenant_code_unique"`);
    }

    // 3. Delete orphaned departments (those without site_id)
    // This is necessary before making site_id NOT NULL again
    await queryRunner.query(`
      DELETE FROM "departments"
      WHERE "site_id" IS NULL
    `);
    console.log('Deleted orphaned departments (site_id IS NULL)');

    // 4. Make site_id NOT NULL again
    await queryRunner.query(`
      ALTER TABLE "departments"
      ALTER COLUMN "site_id" SET NOT NULL
    `);

    // 5. Recreate old unique index
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_departments_tenant_site_code"
      ON "departments" ("tenant_id", "site_id", "code")
    `);

    // 6. Add back foreign key with CASCADE
    await queryRunner.query(`
      ALTER TABLE "departments"
      ADD CONSTRAINT "FK_departments_site"
      FOREIGN KEY ("site_id")
      REFERENCES "sites"("id")
      ON DELETE CASCADE
    `);
  }

  /**
   * Helper to check if a constraint exists
   */
  private async constraintExists(
    queryRunner: QueryRunner,
    tableName: string,
    constraintName: string
  ): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_name = $1
        AND constraint_name = $2
      )
    `, [tableName, constraintName]);
    return result[0]?.exists === true;
  }

  /**
   * Helper to check if an index exists
   */
  private async indexExists(
    queryRunner: QueryRunner,
    indexName: string
  ): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE indexname = $1
      )
    `, [indexName]);
    return result[0]?.exists === true;
  }
}
