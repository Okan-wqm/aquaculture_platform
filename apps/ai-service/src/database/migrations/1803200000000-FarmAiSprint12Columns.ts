/**
 * FARM-AI Sprint 1.2 schema changes:
 *
 * 1. tenant_agent_configs.routineAiEnabled (boolean NOT NULL DEFAULT false)
 *    — tenant opt-in for the routine orchestrator (Faz 5). Ships OFF:
 *    nothing machine-driven runs until the tenant turns it on. The
 *    orchestrator in Faz 5 will be the first reader.
 *
 * 2. conversation_turns: conversationId NULLABLE + new correlationId /
 *    servicePrincipal columns — ephemeral runs (service-driven narratives,
 *    routine turns) persist NO conversation; their cost-ledger row keys on
 *    the correlation id + declared calling service instead. User-chat turns
 *    keep the conversation pointer; existing rows are untouched.
 *
 * Unqualified DDL on purpose: db-migrate runs this migration once per schema
 * (source `ai` + every tenant clone — both tables are in the schema-manager's
 * tenant tables set). Idempotent (IF [NOT] EXISTS) so a re-run is a no-op.
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class FarmAiSprint12Columns1803200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenant_agent_configs"
       ADD COLUMN IF NOT EXISTS "routineAiEnabled" boolean NOT NULL DEFAULT false`,
    );

    await queryRunner.query(
      `ALTER TABLE "conversation_turns"
       ADD COLUMN IF NOT EXISTS "correlationId" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_turns"
       ADD COLUMN IF NOT EXISTS "servicePrincipal" varchar(100)`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_turns"
       ALTER COLUMN "conversationId" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-tightening NOT NULL would fail while ephemeral rows exist — the down
    // path first disclaims them (they are cost evidence, but the column set
    // is being reverted, so the rows cannot keep their shape).
    await queryRunner.query(
      `DELETE FROM "conversation_turns" WHERE "conversationId" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_turns"
       ALTER COLUMN "conversationId" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_turns" DROP COLUMN IF EXISTS "servicePrincipal"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_turns" DROP COLUMN IF EXISTS "correlationId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_agent_configs" DROP COLUMN IF NOT EXISTS "routineAiEnabled"`,
    );
  }
}
