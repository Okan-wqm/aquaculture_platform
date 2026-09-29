/**
 * K7 / K10 (PR-T1, V-T1b-6): `ai.tool_execution_audit` keeps a fingerprint of
 * each tool output (sha256 + byte size) instead of the output itself.
 *
 * WHY: the table is cross-tenant (schema `ai`, MODULE_SCHEMAS['ai']
 * .infrastructureTables); tool outputs are tenant business data. New rows
 * leave the legacy `output` column NULL and fill the two new columns.
 *
 * Blue-green safe: two NULLABLE columns, added idempotently; the previous
 * code ignores them. The table is qualified because it is cross-tenant (it
 * lives only in `ai`), so a per-schema replay of this migration is a no-op.
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class ToolAuditOutputFingerprint1803400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai"."tool_execution_audit" ADD COLUMN IF NOT EXISTS "outputSha256" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "ai"."tool_execution_audit" ADD COLUMN IF NOT EXISTS "outputBytes" integer`,
    );
  }

  public async down(): Promise<void> {
    // Forward-only: `ai.tool_execution_audit` is a protected append-only audit
    // trail (libs/backend-common/src/constants/protected-tables.ts), whose
    // columns are never dropped. The two nullable columns are ignored by the
    // previous code, so a rollback of the service needs no schema change.
  }
}
