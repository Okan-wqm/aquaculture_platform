import { MigrationInterface, QueryRunner } from 'typeorm';
import { Logger } from '@nestjs/common';

/**
 * SEC-C05: Enable Row-Level Security on all tenant-scoped tables.
 *
 * RLS provides database-level tenant isolation as a defense-in-depth measure.
 * Even if application-level search_path switching fails, RLS policies prevent
 * cross-tenant data access at the PostgreSQL engine level.
 *
 * Policy logic:
 *   Each row's "tenantId" column must match the session variable app.current_tenant.
 *   If app.current_tenant is NOT set, current_setting returns NULL and the
 *   comparison yields FALSE — no rows are visible. This is a secure default.
 *
 * FORCE ROW LEVEL SECURITY ensures that even the table owner (the DB user running
 * the application) is subject to the RLS policies. Without FORCE, the owner
 * bypasses all policies, defeating the purpose of defense-in-depth.
 *
 * The migration dynamically discovers all tables with a "tenantId" column in
 * the current schema, making it forward-compatible with new tenant-scoped tables.
 */
export class EnableRowLevelSecurity1776000000000 implements MigrationInterface {
  name = 'EnableRowLevelSecurity1776000000000';
  private readonly logger = new Logger(this.name);

  /**
   * Discover all tables in the current schema that have a "tenantId" column.
   * Uses information_schema.columns which is schema-aware.
   */
  private async getTenantScopedTables(queryRunner: QueryRunner): Promise<string[]> {
    const rows: Array<{ table_name: string }> = await queryRunner.query(`
      SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
        AND t.table_name = c.table_name
        AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema()
        AND c.column_name = 'tenantId'
      ORDER BY c.table_name
    `);
    return rows.map((r) => r.table_name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await queryRunner.query(`SELECT current_schema() AS schema`);
    const currentSchema: string = schema[0]?.schema ?? 'public';
    this.logger.log(`Enabling RLS in schema: ${currentSchema}`);

    const tables = await this.getTenantScopedTables(queryRunner);

    if (tables.length === 0) {
      this.logger.warn('No tables with "tenantId" column found in current schema. Skipping RLS setup.');
      return;
    }

    this.logger.log(`Found ${tables.length} tenant-scoped tables: ${tables.join(', ')}`);

    for (const table of tables) {
      const policyName = `tenant_isolation_policy`;

      /** Enable RLS on the table */
      await queryRunner.query(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      );

      /** FORCE ensures even table owner is subject to RLS policies */
      await queryRunner.query(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      );

      /**
       * Create tenant isolation policy.
       *
       * COALESCE(current_setting('app.current_tenant', true), '') handles the case
       * where the session variable is not set: current_setting with
       * missing_ok=true returns NULL, COALESCE converts to empty string, and
       * the comparison against a real UUID always fails — denying all rows.
       *
       * The ::uuid cast ensures type-safe comparison with the tenantId column.
       */
      const policyExists: Array<{ exists: boolean }> = await queryRunner.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = current_schema()
            AND tablename = $1
            AND policyname = $2
        )
      `, [table, policyName]);

      if (!policyExists[0]?.exists) {
        await queryRunner.query(
          `CREATE POLICY "${policyName}" ON "${table}"
           FOR ALL
           USING ("tenantId" = COALESCE(current_setting('app.current_tenant', true), '')::uuid)`,
        );
        this.logger.log(`RLS policy created on "${table}"`);
      } else {
        this.logger.log(`RLS policy already exists on "${table}", skipping`);
      }

      this.logger.log(`RLS enabled and forced on "${table}"`);
    }

    this.logger.log(`RLS setup complete for ${tables.length} tables`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = await queryRunner.query(`SELECT current_schema() AS schema`);
    const currentSchema: string = schema[0]?.schema ?? 'public';
    this.logger.log(`Disabling RLS in schema: ${currentSchema}`);

    const tables = await this.getTenantScopedTables(queryRunner);

    for (const table of tables) {
      const policyName = `tenant_isolation_policy`;

      /** Drop policy if it exists */
      const policyExists: Array<{ exists: boolean }> = await queryRunner.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = current_schema()
            AND tablename = $1
            AND policyname = $2
        )
      `, [table, policyName]);

      if (policyExists[0]?.exists) {
        await queryRunner.query(
          `DROP POLICY "${policyName}" ON "${table}"`,
        );
        this.logger.log(`Dropped RLS policy on "${table}"`);
      }

      /** Disable RLS on the table */
      await queryRunner.query(
        `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`,
      );

      this.logger.log(`RLS disabled on "${table}"`);
    }

    this.logger.log(`RLS teardown complete for ${tables.length} tables`);
  }
}
