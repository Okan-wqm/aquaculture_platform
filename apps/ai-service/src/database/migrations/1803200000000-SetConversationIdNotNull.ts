import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Align ai.conversation_turns.conversationId with the entity's NOT NULL
 * declaration. The live database has the column nullable (out-of-band DDL
 * drift); the creating migration always declared it NOT NULL, so this heal
 * repairs the drift and fans out to tenant clones via current_schema().
 *
 * UNQUALIFIED on purpose: a schema-qualified table reference only touches
 * the source template and leaves already-provisioned tenants without the
 * fix (the anti-pattern documented in CreateConversationTurns' own
 * docblock and healed the same way by 1803100000000).
 */
export class SetConversationIdNotNull1803200000000 implements MigrationInterface {
  name = 'SetConversationIdNotNull1803200000000';

  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'conversation_turns'
            AND column_name = 'conversationId'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "conversation_turns" ALTER COLUMN "conversationId" SET NOT NULL;
        END IF;
      END $$;
    `);
  }
  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'conversation_turns'
            AND column_name = 'conversationId'
            AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE "conversation_turns" ALTER COLUMN "conversationId" DROP NOT NULL;
        END IF;
      END $$;
    `);
  }
}
