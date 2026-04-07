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
 * Closes NEW-H1 for the auth schema. Companion to
 * `ConvertTimestampToTimestamptz1781100000000` (commit 6e419f3d) which
 * converted columns declared with **explicit** `type: 'timestamp'` but
 * left bare `@CreateDateColumn()` / `@UpdateDateColumn()` columns
 * untouched. The TypeORM postgres driver default for those decorators
 * is `'timestamp'` (without time zone) — confirmed in the source:
 *
 *     // node_modules/typeorm/.../driver/postgres/PostgresDriver.js:170
 *     createDate: "timestamp",
 *
 * Phase B audit found 15 entity files in auth-service still using bare
 * decorators. This migration handles all of them via dynamic discovery
 * — no per-table list to maintain when new entities are added.
 *
 * # Why this is critical for auth-service
 *
 * `users.createdAt`, `users.updatedAt`, `refresh_tokens.createdAt`,
 * `audit_logs.createdAt`, etc. are the foundation of the security
 * audit trail. A ±1h drift on any of these:
 *
 *   - Misaligns failed-login windows used for rate limiting
 *   - Corrupts incident timeline reconstruction
 *   - Produces compliance findings on access reviews
 *
 * Auth-service is the highest-priority surface for the NEW-H1 fix
 * because every other service trusts auth's timestamps as the source
 * of truth for "when did the user do X".
 *
 * # Runtime semantics
 *
 * Helper uses `USING "<col>" AT TIME ZONE 'UTC'` which interprets
 * existing wall-clock values as UTC instants. Safe on our UTC-pinned
 * container fleet — see the C-1 migration docblock for the full
 * derivation. Migration logs the session `TimeZone` GUC at the start
 * as an audit artefact.
 *
 * # Idempotency
 *
 * The helper's discovery query filters on `data_type = 'timestamp
 * without time zone'`, so already-converted columns are skipped at
 * the database level. Re-running the migration on an environment
 * that has already applied it is a no-op.
 *
 * # Locking
 *
 * `ALTER COLUMN ... TYPE TIMESTAMPTZ` rewrites the table. Auth tables
 * are small (`users` ~10K rows worst case), so cumulative lock time
 * is sub-10-seconds. The migration logs per-table progress so
 * operators can correlate the lock window with each table's downtime
 * impact.
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
