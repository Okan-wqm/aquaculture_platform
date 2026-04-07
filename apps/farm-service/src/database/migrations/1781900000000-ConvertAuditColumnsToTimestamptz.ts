import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  convertAuditColumnsToTimestamptz,
  revertAuditColumnsToTimestamp,
  MigrationLogger,
} from '@aquaculture/backend-common';

/**
 * ConvertAuditColumnsToTimestamptz1781900000000
 * ============================================================================
 *
 * NEW-H1 fix for the farm schema. farm-service mostly uses BaseEntity
 * with explicit `@CreateDateColumn({ type: 'timestamptz', name:
 * 'created_at' })` so the audit-column blind spot is small here (4
 * entity files), but they still need conversion for consistency.
 *
 * Helper uses dynamic discovery — it picks up both snake_case
 * (`created_at`, `updated_at`) and camelCase (`createdAt`, `updatedAt`)
 * audit columns, so legacy entities that bypass BaseEntity are also
 * caught.
 *
 * Excludes `farm_outbox`, `audit_logs`, `audit_log` because the same
 * tables are excluded from the RLS migration — they are deliberately
 * cross-tenant and read by background workers. The audit-column
 * conversion is still safe to apply to them, but we keep the exclusion
 * lists in lockstep across all hardening migrations for consistency.
 *
 * See the auth-service variant for the full design notes; this is a
 * thin delegation.
 */
export class ConvertAuditColumnsToTimestamptz1781900000000
  implements MigrationInterface
{
  name = 'ConvertAuditColumnsToTimestamptz1781900000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await convertAuditColumnsToTimestamptz(queryRunner, {
      excludeTables: ['farm_outbox', 'audit_logs', 'audit_log'],
      logger: this.logger,
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await revertAuditColumnsToTimestamp(queryRunner, {
      excludeTables: ['farm_outbox', 'audit_logs', 'audit_log'],
      logger: this.logger,
    });
  }
}
