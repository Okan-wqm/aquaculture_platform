import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * CreateInitialSchema1700000000000
 * ============================================================================
 *
 * Baseline migration for the ai-service. Until Wave 4-A.2 of the
 * 2026-05-07 bootstrap-restoration plan, ai-service had:
 *
 *   - 3 entities (`AgentConversation`, `TenantAgentConfig`,
 *     `ToolExecutionAudit`) declared in source,
 *   - an `AiMigrationRunnerService` wired in `app.module.ts`,
 *   - and a `database/migrations/` directory containing only `.gitkeep`.
 *
 * On a fresh-volume bootstrap (no init scripts seeding `ai.*` tables),
 * service boot would surface as `SourceSchemaBootstrapService` hard-fail:
 * the `ai` schema would either be empty (→ INFRA-CRITICAL-009 message) or,
 * if a partial init had run, missing 3/3 declared tables. Either way the
 * service crash-loops with no DDL pathway.
 *
 * # Scope
 *
 *   1. `CREATE SCHEMA IF NOT EXISTS ai` — defensive guard for direct
 *      CLI runs against a bare database. Container-managed deploys have
 *      this created by `infrastructure/docker/init-scripts/00-init-schemas.sh`,
 *      but the migration is the SSoT and must be runnable on its own.
 *   2. Three tables, idempotent via `CREATE TABLE IF NOT EXISTS`:
 *        - `agent_conversations`     (per-tenant, unqualified)
 *        - `tenant_agent_configs`    (per-tenant, unqualified)
 *        - `ai.tool_execution_audit` (cross-tenant, schema-qualified)
 *
 * # Per-tenant vs cross-tenant routing
 *
 * `agent_conversations` and `tenant_agent_configs` are PER-TENANT. The
 * post-Phase-1 entity decorator does NOT declare `schema:` on them, so
 * TypeORM at runtime resolves the table via the connection's search_path
 * (`tenant_<uuid>`,`ai`,`public`). The migration creates them in the source
 * schema (`ai`) using UNQUALIFIED `CREATE TABLE` statements, which the
 * connection's search_path resolves to `ai.*` because this migration runs
 * with `schema: 'ai'` in the data-source. `TenantSchemaSyncService` then
 * clones each table into every `tenant_<uuid>` schema at tenant onboarding
 * via `CREATE TABLE LIKE INCLUDING ALL`.
 *
 * `tool_execution_audit` is CROSS-TENANT — the audit log spans all tenants
 * by design (operator triage of cross-tenant tool-call patterns,
 * RoutineActuationGuard analytics). The entity declares
 * `@Entity('tool_execution_audit', { schema: 'ai' })`, so the migration
 * uses the SCHEMA-QUALIFIED form `CREATE TABLE IF NOT EXISTS ai.tool_execution_audit`
 * to make the cross-tenant placement explicit and immune to search_path
 * surprises during tenant-context middleware misconfiguration.
 *
 * # Idempotency
 *
 * Every DDL statement uses `IF NOT EXISTS` (schema, tables, indexes). A
 * second run is a no-op. This matches the pattern from auth-service's
 * baseline migration (`1700000000000-CreateInitialSchema.ts`) — see that
 * file's docblock for the rationale (init-script overlap, retry safety).
 *
 * # R3 chunking (migration-sql-lint)
 *
 * Each `CREATE TABLE` is bundled with its sibling `CREATE INDEX`
 * statements in a single `queryRunner.query` call. The
 * `migration-sql-lint` R3 rule (no `CREATE INDEX` without
 * `CONCURRENTLY` against an existing live table) recognises the
 * just-created-table exemption when a sibling `CREATE TABLE` is present
 * in the same SQL chunk; splitting them across multiple `query()` calls
 * would surface false-positive lint failures.
 *
 * # Why TIMESTAMPTZ
 *
 * Consistent with the platform-wide invariant: every `@CreateDateColumn`
 * / `@UpdateDateColumn` resolves to TIMESTAMPTZ. Creating columns as
 * TIMESTAMPTZ from birth keeps the later `ConvertAuditColumnsToTimestamptz`
 * runtime helper a no-op for this schema.
 *
 * Closes: docs/plans/bootstrap-restoration-and-factory-reset-2026-05-07.md
 */
