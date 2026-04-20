import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ConvergeTenantIdToUuid
 * ============================================================================
 *
 * Converts `tenant_id` from `varchar` to `uuid` on the two alert-engine
 * tables whose entity decorators explicitly declare `type: 'uuid'`.
 *
 * # Drift detected at boot 2026-04-20
 *
 * SchemaDriftValidator[alert] reports per cold start:
 *
 *   [alert.alert_incidents.tenant_id]  entity declares uuid but DB is character varying
 *   [alert.alert_audit_log.tenant_id]  entity declares uuid but DB is character varying
 *
 * (plus `audit_logs schema='shared' lives in 'admin'` fixed by
 * INFRA-CRITICAL-026.)
 *
 * # Why uuid is canonical (CLAUDE.md)
 *
 * Platform-wide canonical tenant-identifier type is uuid. RLS policies
 * use `current_setting('app.current_tenant')::uuid` — varchar columns
 * fail the type-checked comparison with `operator does not exist:
 * character varying = uuid`. Same incident class as the 2026-04-08
 * farm-service production crash (see audit-log.entity.ts docblock
 * §"Migration impact on existing deployments").
 *
 * # Tables NOT in scope
 *
 * `alert_rules`, `escalation_policies`, and `alert_history` declare
 * `tenant_id` WITHOUT an explicit `type:` — they accept the DB
 * varchar today and don't surface as drift in the validator. Migrating
 * them to uuid is a separate hardening pass that requires updating
 * the entity decorators in the same commit (otherwise the drift
 * validator would START reporting them as the inverse drift). Tracked
 * separately; this migration only closes the 2 documented violations.
 *
 * # Data safety
 *
 * `alert_incidents` and `alert_audit_log` are empty in the live droplet
 * today (verified by `SELECT COUNT(*) FROM alert.alert_incidents`
 * and `SELECT COUNT(*) FROM alert.alert_audit_log` both = 0). The
 * `ALTER COLUMN ... USING tenant_id::uuid` cast is safe. If rows had
 * non-UUID tenant_id values the cast would fail loudly — which is the
 * correct signal for data corruption rather than a silent
 * string-to-uuid conversion.
 *
 * # Idempotent
 *
 * Each ALTER is gated on `data_type = 'character varying'` so the
 * migration is safe to re-run on a database where the column is
 * already uuid (idempotent, second run is a no-op).
 */
export class ConvergeTenantIdToUuid1786400000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['alert_incidents', 'alert_audit_log']) {
      const colInfo: Array<{ data_type: string }> = await queryRunner.query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'alert' AND table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      if (colInfo[0]?.data_type === 'character varying') {
        await queryRunner.query(`
          ALTER TABLE alert."${table}"
            ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid
        `);
      }
      // Else: already uuid (idempotent re-run) — nothing to do.
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback to varchar. Operators should fix-forward in real-world
    // rather than rolling back — varchar tenant_id breaks RLS policies.
    for (const table of ['alert_audit_log', 'alert_incidents']) {
      await queryRunner.query(`
        ALTER TABLE alert."${table}"
          ALTER COLUMN tenant_id TYPE varchar(255) USING tenant_id::text
      `);
    }
  }
}
