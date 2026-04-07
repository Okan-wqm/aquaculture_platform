import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  applyTenantRlsToSchema,
  MigrationLogger,
} from '@aquaculture/backend-common';

/**
 * RefreshTenantRlsPredicate1781000000000
 * ============================================================================
 *
 * Forward-migrates the tenant_isolation_policy predicate on every
 * farm-service tenant-scoped table to the canonical, bug-fixed version
 * shipped in `applyTenantRlsToSchema`.
 *
 * # What this fixes
 *
 * The previous migration `1776000000000-EnableRowLevelSecurity.ts` shipped a
 * predicate with a latent type-cast bug:
 *
 * ```sql
 * USING ("tenantId" = COALESCE(current_setting('app.current_tenant', true), '')::uuid)
 * ```
 *
 * When the GUC was unset (every cold path: cron jobs, startup, raw scripts),
 * `current_setting(..., true)` returned NULL, COALESCE produced an empty
 * string, and `''::uuid` raised:
 *
 *     ERROR: invalid input syntax for type uuid: ""
 *
 * That meant any query against an RLS-enabled table outside an HTTP request
 * crashed instead of returning zero rows. The new helper uses
 * `NULLIF(...)::uuid` so an unset GUC becomes NULL and the comparison
 * cleanly evaluates to UNKNOWN — no cast error, no rows leaked, deny by
 * default.
 *
 * The new helper also adds the bypass clause:
 *
 *     current_setting('app.bypass_rls', true) = 'on'
 *
 * which `BypassRlsService.withBypass()` uses to grant cross-tenant
 * visibility to background workers and SUPER_ADMIN endpoints. The original
 * predicate had no bypass concept, so background jobs couldn't operate
 * against RLS-enabled tables at all.
 *
 * # Why we don't EDIT the original migration
 *
 * TypeORM tracks executed migrations by class name in the
 * `migrations` table. Editing `1776000000000-EnableRowLevelSecurity.ts` in
 * place would NOT re-run on existing environments — its row would still
 * be present and TypeORM would skip it. The fix would silently fail to
 * deploy.
 *
 * Adding a NEW migration with a NEW timestamp guarantees the fix runs on
 * every environment exactly once. The original migration stays intact for
 * historical accuracy and rollback symmetry.
 *
 * # Idempotency
 *
 * `applyTenantRlsToSchema` always issues `DROP POLICY IF EXISTS` before
 * `CREATE POLICY`, so re-running this migration is a no-op. This is what
 * makes it safe to forward-migrate predicate changes via the helper —
 * future predicate updates ship as another `Refresh*` migration.
 *
 * # Out of scope
 *
 * This migration does NOT add the runtime RLS context propagation. That is
 * delivered by `RlsModule.forRoot('farm')` in `AppModule`, which patches
 * the pg pool to set `app.current_tenant` per checkout. Without that
 * runtime piece, the policy installed here would deny every query — so
 * the AppModule wiring MUST land in the same deploy.
 *
 * # Exclusions
 *
 * `farm_outbox` is deliberately excluded — it is read by the cross-tenant
 * outbox publisher worker and must stay visible without bypass.
 * `audit_logs` is excluded for forensic visibility (security incident
 * review across tenants).
 */
export class RefreshTenantRlsPredicate1781000000000
  implements MigrationInterface
{
  name = 'RefreshTenantRlsPredicate1781000000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Refreshing tenant_isolation_policy with bug-fixed predicate ' +
        '(NULLIF cast + bypass clause)',
    );

    await applyTenantRlsToSchema(queryRunner, {
      // Outbox is published cross-tenant by the outbox worker; RLS would
      // hide every event from the worker process and break delivery.
      // Audit logs are excluded for forensic visibility — incident
      // response must read across tenants.
      excludeTables: ['farm_outbox', 'audit_logs', 'audit_log'],
      // BaseEntity uses snake_case (`tenant_id`); some legacy tables use
      // camelCase (`tenantId`). The helper handles both by default but we
      // pass the list explicitly for documentation.
      tenantIdColumns: ['tenant_id', 'tenantId'],
      logger: this.logger,
    });

    this.logger.log('tenant_isolation_policy refreshed in farm schema');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // We do NOT use removeTenantRlsFromSchema here because that would
    // disable RLS entirely — and we want a rollback to leave the original
    // (buggy) policy in place so the deploy can be reverted to the prior
    // state without an interleaved "no RLS" window.
    //
    // Instead, the rollback re-installs the original predicate verbatim.
    // This is the only place we ever hand-write the predicate; all other
    // policy work goes through the helper.
    this.logger.warn(
      'Rolling back to legacy (buggy) tenant_isolation_policy predicate. ' +
        'Background jobs against RLS-enabled tables will start crashing ' +
        'with empty-string UUID cast errors after this rollback.',
    );

    const schemaRows: Array<{ schema: string }> = await queryRunner.query(
      `SELECT current_schema() AS schema`,
    );
    const schema = schemaRows[0]?.schema ?? 'farm';

    // Re-discover tables the same way the helper does, so the rollback
    // touches the same set of tables the up() touched.
    const rows: Array<{ table_name: string; column_name: string }> =
      await queryRunner.query(
        `
        SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema
         AND t.table_name   = c.table_name
         AND t.table_type   = 'BASE TABLE'
        WHERE c.table_schema = $1
          AND c.column_name IN ('tenant_id', 'tenantId')
        `,
        [schema],
      );

    const excludeSet = new Set(['farm_outbox', 'audit_logs', 'audit_log']);
    const seen = new Set<string>();

    for (const row of rows) {
      if (excludeSet.has(row.table_name)) continue;
      if (seen.has(row.table_name)) continue;
      seen.add(row.table_name);

      // Drop the new (fixed) policy and reinstall the legacy one verbatim.
      await queryRunner.query(
        `DROP POLICY IF EXISTS "tenant_isolation_policy" ON "${schema}"."${row.table_name}"`,
      );
      await queryRunner.query(
        `CREATE POLICY "tenant_isolation_policy" ON "${schema}"."${row.table_name}" ` +
          `FOR ALL ` +
          `USING ("${row.column_name}" = COALESCE(current_setting('app.current_tenant', true), '')::uuid)`,
      );
    }

    this.logger.log('Legacy predicate restored on farm schema');
  }
}
