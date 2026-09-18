import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Align ai.conversation_turns.conversationId with the entity's NOT NULL
 * declaration — the schema drift validator blocks service boot when the DB
 * column is nullable but the entity requires it.
 */
export class SetConversationIdNotNull1803200000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'ai'
            AND table_name = 'conversation_turns'
            AND column_name = 'conversationId'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "ai"."conversation_turns" ALTER COLUMN "conversationId" SET NOT NULL;
        END IF;
      END $$;
    `);
  }
  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'ai'
            AND table_name = 'conversation_turns'
            AND column_name = 'conversationId'
            AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE "ai"."conversation_turns" ALTER COLUMN "conversationId" DROP NOT NULL;
        END IF;
      END $$;
    `);
  }
}
