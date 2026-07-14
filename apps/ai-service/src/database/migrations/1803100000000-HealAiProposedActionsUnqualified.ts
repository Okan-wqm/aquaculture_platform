import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ORPHAN-HIGH-408 heal — `ai_proposed_actions` never reached tenant schemas.
 *
 * The prior migration 1803000000000-CreateAiProposedActions wrote the per-tenant
 * table with a SCHEMA-QUALIFIED name (`"ai"."ai_proposed_actions"`). Per-tenant
 * migrations are REPLAYED into each `tenant_<uuid>` schema with `search_path`
 * pinned and NO SQL text-rewrite, so the qualified `"ai".` targeted the SOURCE
 * schema on every pass: the source got the table, `IF NOT EXISTS` no-oped in
 * every tenant pass, and every existing tenant schema was left WITHOUT the
 * table. It failed safe at deploy (no abort), masked only because ai-service is
 * dormant — but the moment ai activates, the MOB-HIGH-001 confirm flow hits
 * `relation "ai_proposed_actions" does not exist` per tenant.
 *
 * That migration is immutable (already applied against the source schema), so
 * this forward-only heal creates the table UNQUALIFIED — the replay then lands
 * it in every tenant schema that missed it (and no-ops where it exists). It
 * also corrects the audit timestamps to `timestamptz` (the original used naive
 * `TIMESTAMP`, unlike the sibling CreateConversationTurns) wherever the table
 * pre-existed with the naive type. Must land BEFORE ai-service deploy
 * activation.
 */
export class HealAiProposedActionsUnqualified1803100000000 implements MigrationInterface {
  name = 'HealAiProposedActionsUnqualified1803100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // UNQUALIFIED — resolves against current_schema(), so the replay creates it
    // in each tenant_<uuid> schema (and the source `ai`) that lacks it.
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "ai_proposed_actions" (
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
        "executedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_proposed_actions" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ai_proposed_actions_tenant_status" ON "ai_proposed_actions" ("tenantId", "status", "createdAt")`,
    );

    // Correct the source schema's pre-existing naive TIMESTAMP columns (the
    // heal CREATE above no-ops there). Type-guarded so it only fires where the
    // column is still `timestamp without time zone` — a no-op on the already-
    // timestamptz tenant tables this migration just created.
    await queryRunner.query(`
      DO $$
      DECLARE
        col TEXT;
      BEGIN
        FOREACH col IN ARRAY ARRAY['executedAt', 'createdAt', 'updatedAt']
        LOOP
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'ai_proposed_actions'
              AND column_name = col
              AND data_type = 'timestamp without time zone'
          ) THEN
            EXECUTE format(
              'ALTER TABLE "ai_proposed_actions" ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''UTC''',
              col, col
            );
          END IF;
        END LOOP;
      END
      $$;
    `);

    // RLS: idempotent re-apply picks up the (now present) table in this schema.
    await applyTenantRlsToSchema(queryRunner, {
      tenantIdColumns: ['tenant_id', 'tenantId'],
      excludeTables: [],
    });
  }

  public async down(): Promise<void> {
    // Forward-only heal — the table's create/drop lifecycle is owned by
    // 1803000000000-CreateAiProposedActions. Undoing this heal would re-open
    // the tenant data-loss it fixes, so down() is intentionally a no-op.
  }
}
