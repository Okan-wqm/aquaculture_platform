/**
 * K10 red-team, chat and confirm entry points (PR-T1 — V-T1a-6).
 *
 * Tenant A replays tenant B's ids at ai-service's own entry points, which
 * read ai-service's per-tenant tables: the `request.ai.chat` responder with
 * B's conversationId (a REAL ConversationService over a two-tenant
 * PostgreSQL), and `request.ai.executeAction` with B's pending proposal id
 * (a REAL ActionProposalService). Both run as an application role that
 * cannot bypass RLS, over tables that carry the production tenant policy.
 */
import { collaborator } from '@aquaculture/testing';

import { AiActionResponder } from '../../../apps/ai-service/src/actions/ai-action.responder';
import type { AgentPersonaCatalogueService } from '../../../apps/ai-service/src/agent/agent-persona-catalogue.service';
import { AiChatResponder } from '../../../apps/ai-service/src/chat/ai-chat.responder';
import type { ToolExecutorService } from '../../../apps/ai-service/src/tools/core/tool-executor.service';
import type {
  ToolExecutionContext,
  ToolResult,
} from '../../../apps/ai-service/src/tools/core/tool.interface';

import { buildAttackedAgent } from './helpers/ai-agent.harness';
import { bootAiTwoTenantHarness, type AiTwoTenantHarness } from './helpers/ai-two-tenant.harness';
import { InProcessNatsTransport } from './helpers/in-process-nats.transport';
import { readRlsPosture, REDTEAM_APP_ROLE } from './helpers/rls-app-role';
import { finalAnswer, ScriptedAttacker } from './helpers/scripted-attacker.provider';

const TENANT_A = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const TENANT_B = '7c2f4e10-3d2a-4b4e-9f18-f8b16f0d5a10';
const USER_A = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';
const USER_B = '0d4f8c33-5b1e-4f7a-9c2d-6e8a1b3c5d7f';
const PERSONA = 'manager-farm-production-v1';
const SECRET = 'CONV-B-SECRET';

describe('K10 red-team: tenant A cannot replay tenant B conversations or proposals', () => {
  let ai: AiTwoTenantHarness;

  beforeAll(async () => {
    ai = await bootAiTwoTenantHarness({
      tenantAId: TENANT_A,
      tenantBId: TENANT_B,
      userBId: USER_B,
      persona: PERSONA,
      secret: SECRET,
    });
  });

  afterAll(async () => {
    await ai.close();
  });

  const storedRow = async (table: string, id: string): Promise<Record<string, unknown>> => {
    const [row] = (await ai.adminDataSource.query(
      `SELECT * FROM "${ai.tenantSchemas[1] ?? ''}"."${table}" WHERE "id" = $1`,
      [id],
    )) as Array<Record<string, unknown>>;
    return row ?? {};
  };

  it('ai-service reads as a role that cannot bypass RLS (sanity)', async () => {
    await expect(readRlsPosture(ai.dataSource, ai.tenantSchemas)).resolves.toEqual({
      role: REDTEAM_APP_ROLE,
      superuser: false,
      bypassRls: false,
      unprotectedTables: [],
    });
  });

  describe('request.ai.chat with tenant B conversationId', () => {
    const chatAs = async (
      tenantId: string,
      userId: string,
    ): Promise<{ shown: string; reply: unknown }> => {
      const attacker = new ScriptedAttacker([finalAnswer('Continuing.')]);
      const agent = await buildAttackedAgent(new InProcessNatsTransport([]), attacker, {
        conversationDataSource: ai.dataSource,
      });
      const reply = await new AiChatResponder(agent.runner).handleChat({
        tenantId,
        userId,
        message: 'Continue where we left off.',
        conversationId: ai.conversationB.id,
        persona: PERSONA,
        userRoles: ['MODULE_MANAGER'],
      });
      await agent.close();
      return { shown: attacker.everythingShown, reply };
    };

    it("shows tenant A's model nothing of B's history and leaves B's conversation untouched", async () => {
      // SCENARIO: a tenant-A user sends B's real conversationId through the chat entry point.
      // EXPECTS: the stored conversation is not found in A's schema — the model sees no B
      //          history, the reply carries none, and B's row keeps exactly its two messages.
      const { shown, reply } = await chatAs(TENANT_A, USER_A);

      expect(shown).not.toContain(SECRET);
      expect(JSON.stringify(reply)).not.toContain(SECRET);
      const stored = await storedRow('agent_conversations', ai.conversationB.id);
      expect(stored['messages']).toHaveLength(2);
      expect(JSON.stringify(stored['messages'])).not.toContain('Continue where we left off.');
    });

    it("control: tenant B's own replay shows its history — A's miss is isolation, not absence", async () => {
      const { shown } = await chatAs(TENANT_B, USER_B);
      expect(shown).toContain(SECRET);
    });
  });

  describe('request.ai.executeAction with tenant B proposal id', () => {
    const confirmAs = async (
      tenantId: string,
      confirmedBy: string,
    ): Promise<{ reply: unknown; executeTool: jest.Mock }> => {
      const executeTool = jest.fn(
        async (
          _tool: string,
          _input: Record<string, unknown>,
          _ctx: ToolExecutionContext,
        ): Promise<ToolResult> => ({
          success: true,
          durationMs: 1,
          cacheable: false,
        }),
      );
      const proposals = ai.proposals(
        collaborator<ToolExecutorService>({ executeTool }, 'ToolExecutorService'),
        collaborator<AgentPersonaCatalogueService>(
          { tierOf: () => 'manager' },
          'AgentPersonaCatalogueService',
        ),
      );
      const reply = await new AiActionResponder(proposals).handleExecuteAction({
        tenantId,
        actionId: ai.proposalB.id,
        confirmedBy,
      });
      return { reply, executeTool };
    };

    it("finds nothing for tenant A, runs nothing, and leaves B's proposal pending", async () => {
      // SCENARIO: a tenant-A user confirms B's real pending proposal id.
      // EXPECTS: "not found" for A; the executor is never reached; B's row stays `proposed`.
      const { reply, executeTool } = await confirmAs(TENANT_A, USER_A);

      expect(reply).toEqual({ success: false, result: 'Proposed action not found.' });
      expect(executeTool).not.toHaveBeenCalled();
      expect(await storedRow('ai_proposed_actions', ai.proposalB.id)).toMatchObject({
        status: 'proposed',
        confirmedBy: null,
      });
    });

    it('control: tenant B confirming its own proposal runs the STORED tool under tenant B', async () => {
      const { reply, executeTool } = await confirmAs(TENANT_B, USER_B);

      expect(reply).toMatchObject({ success: true });
      expect(executeTool).toHaveBeenCalledWith(
        'create_task',
        { title: `${SECRET} harvest prep` },
        expect.objectContaining({ tenant: expect.objectContaining({ tenantId: TENANT_B }) }),
      );
      expect(await storedRow('ai_proposed_actions', ai.proposalB.id)).toMatchObject({
        status: 'completed',
      });
    });
  });
});
