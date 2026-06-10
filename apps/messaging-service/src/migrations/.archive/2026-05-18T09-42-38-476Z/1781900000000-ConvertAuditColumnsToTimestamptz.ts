import { MigrationInterface, QueryRunner } from 'typeorm';
import { convertAuditColumnsToTimestamptz, revertAuditColumnsToTimestamp, MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * ConvertAuditColumnsToTimestamptz1781900000000
 * ============================================================================
 *
 * NEW-H1 fix for the messaging schema. Phase B audit showed
 * messaging-service uses ALL typed `@CreateDateColumn({ type:
 * 'timestamptz' })` decorators (14 typed, 0 bare), so this migration
 * is expected to find ZERO columns to convert in the messaging source
 * schema.
 *
 * It is included for two reasons:
 *
 *   1. **Defense against future regression**: if a developer adds a
 *      new entity with a bare `@CreateDateColumn()` and the helper's
 *      idempotent guard catches it on the next deploy.
 *
 *   2. **Tenant schema consistency**: messaging is schema-per-tenant,
 *      and tenant_<uuid> schemas are CREATE TABLE LIKE copies of the
 *      source. If the source ever drifts to bare decorators, the
 *      tenant copies inherit the issue. This migration runs only on
 *      the source schema (current_schema during migration runner
 *      context); a future companion service could iterate tenant
 *      schemas if needed (mirroring TenantRlsSyncService).
 *
 * Excludes outbox tables from the conversion in line with the rest of
 * the hardening migrations.
 */
export class ConvertAuditColumnsToTimestamptz1781900000000
  implements MigrationInterface
{
  name = 'ConvertAuditColumnsToTimestamptz1781900000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await convertAuditColumnsToTimestamptz(queryRunner, {
      excludeTables: ['messaging_outbox'],
      logger: this.logger,
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await revertAuditColumnsToTimestamp(queryRunner, {
      excludeTables: ['messaging_outbox'],
      logger: this.logger,
    });
  }
}
