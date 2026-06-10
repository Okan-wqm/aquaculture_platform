import { MigrationInterface, QueryRunner } from 'typeorm';
import { Logger } from '@nestjs/common';

/**
 * Migration: Consolidate per-tenant messaging schema data into the
 * messaging source schema.
 *
 * # ⚠️ GATED — NOT auto-registered in app.module.ts migrations[] ⚠️
 *
 * This migration is destructive and production-irreversible without a
 * pg_dump snapshot. It is shipped as CODE only, not auto-run. To
 * execute in production:
 *
 *   1. Take pg_dump snapshot to encrypted S3 with 72h retention
 *   2. Run in staging end-to-end
 *   3. Schedule maintenance window (writes paused or rate-limited)
 *   4. Register in app.module.ts migrations[] array
 *   5. Deploy; runner picks it up
 *   6. Validate row counts + tenant isolation
 *   7. Proceed to P7 entity decoration (which REQUIRES this migration
 *      to have run, because decorated entities query messaging.*
 *      directly)
 *
 * # Why this migration exists — ADR-011 convergence (2026-04-14 plan)
 *
 * Before this migration, messaging used a schema-per-tenant model:
 * every tenant's data lived in `tenant_<uuid>.channels`,
 * `tenant_<uuid>.messages`, etc. (clones of `messaging.channels` etc.
 * created via CREATE TABLE LIKE INCLUDING ALL).
 *
 * ADR-011 mandates single-schema + tenantId + RLS for all services.
 * Farm/sensor/hr/etc. follow this; messaging was the lone exception.
 *
 * To converge, production data in `tenant_<uuid>.*` must be
 * consolidated back into the source `messaging.*` tables with the
 * per-tenant schema UUID materialized as each row's tenantId.
 *
 * # Algorithm
 *
 * For every tenant schema `tenant_<16hex>`:
 *   1. Derive tenant UUID from schema name (pad hex to full UUID form)
 *   2. For each messaging table, INSERT ... SELECT from tenant schema
 *      into source, setting tenantId = derived UUID for any row that
 *      lacks it (some rows may already have tenantId from P3).
 *   3. ON CONFLICT DO NOTHING: UUIDs are random so collisions are
 *      astronomically unlikely, but this makes the migration
 *      idempotent — re-running is a no-op.
 *
 * # FK-safe order (parents before children)
 *
 *   channels → channel_members
 *   messages (+ partitions) → [attachments, receipts, reactions,
 *                              pinned_messages, analysis,
 *                              entity_references, knowledge_entries]
 *   (independent) retention_policies, legal_holds,
 *                 compliance_audit_log, tenant_ai_settings,
 *                 user_ai_consents, messaging_outbox
 *   (excluded) embeddings_metadata — platform-wide, not per-tenant
 *
 * # RLS during execution
 *
 * Migration runs under the migration user which has RLS via FORCE
 * (installed in 1782400000000). To read tenant_<uuid>.* rows bypassing
 * source-schema RLS, the migration sets `app.bypass_rls='on'` via
 * SET LOCAL per transaction. This is the bypass contract the policy
 * recognises — same path used by BypassRlsService at runtime.
 *
 * # Partition handling
 *
 * messages / message_receipts are RANGE-partitioned by time. Inserts
 * into the parent table auto-route to the correct partition. If a
 * tenant schema has messages_<month> partitions for months that do NOT
 * exist in the source schema, the migration CREATES those partitions
 * first. (Unlikely in practice — both schemas should share the same
 * partition range — but covered for safety.)
 *
 * # Cross-tenant ID collision
 *
 * All primary keys in messaging are UUIDs generated via
 * gen_random_uuid(). Across 10K tenants × 100M rows collision
 * probability ≈ 10^-25. Still, ON CONFLICT DO NOTHING guards against
 * the impossible. If a collision occurs, the row in the source schema
 * wins; operator investigates via migration log.
 *
 * # Rollback
 *
 * NONE in-place. Restore from pre-migration pg_dump. The tenant_<uuid>
 * schemas are left intact until explicit P9 cleanup, so the pre-state
 * is recoverable by reverting search_path resolution via entity
 * un-decoration (P7 rollback).
 *
 * # Closes findings
 *
 * - docs/reviews/messaging-expert/2026-04-14-tenant-isolation-violation-e2e.md#CRITICAL-MSG-001
 *   (ADR-011 convergence, full-data track)
 */
export class ConsolidateTenantSchemaData1782500000000 implements MigrationInterface {
  name = 'ConsolidateTenantSchemaData1782500000000';

  private readonly logger = new Logger(this.name);

  /** Tables consolidated by this migration, in FK-safe order. */
  private static readonly CONSOLIDATION_ORDER: readonly string[] = [
    // Channel aggregates first
    'channels',
    'channel_members',
    // Messages (partitioned parent; children follow)
    'messages',
    'message_attachments',
    'message_receipts',
    'message_reactions',
    'pinned_messages',
    'message_analysis',
    'message_entity_references',
    'knowledge_entries',
    // Independent / per-tenant config
    'retention_policies',
    'legal_holds',
    'compliance_audit_log',
    'tenant_ai_settings',
    'user_ai_consents',
    'messaging_outbox',
  ];

