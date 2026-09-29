import 'reflect-metadata';
import { randomBytes } from 'crypto';

import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import { ActionProposalService } from '../../../../apps/ai-service/src/actions/action-proposal.service';
import { ProposedAction } from '../../../../apps/ai-service/src/actions/proposed-action.entity';
import type { AgentPersonaCatalogueService } from '../../../../apps/ai-service/src/agent/agent-persona-catalogue.service';
import { AgentConversation } from '../../../../apps/ai-service/src/conversation/conversation.entity';
import type { ToolExecutorService } from '../../../../apps/ai-service/src/tools/core/tool-executor.service';

import { createAppRole, installTenantRls } from './rls-app-role';

/** The per-tenant ai tables the chat and confirm paths read. */
const AI_ENTITIES = [AgentConversation, ProposedAction];

export interface AiTwoTenantHarness {
  /** The application connection (NOSUPERUSER, NOBYPASSRLS, owner of nothing). */
  readonly dataSource: DataSource;
  /** Provisioning connection — raw-row assertions only. */
  readonly adminDataSource: DataSource;
  readonly tenantSchemas: readonly string[];
  /** Tenant B's stored conversation (its history carries the secret). */
  readonly conversationB: AgentConversation;
  /** Tenant B's pending actuation proposal. */
  readonly proposalB: ProposedAction;
  /** The REAL ActionProposalService on the application connection, `executor` behind it. */
  proposals(
    executor: ToolExecutorService,
    catalogue: AgentPersonaCatalogueService,
  ): ActionProposalService;
  close(): Promise<void>;
}

export interface AiTwoTenantParams {
  readonly tenantAId: string;
  readonly tenantBId: string;
  readonly userBId: string;
  readonly persona: string;
  /** Text only tenant B's rows carry. */
  readonly secret: string;
}

/**
 * Boots PostgreSQL with ai-service's per-tenant conversation and proposal
 * tables cloned into two tenant schemas (as provisioning clones them), stores
 * a conversation and a pending proposal for tenant B, installs the production
 * tenant RLS policy, and connects as an application role that cannot bypass it.
 */
export async function bootAiTwoTenantHarness(
  params: AiTwoTenantParams,
): Promise<AiTwoTenantHarness> {
  const pg: HarnessContext = await bootPostgresContainer({ startTimeoutMs: 90_000 });
  await pg.dataSource.query('CREATE SCHEMA ai');
  await pg.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  const base = {
    type: 'postgres' as const,
    ...pg.connectionOptions,
    entities: AI_ENTITIES,
    logging: false,
  };
  // The admin connection builds the `ai` source tables. The application
  // connection declares NO schema, exactly as createServiceTypeOrmConfig
  // leaves it in production: a DataSource `schema` would qualify every
  // per-tenant query as "ai"."…" and bypass the tenant schema the boundary
  // pins — the suite would then prove nothing about it.
  const admin = new DataSource({
    ...base,
    schema: 'ai',
    name: `ai-redteam-admin-${randomBytes(4).toString('hex')}`,
    synchronize: true,
  });
  await admin.initialize();

  const tenantSchemas = [params.tenantAId, params.tenantBId].map(getTenantSchemaName);
  for (const schema of tenantSchemas) {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const table of ['agent_conversations', 'ai_proposed_actions']) {
      await admin.query(`CREATE TABLE "${schema}"."${table}" (LIKE "ai"."${table}" INCLUDING ALL)`);
    }
  }
  const schemaB = getTenantSchemaName(params.tenantBId);
  const [conversationB] = (await admin.query(
    `INSERT INTO "${schemaB}"."agent_conversations" ("tenantId", "userId", "persona", "messages")
     VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
    [
      params.tenantBId,
      params.userBId,
      params.persona,
      JSON.stringify([
        {
          role: 'user',
          content: `Where is lot ${params.secret}?`,
          timestamp: '2026-09-01T08:00:00Z',
        },
        {
          role: 'assistant',
          content: `Lot ${params.secret} is in tank 7.`,
          timestamp: '2026-09-01T08:00:05Z',
        },
      ]),
    ],
  )) as AgentConversation[];
  const [proposalB] = (await admin.query(
    `INSERT INTO "${schemaB}"."ai_proposed_actions"
       ("tenantId", "toolName", "params", "description", "requestedBy", "requesterRoles", "persona", "status")
     VALUES ($1, 'create_task', $2::jsonb, $3, $4, '["MODULE_MANAGER"]'::jsonb, $5, 'proposed') RETURNING *`,
    [
      params.tenantBId,
      JSON.stringify({ title: `${params.secret} harvest prep` }),
      `Create task ${params.secret}`,
      params.userBId,
      params.persona,
    ],
  )) as ProposedAction[];
  if (conversationB === undefined || proposalB === undefined) {
    throw new Error('tenant B seed rows were not written');
  }

  await installTenantRls(admin, tenantSchemas);
  const role = await createAppRole(admin, ['ai', ...tenantSchemas]);
  const dataSource = new DataSource({
    ...base,
    ...role,
    name: `ai-redteam-app-${randomBytes(4).toString('hex')}`,
    synchronize: false,
    // The factory's default search_path for a connection no boundary pinned.
    extra: { options: '-c search_path=ai,public' },
  });
  await dataSource.initialize();

  return {
    dataSource,
    adminDataSource: admin,
    tenantSchemas,
    conversationB,
    proposalB,
    proposals: (executor, catalogue) =>
      new ActionProposalService(
        dataSource.getRepository(ProposedAction),
        executor,
        dataSource,
        catalogue,
      ),
    async close(): Promise<void> {
      if (dataSource.isInitialized) await dataSource.destroy();
      if (admin.isInitialized) await admin.destroy();
      await shutdownHarness(pg);
    },
  };
}
