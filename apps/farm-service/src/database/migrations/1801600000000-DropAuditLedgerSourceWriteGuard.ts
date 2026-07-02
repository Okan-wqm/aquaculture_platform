import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop the source-write guard wrongly installed on the cross-tenant audit ledger.
 *
 * WHY: a `guard_source_write` BEFORE-trigger (function `farm.block_source_writes()`,
 * ERRCODE P0999) was installed on `farm.farm_audit_logs`. That table is CROSS-TENANT
 * infrastructure (source schema, tenantId-stamped, RLS-protected) — exactly like
 * `farm.outbox_events`, which is correctly unguarded. Every create/update command
 * handler writes an audit row there, so the guard rejected the INSERT
 * (`TENANT_ISOLATION_VIOLATION: Direct write to source schema farm.farm_audit_logs`)
 * and broke ALL farm mutations behind a masked "Bad Request". The guard belongs ONLY
 * on per-tenant DATA tables (which must be written via the tenant schema); it must not
 * sit on cross-tenant infrastructure ledgers.
 *
 * WHAT: drop the trigger idempotently. It is legacy drift — no current migration
 * creates it — so `down` is a deliberate no-op (re-installing it would re-break farm
 * writes, and there is no canonical definition to restore).
 */
@SourceOnlyMigration({
  reason:
    'farm_audit_logs is a cross-tenant infrastructure ledger (source schema, tenantId-stamped, RLS-protected); the source-write guard must not block its INSERTs',
})
export class DropAuditLedgerSourceWriteGuard1801600000000 implements MigrationInterface {
  name = 'DropAuditLedgerSourceWriteGuard1801600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER IF EXISTS guard_source_write ON "farm"."farm_audit_logs"');
  }

  async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentional no-op: re-installing a tenant-isolation guard on a cross-tenant audit
    // ledger would re-break every farm mutation, and the guard was never created by a
    // managed migration, so there is no canonical definition to restore.
    await Promise.resolve();
  }
}
