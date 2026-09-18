/**
 * FARM-AI Sprint 1.2 (2026-09-18): `conversation_turns` support for EPHEMERAL
 * runs — service-driven narratives / routine turns that persist NO
 * conversation.
 *
 *   - `conversationId` becomes NULLABLE: an ephemeral turn has no
 *     agent_conversations row. User-chat turns keep the conversation pointer;
 *     existing rows are untouched.
 *   - new `correlationId` varchar(64) + `servicePrincipal` varchar(100): the
 *     caller-traceable key + declared calling service a machine-driven ledger
 *     row keys on instead of a conversation.
 *
 * The table name is UNQUALIFIED on purpose: `conversation_turns` is a
 * per-tenant cloned table (MODULE_SCHEMAS['ai'].tables — see
 * 1802100000000-CreateConversationTurns), so the migration runs once per
 * schema and must resolve against current_schema(). Idempotent ADD COLUMN IF
 * EXISTS; the ALTER COLUMN DROP NOT NULL is a no-op when already nullable.
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'conversation_turns';

export class FarmAiEphemeralTurnColumns1803300000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "correlationId" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "servicePrincipal" varchar(100)`,
    );
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" ALTER COLUMN "conversationId" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-tightening NOT NULL would fail while ephemeral rows exist — the down
    // path first disclaims them (they are cost evidence, but the column set
    // is being reverted, so the rows cannot keep their shape).
    await queryRunner.query(`DELETE FROM "${TABLE}" WHERE "conversationId" IS NULL`);
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" ALTER COLUMN "conversationId" SET NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "servicePrincipal"`);
    await queryRunner.query(`ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "correlationId"`);
  }
}