export class CreateInitialSchema1700000000000 implements MigrationInterface {
  name = 'CreateInitialSchema1700000000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Creating baseline ai.* schema: 2 per-tenant template tables ' +
        '(agent_conversations, tenant_agent_configs) and 1 cross-tenant ' +
        'audit table (tool_execution_audit).',
    );

    // The `ai` schema is normally created by infrastructure/docker/init-scripts.
    // Defensive guard for direct CLI runs against a bare database — no-op
    // when the schema already exists.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS ai`);

    await this.createAgentConversationsTable(queryRunner);
    await this.createTenantAgentConfigsTable(queryRunner);
    await this.createToolExecutionAuditTable(queryRunner);

    this.logger.log('Baseline ai schema initialised.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Reverting baseline ai.* tables. This is destructive and is intended ' +
        'for ephemeral test environments only — production rollback should ' +
        'never invoke down() on a baseline migration.',
    );

    // Reverse FK order — there are no inter-table FKs in this baseline,
    // so the order is purely conventional (LIFO of the up() sequence).
    await queryRunner.query(
      `DROP TABLE IF EXISTS ai."tool_execution_audit" CASCADE`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS ai."tenant_agent_configs" CASCADE`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS ai."agent_conversations" CASCADE`,
    );
  }

  /**
   * ai.agent_conversations — conversation/conversation.entity.ts
   *
   * Per-tenant entity (NO `schema:` on the @Entity decorator). The
   * unqualified `CREATE TABLE` resolves to `ai.agent_conversations`
   * because the migration runs with `schema: 'ai'` set in the data
   * source. `TenantSchemaSyncService` clones this template into every
   * `tenant_<uuid>` schema at provisioning.
   *
   * Index `IDX_agent_conversations_tenant_user_createdAt` mirrors the
   * `@Index(['tenantId', 'userId', 'createdAt'])` decorator and supports
   * the conversation-list-by-user query path.
   */
  private async createAgentConversationsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling index bundled in one chunk per
    // migration-sql-lint R3 (just-created-table exemption).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS agent_conversations (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "persona" varchar(50) NOT NULL,
        "messages" jsonb NOT NULL,
        "title" varchar(255),
        "totalTokens" integer NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_agent_conversations_tenant_user_createdAt"
        ON agent_conversations ("tenantId", "userId", "createdAt");
    `);
  }

  /**
   * ai.tenant_agent_configs — tenant-config/agent-config.entity.ts
   *
   * Per-tenant entity. UNIQUE on `tenantId` enforces the invariant that
   * each tenant has exactly one agent config row (the entity declares
   * `@Index(['tenantId'], { unique: true })`). The constraint is
   * implemented as a UNIQUE INDEX so it survives the
   * `CREATE TABLE LIKE INCLUDING ALL` clone path used for tenant
   * provisioning (LIKE INCLUDING INDEXES copies indexes; UNIQUE INDEX
   * is recreated as a UNIQUE INDEX in the destination schema).
   *
   * Defaults align exactly with the entity decorators so a fresh row
   * does not require a backfill step:
   *   - `additionalToolNames` / `blockedToolNames` / `mcpAllowedPersonas`
   *     default to '[]'::jsonb (empty list)
   *   - `applicableRoles` defaults to '["operator"]'::jsonb
   *   - cost-control numerics default to entity-declared budgets
   */
  private async createTenantAgentConfigsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling unique index bundled per R3.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tenant_agent_configs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "baseProfileId" varchar(50) NOT NULL DEFAULT 'operator-v1',
        "additionalToolNames" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "blockedToolNames" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "actuationPolicy" varchar(50) NOT NULL DEFAULT 'confirm_required',
        "customSystemPrompt" text,
        "applicableRoles" jsonb NOT NULL DEFAULT '["operator"]'::jsonb,
        "isEnabled" boolean NOT NULL DEFAULT true,
        "proactiveMonitoringEnabled" boolean NOT NULL DEFAULT false,
        "autonomousActionsEnabled" boolean NOT NULL DEFAULT false,
        "autonomousSafetyLimits" jsonb,
        "monthlyTokenBudget" integer NOT NULL DEFAULT 1000000,
        "hourlyRequestLimit" integer NOT NULL DEFAULT 60,
        "mcpEnabled" boolean NOT NULL DEFAULT false,
        "mcpAllowedPersonas" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_agent_configs_tenantId"
        ON tenant_agent_configs ("tenantId");
    `);
  }

  /**
   * ai.tool_execution_audit — audit/tool-execution-audit.entity.ts
   *
   * CROSS-TENANT entity (the @Entity decorator declares
   * `{ schema: 'ai' }`). This table is NOT cloned per-tenant — every
   * tool-call audit row across the platform lands in this single
   * `ai.tool_execution_audit` table, partitioned logically by the
   * `tenantId` column for downstream filtering.
   *
   * Schema-qualified `CREATE TABLE IF NOT EXISTS ai.tool_execution_audit`
   * makes the cross-tenant placement explicit; a tenant-context
   * middleware misroute that swapped search_path to a `tenant_<uuid>`
   * schema mid-migration would still land the table in `ai` rather than
   * silently cloning it into a tenant schema.
   *
   * The `executed_at` column carries a snake_case `name:` override on
   * the entity (CreateDateColumn name: 'executed_at') — preserved here
   * verbatim so the schema-drift validator's introspection sees the
   * declared column name match the live one.
   *
   * Indexes mirror the entity's two `@Index` decorators:
   *   - (tenantId, executedAt) — per-tenant audit pagination
   *   - (toolName, executedAt) — cross-tenant tool-usage analytics
   */
  private async createToolExecutionAuditTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ai.tool_execution_audit (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "toolName" varchar(100) NOT NULL,
        "persona" varchar(50) NOT NULL,
        "input" jsonb NOT NULL,
        "success" boolean NOT NULL,
        "output" jsonb,
        "errorMessage" text,
        "durationMs" integer NOT NULL,
        "correlationId" varchar(100),
        "conversationId" uuid,
        "executed_at" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_tool_execution_audit_tenant_executedAt"
        ON ai.tool_execution_audit ("tenantId", "executed_at");
      CREATE INDEX IF NOT EXISTS "IDX_tool_execution_audit_toolName_executedAt"
        ON ai.tool_execution_audit ("toolName", "executed_at");
    `);
  }
}