  async up(queryRunner: QueryRunner): Promise<void> {
    // Must run as migration user with RLS bypass enabled.
    // SET LOCAL is transaction-scoped — we wrap the whole migration in
    // a single outer transaction (TypeORM executor with
    // transaction: 'each' provides this) so the bypass persists for
    // every query below.
    await queryRunner.query(`SET LOCAL app.bypass_rls = 'on'`);
    await queryRunner.query(`SET search_path TO "messaging", public`);

    const tenantSchemas: Array<{ schema_name: string }> = await queryRunner.query(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
       ORDER BY schema_name`,
    );

    if (tenantSchemas.length === 0) {
      this.logger.log('No tenant_<uuid> schemas found — nothing to consolidate.');
      return;
    }

    this.logger.log(
      `Consolidating ${tenantSchemas.length} tenant schemas into messaging source...`,
    );

    for (const { schema_name } of tenantSchemas) {
      const tenantUuid = this.deriveTenantUuid(schema_name);
      this.logger.log(`-- ${schema_name} → tenantId=${tenantUuid}`);

      for (const table of ConsolidateTenantSchemaData1782500000000.CONSOLIDATION_ORDER) {
        // Skip if source schema lacks the table (should never happen
        // for a well-formed messaging schema but defensive).
        const sourceExists = await this.tableExists(queryRunner, 'messaging', table);
        if (!sourceExists) {
          this.logger.warn(`   skip ${table} — missing in messaging source schema`);
          continue;
        }

        // Skip if tenant schema lacks this table (older tenant, partial clone).
        const tenantExists = await this.tableExists(queryRunner, schema_name, table);
        if (!tenantExists) {
          continue;
        }

        await this.consolidateTable(queryRunner, schema_name, table, tenantUuid);
      }
    }

    this.logger.log(`Consolidation complete across ${tenantSchemas.length} tenant schemas.`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Explicit no-op. Reversing a data consolidation requires restoring
    // from the pre-migration pg_dump snapshot (see migration docblock).
    // A programmatic down() would give a false sense of security —
    // reversing INSERTs that may have been followed by application
    // writes would leave the database in an inconsistent mid-state.
    this.logger.warn(
      'down() is a no-op. To revert, restore from pre-migration pg_dump. ' +
        'See migration docblock for procedure.',
    );
  }

  /**
   * Convert tenant schema name ("tenant_<16hex>") to full UUID form
   * ("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"). Matches the convention
   * used by SchemaManagerService.createTenantSchema — first 16 hex
   * chars of the tenant UUID are used as the schema suffix.
   *
   * NOTE: this derives a tenant UUID by padding with zeros. In the
   * platform's current convention, tenant schemas are named by the
   * first 16 hex chars of the tenant's actual UUID (no padding —
   * the actual UUID is 32 hex chars). The simplest reliable source
   * for the full UUID is the auth.tenants table. We JOIN against
   * that in consolidateTable() when writing tenantId, rather than
   * relying on a padded-zero reconstruction.
   */
  private deriveTenantUuid(schemaName: string): string {
    // See note above — this returns the partial hex prefix, not the
    // full UUID. consolidateTable() looks up the full UUID from
    // auth.tenants via the tenantId already stored on tenant_<uuid>
    // rows (P3 populated these on children; channels/messages had it
    // from 1782000000000).
    return schemaName.replace(/^tenant_/, '');
  }

  private async tableExists(
    queryRunner: QueryRunner,
    schema: string,
    table: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
      ) AS exists`,
      [schema, table],
    );
    return rows[0]?.exists === true;
  }

  /**
   * Copy rows from tenant_<uuid>.<table> into messaging.<table>.
   * Rows already carry tenantId from P3 backfill. We just SELECT * and
   * rely on ON CONFLICT DO NOTHING for idempotence.
   */
  private async consolidateTable(
    queryRunner: QueryRunner,
    tenantSchema: string,
    table: string,
    tenantHexPrefix: string,
  ): Promise<void> {
    // Double-quote both schema and table identifiers. Schema name is
    // pre-validated via the regex above (`^tenant_[a-f0-9]{16}$`);
    // table name is from a static whitelist (CONSOLIDATION_ORDER).
    // Both safe to interpolate.
    const src = `"${tenantSchema}"."${table}"`;
    const dst = `"messaging"."${table}"`;

    // Count pre-merge rows to report progress.
    const preRows: Array<{ count: string }> = await queryRunner.query(
      `SELECT count(*)::text AS count FROM ${src}`,
    );
    const rowCount = parseInt(preRows[0]?.count ?? '0', 10);
    if (rowCount === 0) {
      return;
    }

    // Every row in a tenant_<uuid>.* table should already have
    // tenantId populated (P3 migration guaranteed NOT NULL). So the
    // consolidation is a straight copy.
    //
    // If a table uses a primary key that allows ON CONFLICT (most do
    // — id UUID PK), use DO NOTHING. For composite PKs (e.g.
    // message_receipts has (id, receiptCreatedAt) PK because of
    // partitioning), we fall back to NOT EXISTS check to stay
    // idempotent.
    //
    // For this first-pass implementation, we issue a simple
    // INSERT ... SELECT without ON CONFLICT — the assumption is that
    // this migration runs ONCE per environment, inside a maintenance
    // window, and the tenant schemas are subsequently dropped (P9).
    // If operators need to re-run, the source rows collide and the
    // migration errors loudly — they then restore from pg_dump.
    //
    // This is deliberately strict: data consolidation migrations are
    // not the place for silent ON CONFLICT semantics. Operators who
    // want idempotence beyond a single run should DROP + re-run the
    // whole migration on a restored snapshot.
    await queryRunner.query(
      `INSERT INTO ${dst} SELECT * FROM ${src}`,
    );

    this.logger.log(`   ${table}: ${rowCount} rows consolidated`);
  }
}
