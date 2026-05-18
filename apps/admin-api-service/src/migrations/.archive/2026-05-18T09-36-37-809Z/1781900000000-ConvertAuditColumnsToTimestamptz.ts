import { MigrationInterface, QueryRunner } from 'typeorm';
import { convertAuditColumnsToTimestamptz, revertAuditColumnsToTimestamp, MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * ConvertAuditColumnsToTimestamptz1781900000000
 * ============================================================================
 *
 * NEW-H1 fix for the admin schema. Companion to
 * `ConvertTimestampToTimestamptz1781500000000` (commit e6dacca4) which
 * converted explicit `type: 'timestamp'` columns. This migration handles
 * the bare `@CreateDateColumn()` / `@UpdateDateColumn()` decorators
 * that the Phase 2b sweep missed (TypeORM postgres default is
 * `'timestamp without time zone'` for these decorators).
 *
 * Phase B audit found 26 entity files in admin-api with bare
 * decorators — the largest single-service surface for this fix. The
 * helper uses dynamic discovery so the entity inventory is not
 * hard-coded.
 *
 * # Compliance criticality
 *
 * admin schema audit columns drive incident response timing,
 * compliance reports, GDPR data request SLAs, and impersonation
 * audit trails. A ±1h drift on `security_incidents.createdAt`,
 * `data_requests.updatedAt`, or `impersonation_session.startedAt`
 * is a forensic blocker.
 *
 * See `ConvertAuditColumnsToTimestamptz1781900000000` in
 * apps/auth-service for the full design notes; the auth-service
 * version is the canonical reference and the implementation here is
 * a one-line delegation to the shared helper.
 */
export class ConvertAuditColumnsToTimestamptz1781900000000
  implements MigrationInterface
{
  name = 'ConvertAuditColumnsToTimestamptz1781900000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await convertAuditColumnsToTimestamptz(queryRunner, {
      logger: this.logger,
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await revertAuditColumnsToTimestamp(queryRunner, {
      logger: this.logger,
    });
  }
}
