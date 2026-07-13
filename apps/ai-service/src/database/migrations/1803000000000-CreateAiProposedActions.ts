import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MOB-HIGH-001 — human-in-the-loop actuation proposals (the "Faz 6" flow).
 *
 * Creates the per-tenant TEMPLATE table `ai.ai_proposed_actions` (cloned into
 * every tenant_<uuid> schema by TenantSchemaSyncService via
 * MODULE_SCHEMAS['ai'].tables). A held `requiresConfirmation` tool call is
 * persisted here with the ORIGINAL requester's authorization context; the
 * confirm path executes the stored row, never client-supplied params.
 *
 * TENANT_AWARE_SOURCE_SCHEMA_DDL_OK: the `"ai"."ai_proposed_actions"` DDL is the
 * intentional per-tenant TEMPLATE created in the `ai` SOURCE schema — the exact
 * pattern the 1800000000000-Baseline uses for `agent_conversations` /
 * `tenant_agent_configs`. TenantSchemaSyncService clones it into every
 * tenant_<uuid> schema (registered in MODULE_SCHEMAS['ai'].tables), so the
 * source-schema-qualified DDL is correct, not a tenant-routing bypass.
 */
export class CreateAiProposedActions1803000000000 implements MigrationInterface {
  name = 'CreateAiProposedActions1803000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "ai"."ai_proposed_actions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "toolName" character varying(100) NOT NULL,
        "params" jsonb NOT NULL,
        "description" text NOT NULL,
        "requestedBy" uuid NOT NULL,
        "requesterRoles" jsonb NOT NULL,
        "persona" character varying(50) NOT NULL,
        "correlationId" character varying(100),
        "status" character varying(20) NOT NULL DEFAULT 'proposed',
        "result" text,
        "confirmedBy" uuid,
        "executedAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_proposed_actions" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_proposed_actions_tenant_status" ON "ai"."ai_proposed_actions" ("tenantId", "status", "createdAt")`,
    );

    // RLS: same canonical tenant predicate the baseline applied schema-wide —
    // re-running is idempotent and picks up the new table.
    await applyTenantRlsToSchema(queryRunner, {
      tenantIdColumns: ['tenant_id', 'tenantId'],
      excludeTables: [],
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ai"."IDX_ai_proposed_actions_tenant_status"`);
    // DESTRUCTIVE: down()-only rollback of CreateAiProposedActions1803000000000 —
    // drops the ai.ai_proposed_actions template table this same migration created
    // (no production data depends on it pre-merge; it is the migration's own
    // inverse). Forward recreate path is re-running up(), not a separate rollback.
    await queryRunner.query(`DROP TABLE IF EXISTS "ai"."ai_proposed_actions"`);
  }
}
