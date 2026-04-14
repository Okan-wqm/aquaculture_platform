import { MigrationInterface, QueryRunner } from 'typeorm';
import { Logger } from '@nestjs/common';
import {
  applyTenantRlsToSchema,
  removeTenantRlsFromSchema,
} from '@aquaculture/backend-common';

/**
 * Migration: Install canonical tenant_isolation_policy on all tenant-scoped
 * messaging tables.
 *
 * # Why this exists — ADR-011 convergence (2026-04-14 plan)
 *
 * Before this migration, messaging was the only platform service whose
 * source-schema tables had NO Row-Level Security policies. Tenant
 * isolation relied solely on search_path mutation in
 * TenantSchemaMiddleware — a single forgotten SET search_path in a
 * handler (or a connection leaking unset GUCs) would cross tenant
 * boundaries silently.
 *
 * This migration closes that gap by installing the canonical
 * `tenant_isolation_policy` (via backend-common's
 * `applyTenantRlsToSchema`) on every tenant-scoped messaging table —
 * the same helper used by farm / sensor / hr / auth / etc. RLS is now
 * the PRIMARY isolation mechanism; search_path remains as defense in
 * depth.
 *
 * # Partition handling
 *
 * `messages` and `message_receipts` are RANGE-partitioned by time.
 * PostgreSQL's RLS semantics automatically apply a policy created on
 * the partition parent to every existing and future partition, so the
 * helper only needs to install on the parent table. The helper's
 * discovery query includes partition children (they have `tenantId`
 * columns too), which is benign — the policy is idempotently
 * re-installed on each partition with the same predicate.
 *
 * # Excludes
 *
 * - `embeddings_metadata` — platform-wide reference data (tracks AI
 *   embedding model versions); not tenant-scoped. Treated like
 *   `audit_logs` / `user_permissions`.
 * - `messaging_outbox` — cross-tenant background worker reads all
 *   tenants' events. Worker runs under `BypassRlsService.withBypass()`
 *   when publishing. Excluded here so application-layer writers still
 *   pass (they already filter by tenantId via entity code; no RLS
 *   needed on the outbox for writers).
 *
 * # Per-tenant schema handling
 *
 * Messaging uses schema-per-tenant clones (`tenant_<uuid>.channels`,
 * etc.) created via `CREATE TABLE LIKE INCLUDING ALL` which does NOT
 * copy RLS policies. The already-wired `RlsModule.forPoolService({
 * syncTenantSchemas: true })` in app.module.ts runs
 * `TenantRlsSyncService` at every service start, which iterates every
 * `tenant_<uuid>` schema and re-applies the same policy via the same
 * helper. This migration + that service together make RLS complete
 * across source + tenant schemas.
 *
 * # Idempotency
 *
 * `applyTenantRlsToSchema` drops the policy by canonical name and
 * recreates it — safe to re-run. Operators can ship predicate changes
 * in a follow-up migration that just calls this helper again with
 * updated options.
 *
 * # Closes findings
 *
 * - docs/reviews/messaging-expert/2026-04-14-tenant-isolation-violation-e2e.md#CRITICAL-MSG-001
 */
export class EnableRowLevelSecurity1782400000000 implements MigrationInterface {
  name = 'EnableRowLevelSecurity1782400000000';

  private readonly logger = new Logger(this.name);

  async up(queryRunner: QueryRunner): Promise<void> {
    // Defensive: pin search_path to messaging source schema before the
    // helper runs current_schema()-based discovery. The
    // MessagingMigrationRunnerService already pins this between every
    // migration; the explicit SET here keeps the migration correct
    // under ad-hoc CLI execution too.
    await queryRunner.query(`SET search_path TO "messaging", public`);

    await applyTenantRlsToSchema(queryRunner, {
      schemaOverride: 'messaging',
      // Messaging entities use camelCase tenantId exclusively (verified
      // in P0 pre-flight audit). Override the default to skip the
      // snake_case tenant_id discovery pass and make the intent explicit.
      tenantIdColumns: ['tenantId'],
      excludeTables: [
        // Platform reference data — not tenant-scoped.
        'embeddings_metadata',
        // Cross-tenant background worker reads all tenants' events;
        // worker wraps reads in BypassRlsService.withBypass().
        'messaging_outbox',
      ],
      logger: this.logger,
    });
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET search_path TO "messaging", public`);

    await removeTenantRlsFromSchema(queryRunner, {
      tenantIdColumns: ['tenantId'],
      excludeTables: ['embeddings_metadata', 'messaging_outbox'],
      logger: this.logger,
    });
  }
}
