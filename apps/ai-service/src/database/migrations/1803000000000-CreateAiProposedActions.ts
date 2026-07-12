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
 */
export class CreateAiProposedActions1803000000000 implements MigrationInterface {
  name = 'CreateAiProposedActions1803000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai"."ai_proposed_actions" (
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
      `CREATE INDEX "IDX_ai_proposed_actions_tenant_status" ON "ai"."ai_proposed_actions" ("tenantId", "status", "createdAt")`,
    );

    // RLS: same canonical tenant predicate the baseline applied schema-wide —
    // re-running is idempotent and picks up the new table.
    await applyTenantRlsToSchema(queryRunner, {
      tenantIdColumns: ['tenant_id', 'tenantId'],
      excludeTables: [],
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "ai"."IDX_ai_proposed_actions_tenant_status"`);
    await queryRunner.query(`DROP TABLE "ai"."ai_proposed_actions"`);
  }
}
