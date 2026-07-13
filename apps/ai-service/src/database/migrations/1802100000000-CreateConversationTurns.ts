import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateConversationTurns1802100000000 — durable per-invocation AI cost
 * ledger (DB-PEOPLE-MEDIUM-002 / ORPHAN-MEDIUM-380).
 *
 * WHY: AI cost tracking had no durable record — enforcement rode the
 * ephemeral Redis counter (ai:tokens:{tenant}:{YYYY-MM}) and the mutable
 * aggregate agent_conversations.totalTokens. This table is the append-only
 * per-turn ledger the layer-1-ai SSoT specifies: one row per completed agent
 * invocation with the four token classes and the cost-weighted USD figure.
 *
 * PER-TENANT PATTERN: `conversation_turns` is a per-tenant cloned table
 * (declared in MODULE_SCHEMAS['ai'].tables — schema-manager.service.ts). The
 * migration runner pins search_path to `ai` (the source template) and then
 * to each `tenant_<uuid>` schema, running this migration once per schema —
 * so the table name MUST be UNQUALIFIED (resolved against current_schema()).
 * Schema-qualifying it as "ai"."conversation_turns" would only ever touch
 * the source template and leave already-provisioned tenants without the
 * table. Mirrors the ai precedent 1802000000000-AddByokTenantAiCredentials
 * and the farm precedent 1802700000000-CreateLiceCounts.
 *
 * current_schema-relative (ai + every tenant_<uuid>), idempotent,
 * forward-only, blue-green safe (purely additive). Append-only enforcement
 * lives at the service layer (TurnLedgerService exposes no update/delete);
 * RLS is installed by RlsModule.forPoolService('ai') on the standard
 * tenantId predicate.
 */
export class CreateConversationTurns1802100000000 implements MigrationInterface {
  name = 'CreateConversationTurns1802100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "conversation_turns" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "conversationId" uuid NOT NULL,
        "personaId" character varying(50),
        "model" character varying(64) NOT NULL,
        "inputTokens" integer NOT NULL DEFAULT 0,
        "outputTokens" integer NOT NULL DEFAULT 0,
        "cacheReadTokens" integer NOT NULL DEFAULT 0,
        "cacheCreationTokens" integer NOT NULL DEFAULT 0,
        "costUsd" numeric(12,6) NOT NULL,
        "flaggedCategories" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversation_turns" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_conversation_turns_tenant_created"
        ON "conversation_turns" ("tenantId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_conversation_turns_tenant_conversation"
        ON "conversation_turns" ("tenantId", "conversationId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`DROP TABLE IF EXISTS "conversation_turns"`);
  }
}
