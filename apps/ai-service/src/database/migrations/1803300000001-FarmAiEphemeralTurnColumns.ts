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
 * NOT EXISTS; the ALTER COLUMN DROP NOT NULL is guarded by an
 * information_schema pre-check so a replay is an explicit no-op.
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
    // Guarded (R10): only relax the constraint when the column is still NOT
    // NULL in THIS schema, so a replay is an explicit no-op rather than a
    // silent one.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = '${TABLE}'
            AND column_name = 'conversationId'
            AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE "${TABLE}" ALTER COLUMN "conversationId" DROP NOT NULL;
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-tightening NOT NULL would fail while ephemeral rows exist — the down
    // path first disclaims them (they are cost evidence, but the column set
    // is being reverted, so the rows cannot keep their shape).
    await queryRunner.query(`DELETE FROM "${TABLE}" WHERE "conversationId" IS NULL`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = '${TABLE}'
            AND column_name = 'conversationId'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "${TABLE}" ALTER COLUMN "conversationId" SET NOT NULL;
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "servicePrincipal"`);
    await queryRunner.query(`ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "correlationId"`);
  }
}
