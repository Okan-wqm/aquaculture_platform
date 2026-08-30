/**
 * AI action confirm roundtrip (MOB-HIGH-001 / MOB-HIGH-013) — DETERMINISTIC,
 * no LLM call: the proposal artifacts an agent turn would produce are seeded
 * directly (the ai_proposed_actions row in the tenant's ai-schema clone + the
 * proposed AI message in the channel), then the REAL confirm path runs:
 * mobile card → confirmAiAction → messaging membership check →
 * request.ai.executeAction → ai-service executes the STORED proposal
 * (create_task) → farm-service task row exists.
 *
 * PRECONDITION: the running stack has provisioned the current messages
 * partition (PartitionManagerService does this at boot); the direct message
 * INSERT below rides that partition.
 */

import { randomUUID } from 'crypto';

import { test, expect } from '@playwright/test';

import { TestDatabase } from '../../helpers/db.helper';
import { GraphQLTestClient } from '../../helpers/graphql-client';
import { generateTestToken } from '../../helpers/jwt.helper';

import {
  FIXTURE_PASSWORD,
  ensureTenantTable,
  loginAsFieldWorker,
  seedMobileWorker,
  type MobileWorkerSeed,
} from './helpers/mobile-helpers';

/** The messaging-service virtual AI sender (ai-chat-bridge.service.ts SSoT). */
const AI_USER_ID = '00000000-0000-0000-0000-000000000001';

let db: TestDatabase;
let seed: MobileWorkerSeed;
let channelId: string;
let proposalId: string;
let actionMessageId: string;
const taskTitle = `Mobile E2E AI Task ${Date.now()}`;

test.describe('AquaMobil AI action confirm', () => {
  test.beforeAll(async ({ request }) => {
    db = new TestDatabase();
    await db.connect();
    seed = await seedMobileWorker(db);
    const schema = seed.tenant.schemaName;

    // AI channel created AS the worker (creator becomes a member).
    const workerToken = generateTestToken({
      userId: seed.user.id,
      email: seed.user.email,
      role: 'MODULE_MANAGER',
      tenantId: seed.tenant.id,
    });
    const client = new GraphQLTestClient(request);
    const created = await client.query<{ createChannel: { id: string } }>(
      `mutation CreateChannel($input: CreateChannelInput!) {
        createChannel(input: $input) { id }
      }`,
      { input: { type: 'AI', name: 'AI Assistant' } },
      { token: workerToken },
    );
    channelId = created.createChannel.id;

    // createChannel provisioned the MESSAGING tenant clone; provoke the AI
    // subgraph the same way so ai_proposed_actions exists before the seed.
    await ensureTenantTable(db, schema, 'ai_proposed_actions', () =>
      client.query(`query ProvisionAi { aiServiceHealth }`, {}, { token: workerToken }),
    );
    await ensureTenantTable(db, schema, 'messages', () => Promise.resolve());

    // The persisted proposal — the executable SSoT the responder runs.
    proposalId = randomUUID();
    await db.query(
      `INSERT INTO "${schema}"."ai_proposed_actions"
        ("id", "tenantId", "toolName", "params", "description", "requestedBy", "requesterRoles", "persona", "status")
       VALUES ($1, $2, 'create_task', $3, $4, $5, $6, 'operator-v1', 'proposed')`,
      [
        proposalId,
        seed.tenant.id,
        JSON.stringify({
          title: taskTitle,
          category: 'GENERAL',
          priority: 'MEDIUM',
          dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
        }),
        `create_task: "${taskTitle}"`,
        seed.user.id,
        JSON.stringify(['operator', 'manager']),
      ],
    );

    // The proposed AI message carrying the card metadata.
    actionMessageId = randomUUID();
    await db.query(
      `INSERT INTO "${schema}"."messages"
        ("id", "channelId", "senderId", "content", "contentType", "metadata", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'TEXT', $5, NOW(), NOW())`,
      [
        actionMessageId,
        channelId,
        AI_USER_ID,
        `I can create the task "${taskTitle}" for you — please confirm.`,
        JSON.stringify({
          status: 'proposed',
          actionId: proposalId,
          actionType: 'create_task',
          actionDescription: `create_task: "${taskTitle}"`,
          params: { title: taskTitle },
          isAi: true,
        }),
      ],
    );
  });

  test.afterAll(async () => {
    await db.disconnect();
  });

  test('confirming the card executes the persisted proposal into a farm task', async ({ page }) => {
    await loginAsFieldWorker(page, seed.user.email, FIXTURE_PASSWORD);

    await page.goto(`/messages/ai/${channelId}`);
    await expect(page.getByText(`create_task: "${taskTitle}"`)).toBeVisible({ timeout: 15_000 });

    await page
      .getByRole('button', { name: /^Confirm/ })
      .first()
      .click();

    // The proposal row converges to completed…
    await expect
      .poll(
        async () => {
          const result = await db.query<{ status: string }>(
            `SELECT "status" FROM "${seed.tenant.schemaName}"."ai_proposed_actions" WHERE id = $1`,
            [proposalId],
          );
          return result.rows[0]?.status;
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBe('completed');

    // …and the actuation is REAL: the farm task row exists.
    const tasks = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM "${seed.tenant.schemaName}"."tasks"
       WHERE "title" = $1`,
      [taskTitle],
    );
    expect(Number(tasks.rows[0]?.count ?? '0')).toBeGreaterThan(0);
  });
});
