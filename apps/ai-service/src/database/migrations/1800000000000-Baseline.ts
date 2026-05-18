import { MigrationInterface, QueryRunner } from "typeorm";

export class Baseline1800000000000 implements MigrationInterface {
    name = 'Baseline1800000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ai"."tenant_agent_configs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "baseProfileId" character varying(50) NOT NULL DEFAULT 'operator-v1', "additionalToolNames" jsonb NOT NULL DEFAULT '[]', "blockedToolNames" jsonb NOT NULL DEFAULT '[]', "actuationPolicy" character varying(50) NOT NULL DEFAULT 'confirm_required', "customSystemPrompt" text, "applicableRoles" jsonb NOT NULL DEFAULT '["operator"]', "isEnabled" boolean NOT NULL DEFAULT true, "proactiveMonitoringEnabled" boolean NOT NULL DEFAULT false, "autonomousActionsEnabled" boolean NOT NULL DEFAULT false, "autonomousSafetyLimits" jsonb, "monthlyTokenBudget" integer NOT NULL DEFAULT '1000000', "hourlyRequestLimit" integer NOT NULL DEFAULT '60', "mcpEnabled" boolean NOT NULL DEFAULT false, "mcpAllowedPersonas" jsonb NOT NULL DEFAULT '[]', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2f36533bbf6afb81e2f542ecb6e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_aef28b9db4304f9e113e609d1f" ON "ai"."tenant_agent_configs" ("tenantId") `);
        await queryRunner.query(`CREATE TABLE "ai"."agent_conversations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "userId" uuid NOT NULL, "persona" character varying(50) NOT NULL, "messages" jsonb NOT NULL, "title" character varying(255), "totalTokens" integer NOT NULL DEFAULT '0', "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2680ac7af80219a718cf98a1d21" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c1c19f8983b6beef7cbd2ce51e" ON "ai"."agent_conversations" ("tenantId", "userId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "ai"."tool_execution_audit" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "userId" uuid NOT NULL, "toolName" character varying(100) NOT NULL, "persona" character varying(50) NOT NULL, "input" jsonb NOT NULL, "success" boolean NOT NULL, "output" jsonb, "errorMessage" text, "durationMs" integer NOT NULL, "correlationId" character varying(100), "conversationId" uuid, "executed_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_9b65810edd2682db254a5db57ae" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6562ce887dfb374699522133c9" ON "ai"."tool_execution_audit" ("toolName", "executed_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_f300876b8d51dff4aac2cc71b7" ON "ai"."tool_execution_audit" ("tenantId", "executed_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "ai"."IDX_f300876b8d51dff4aac2cc71b7"`);
        await queryRunner.query(`DROP INDEX "ai"."IDX_6562ce887dfb374699522133c9"`);
        await queryRunner.query(`DROP TABLE "ai"."tool_execution_audit"`);
        await queryRunner.query(`DROP INDEX "ai"."IDX_c1c19f8983b6beef7cbd2ce51e"`);
        await queryRunner.query(`DROP TABLE "ai"."agent_conversations"`);
        await queryRunner.query(`DROP INDEX "ai"."IDX_aef28b9db4304f9e113e609d1f"`);
        await queryRunner.query(`DROP TABLE "ai"."tenant_agent_configs"`);
    }

}
