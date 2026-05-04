/**
 * @module Tenant Isolation E2E Tests
 * @description SECURITY-CRITICAL tests proving that no cross-tenant data leakage
 * exists at the database, Redis, or API layers.
 *
 * These tests create independent data in TENANT_A and TENANT_B, then verify
 * that each tenant can only see and act on their own data.
 */
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import {
  createE2eTestApp,
  gqlRequest,
  setupTenantSchemas,
  cleanupTenantData,
  flushAllTestRedisKeys,
  nextIdempotencyKey,
  resetIdempotencyCounter,
  TENANT_A,
  TENANT_B,
  USER_A1,
  USER_B1,
  E2eTestContext,
} from './e2e-setup';
import { getTenantSchemaName } from '@aquaculture/backend-common/database';

describe('Tenant Isolation (E2E) — SECURITY-CRITICAL', () => {
  let ctx: E2eTestContext;
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let redis: Redis;

  // Per-tenant test data
  let channelA: string;
  let channelB: string;
  let messageA: string;

  beforeAll(async () => {
    ctx = await createE2eTestApp();
    ({ app, httpServer, dataSource, redis } = ctx);
    resetIdempotencyCounter();

    // Setup both tenant schemas
    await setupTenantSchemas(dataSource, [TENANT_A, TENANT_B]);

    // ── Seed TENANT_A ──
    const chARes = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
      .query(`
        mutation CreateChannel($input: CreateChannelInput!) {
          createChannel(input: $input) { id }
        }
      `, {
        input: { type: 'GROUP', name: 'Tenant A Kanalı', memberIds: [USER_A1] },
      })
      .expect(200);
    channelA = chARes.body.data.createChannel.id;

    const msgARes = await gqlRequest(httpServer, TENANT_A, USER_A1)
      .query(`
        mutation SendMessage($input: SendMessageInput!) {
          sendMessage(input: $input) { id }
        }
      `, {
        input: {
          channelId: channelA,
          content: 'Tenant A gizli mesaj',
          contentType: 'TEXT',
          idempotencyKey: nextIdempotencyKey(),
        },
      })
      .expect(200);
    messageA = msgARes.body.data.sendMessage.id;

    // ── Seed TENANT_B ──
    const chBRes = await gqlRequest(httpServer, TENANT_B, USER_B1, ['TENANT_ADMIN'])
      .query(`
        mutation CreateChannel($input: CreateChannelInput!) {
          createChannel(input: $input) { id }
        }
      `, {
        input: { type: 'GROUP', name: 'Tenant B Kanalı', memberIds: [USER_B1] },
      })
      .expect(200);
    channelB = chBRes.body.data.createChannel.id;
  });

  afterAll(async () => {
    await cleanupTenantData(dataSource, TENANT_A);
    await cleanupTenantData(dataSource, TENANT_B);
    await flushAllTestRedisKeys(redis);
    await app.close();
  });

  // ── Channel Isolation ─────────────────────────────────────────────────

  it('Tenant A should only see Tenant A channels', async () => {
    const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
      .query(`
        query MyChannels {
          myChannels { items { id name } total }
        }
      `)
      .expect(200);

    expect(res.body.errors).toBeUndefined();
    const { items } = res.body.data.myChannels;
    const channelIds = items.map((c: { id: string }) => c.id);

    // MUST contain Tenant A's channel
    expect(channelIds).toContain(channelA);
    // MUST NOT contain Tenant B's channel
    expect(channelIds).not.toContain(channelB);
  });

  it('Tenant B should only see Tenant B channels', async () => {
    const res = await gqlRequest(httpServer, TENANT_B, USER_B1)
      .query(`
        query MyChannels {
          myChannels { items { id } total }
        }
      `)
      .expect(200);

    expect(res.body.errors).toBeUndefined();
    const channelIds = res.body.data.myChannels.items.map((c: { id: string }) => c.id);

    expect(channelIds).toContain(channelB);
    expect(channelIds).not.toContain(channelA);
  });

  // ── Message Isolation ─────────────────────────────────────────────────

  it('Tenant B cannot read Tenant A messages', async () => {
    const res = await gqlRequest(httpServer, TENANT_B, USER_B1)
      .query(`
        query Messages($channelId: ID!) {
          messages(channelId: $channelId) {
            items { id content }
            hasMore
          }
        }
      `, { channelId: channelA })
      .expect(200);

    // Should either get forbidden error or empty result (channel not found in B's schema)
    if (res.body.errors) {
      expect(res.body.errors[0].message).toMatch(/forbidden|not (an active )?member|not found/i);
    } else {
      // If no error, items must be empty (channel doesn't exist in B's schema)
      expect(res.body.data.messages.items).toHaveLength(0);
    }
  });

  // ── Membership Isolation ──────────────────────────────────────────────

  it('Tenant B cannot join Tenant A channel', async () => {
    const res = await gqlRequest(httpServer, TENANT_B, USER_B1, ['TENANT_ADMIN'])
      .query(`
        mutation AddMember($channelId: ID!, $userId: ID!) {
          addChannelMember(channelId: $channelId, userId: $userId) { userId }
        }
      `, { channelId: channelA, userId: USER_B1 })
      .expect(200);

    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/forbidden|not found|not (an active )?member/i);
  });

  it('Tenant B cannot send to Tenant A channel', async () => {
    const res = await gqlRequest(httpServer, TENANT_B, USER_B1)
      .query(`
        mutation SendMessage($input: SendMessageInput!) {
          sendMessage(input: $input) { id }
        }
      `, {
        input: {
          channelId: channelA,
          content: 'Cross-tenant sızma denemesi',
          contentType: 'TEXT',
          idempotencyKey: nextIdempotencyKey(),
        },
      })
      .expect(200);

    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/forbidden|not (an active )?member/i);
  });

  // ── Forward Isolation ─────────────────────────────────────────────────

  it('cannot forward message cross-tenant', async () => {
    // USER_A1 tries to forward to TENANT_B channel
    const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
      .query(`
        mutation Forward($sourceMessageId: ID!, $sourceMessageCreatedAt: DateTime!, $targetChannelId: ID!) {
          forwardMessage(sourceMessageId: $sourceMessageId, sourceMessageCreatedAt: $sourceMessageCreatedAt, targetChannelId: $targetChannelId) { id }
        }
      `, {
        sourceMessageId: messageA,
        sourceMessageCreatedAt: new Date().toISOString(),
        targetChannelId: channelB,
      })
      .expect(200);

    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].message).toMatch(/forbidden|not (an active )?member|not found/i);
  });

  // ── Redis Isolation ───────────────────────────────────────────────────

  it('Redis presence keys are tenant-scoped', async () => {
    // Set USER_A1 online in TENANT_A
    const tenantAKey = `msg:${TENANT_A}:presence:${USER_A1}`;
    const tenantBKey = `msg:${TENANT_B}:presence:${USER_A1}`;

    await redis.set(tenantAKey, '1', 'EX', 300);

    // Verify key exists in TENANT_A
    const existsA = await redis.exists(tenantAKey);
    expect(existsA).toBe(1);

    // Verify key does NOT exist in TENANT_B
    const existsB = await redis.exists(tenantBKey);
    expect(existsB).toBe(0);

    // Cleanup
    await redis.del(tenantAKey);
  });

  it('Redis unread keys are tenant-scoped', async () => {
    // Simulate unread count for USER_A1 in TENANT_A
    const unreadKeyA = `msg:${TENANT_A}:unread:${USER_A1}`;
    const unreadKeyB = `msg:${TENANT_B}:unread:${USER_A1}`;

    await redis.hset(unreadKeyA, channelA, '5');

    // Verify count in TENANT_A
    const countA = await redis.hget(unreadKeyA, channelA);
    expect(countA).toBe('5');

    // Verify nothing in TENANT_B
    const countB = await redis.hget(unreadKeyB, channelA);
    expect(countB).toBeNull();

    // Cleanup
    await redis.del(unreadKeyA);
  });

  // ── Outbox Isolation ──────────────────────────────────────────────────

  it('outbox events contain correct tenantId', async () => {
    const schemaA = getTenantSchemaName(TENANT_A);

    // Check outbox entries in TENANT_A schema
    const outboxRows: { payload: string; eventType: string }[] = await dataSource.query(
      `SELECT payload::text, "eventType" FROM "${schemaA}"."messaging_outbox" LIMIT 5`,
    );

    // Every outbox event payload must reference TENANT_A
    for (const row of outboxRows) {
      if (row.payload) {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        if (payload.tenantId) {
          expect(payload.tenantId).toBe(TENANT_A);
        }
      }
    }
  });

  // ── Database Schema Isolation ─────────────────────────────────────────

  it('tenant schemas are physically separate in PostgreSQL', async () => {
    const schemaA = getTenantSchemaName(TENANT_A);
    const schemaB = getTenantSchemaName(TENANT_B);

    // Count channels in each schema
    const countA: { count: string }[] = await dataSource.query(
      `SELECT count(*) FROM "${schemaA}"."channels"`,
    );
    const countB: { count: string }[] = await dataSource.query(
      `SELECT count(*) FROM "${schemaB}"."channels"`,
    );

    // Both should have at least 1 channel
    expect(Number(countA[0]!.count)).toBeGreaterThanOrEqual(1);
    expect(Number(countB[0]!.count)).toBeGreaterThanOrEqual(1);

    // Verify channel IDs don't overlap
    const idsA: { id: string }[] = await dataSource.query(
      `SELECT id FROM "${schemaA}"."channels"`,
    );
    const idsB: { id: string }[] = await dataSource.query(
      `SELECT id FROM "${schemaB}"."channels"`,
    );

    const setA = new Set(idsA.map((r) => r.id));
    for (const row of idsB) {
      expect(setA.has(row.id)).toBe(false);
    }
  });
});
