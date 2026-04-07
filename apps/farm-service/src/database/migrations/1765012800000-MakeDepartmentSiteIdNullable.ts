import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

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
 *
 * IDEMPOTENCY GUARD (added retroactively):
 * The Department entity was later refactored from snake_case columns
 * (`site_id`, `tenant_id`, `is_deleted`) to camelCase (`siteId`, `tenantId`,
 * `isDeleted`). On any environment provisioned AFTER that refactor,
 * SourceSchemaBootstrapService.synchronize() creates the table directly
 * from the entity decorators in the post-refactor state — `siteId` is
 * already nullable, the unique index on (tenantId, code) already exists,
 * and the foreign key already uses ON DELETE SET NULL. The migration's
 * intent is fully satisfied before it ever runs, so it must detect that
 * and exit cleanly. Without this guard the ALTER COLUMN statement would
 * raise `column "site_id" of relation "departments" does not exist` and
 * crash the entire farm-service bootstrap.
 *
 * The check is consistent with the migration's existing idempotency
 * pattern (constraint and index existence checks) — we extend it with a
 * column existence check at the top so the whole migration is safely
 * skipped on the post-refactor schema.
 */
export class MakeDepartmentSiteIdNullable1765012800000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('MakeDepartmentSiteIdNullable1765012800000');
  name = 'MakeDepartmentSiteIdNullable1765012800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await queryRunner.query(`SELECT current_schema()`);
    this.logger.log('Running migration in schema:', schema);

    // IDEMPOTENCY GUARD: skip the entire migration if the snake_case column
    // does not exist. This means we are on a post-refactor environment
    // where SourceSchemaBootstrapService has already created the table
    // with the camelCase `siteId` column in its desired final state
    // (nullable, indexed on (tenantId, code), FK ON DELETE SET NULL).
    // Running the original ALTER COLUMN statement would fail because the
    // `site_id` column does not exist on this schema.
    const hasOldSiteIdColumn = await this.columnExists(queryRunner, 'departments', 'site_id');
    if (!hasOldSiteIdColumn) {
      this.logger.log(
        'departments.site_id column does not exist (entity uses camelCase siteId; ' +
        'SourceSchemaBootstrapService already created the table in the desired state) — ' +
        'migration is a no-op on this schema, skipping',
      );
      return;
    }

    // 1. Drop the existing foreign key constraint (if exists)
    const fkExists = await this.constraintExists(queryRunner, 'departments', 'FK_departments_site');
    if (fkExists) {
      await queryRunner.query(`
        ALTER TABLE "departments"
        DROP CONSTRAINT "FK_departments_site"
      `);
      this.logger.log('Dropped FK_departments_site constraint');
    }

    // Also check for auto-generated constraint name
    const fkAutoExists = await this.constraintExists(queryRunner, 'departments', 'departments_site_id_fkey');
    if (fkAutoExists) {
      await queryRunner.query(`
        ALTER TABLE "departments"
        DROP CONSTRAINT "departments_site_id_fkey"
      `);
      this.logger.log('Dropped departments_site_id_fkey constraint');
    }

    // 2. Make site_id column nullable
    await queryRunner.query(`
      ALTER TABLE "departments"
      ALTER COLUMN "site_id" DROP NOT NULL
    `);
    this.logger.log('Made site_id column nullable');

    // 3. Drop old unique index on (tenant_id, site_id, code)
    const oldIndexExists = await this.indexExists(queryRunner, 'IDX_departments_tenant_site_code');
    if (oldIndexExists) {
      await queryRunner.query(`DROP INDEX "IDX_departments_tenant_site_code"`);
      this.logger.log('Dropped old unique index IDX_departments_tenant_site_code');
    }

    // Also check TypeORM auto-generated index name
    const oldIndex2Exists = await this.indexExists(queryRunner, 'departments_tenant_id_site_id_code_idx');
    if (oldIndex2Exists) {
      await queryRunner.query(`DROP INDEX "departments_tenant_id_site_id_code_idx"`);
      this.logger.log('Dropped old unique index departments_tenant_id_site_id_code_idx');
    }

    // 4. Create new unique index on (tenant_id, code) for non-deleted records
    const newIndexExists = await this.indexExists(queryRunner, 'IDX_departments_tenant_code_unique');
    if (!newIndexExists) {
      await queryRunner.query(`
        CREATE UNIQUE INDEX "IDX_departments_tenant_code_unique"
        ON "departments" ("tenant_id", "code")
        WHERE "is_deleted" = false
      `);
      this.logger.log('Created new unique index IDX_departments_tenant_code_unique');
    }

    // 5. Add new foreign key constraint with ON DELETE SET NULL
    await queryRunner.query(`
      ALTER TABLE "departments"
      ADD CONSTRAINT "FK_departments_site"
      FOREIGN KEY ("site_id")
      REFERENCES "sites"("id")
      ON DELETE SET NULL
    `);
    this.logger.log('Added FK_departments_site constraint with ON DELETE SET NULL');
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
    this.logger.log('Deleted orphaned departments (site_id IS NULL)');

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

  /**
   * Helper to check if a column exists on a given table in the current schema.
   * Used by the idempotency guard at the top of `up()` to detect a post-refactor
   * environment where the snake_case `site_id` column has been replaced with the
   * camelCase `siteId` by SourceSchemaBootstrapService synchronize().
   */
  private async columnExists(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
  ): Promise<boolean> {
    const result = await queryRunner.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = $1
          AND column_name = $2
          AND table_schema = current_schema()
      )
      `,
      [tableName, columnName],
    );
    return result[0]?.exists === true;
  }
}
