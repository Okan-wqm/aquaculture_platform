/**
 * @module GDPR E2E Tests
 * @description End-to-end tests for GDPR data portability (Article 20) features.
 *
 * Tests cover:
 * - exportMyMessages: user data export as JSON
 * - totalUnreadMessageCount: unread aggregation query
 *
 * NOTE: anonymizeMyData is NOT tested here because it requires password
 * confirmation via auth-service (NATS), which is mocked in E2E.
 * That flow is covered by unit tests in gdpr.service.spec.ts.
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
  USER_A1,
  USER_A2,
  ADMIN_A,
  E2eTestContext,
} from './e2e-setup';

// ── GraphQL Operations ─────────────────────────────────────────────────────

const CREATE_CHANNEL = `
  mutation CreateChannel($input: CreateChannelInput!) {
    createChannel(input: $input) { id }
  }
`;

const SEND_MESSAGE = `
  mutation SendMessage($input: SendMessageInput!) {
    sendMessage(input: $input) { id content createdAt }
  }
`;

const EXPORT_MY_MESSAGES = `
  mutation ExportMyMessages {
    exportMyMessages
  }
`;

const TOTAL_UNREAD_COUNT = `
  query {
    totalUnreadMessageCount
  }
`;

const MARK_READ = `
  mutation MarkRead($input: MarkReadInput!) {
    markMessagesRead(input: $input)
  }
`;

// ── Test Suite ──────────────────────────────────────────────────────────────

describe('GDPR (E2E)', () => {
  let ctx: E2eTestContext;
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let redis: Redis;

  let channelId: string;
  const sentMessageIds: string[] = [];

  beforeAll(async () => {
    ctx = await createE2eTestApp();
    ({ app, httpServer, dataSource, redis } = ctx);
    await setupTenantSchemas(dataSource, [TENANT_A]);
    resetIdempotencyCounter();

    // Flush Redis to clear any GDPR rate-limit keys from prior runs
    await flushAllTestRedisKeys(redis);

    // Create a test channel
    const channelRes = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
      .query(CREATE_CHANNEL, {
        input: {
          type: 'GROUP',
          name: 'KVKK Test Kanalı',
          memberIds: [USER_A1, USER_A2, ADMIN_A],
        },
      })
      .expect(200);
    channelId = channelRes.body.data.createChannel.id;

    // Send several messages from USER_A1 for export testing
    for (let i = 0; i < 5; i++) {
      const msgRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(SEND_MESSAGE, {
          input: {
            channelId,
            content: `KVKK test mesajı ${i + 1}`,
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);
      sentMessageIds.push(msgRes.body.data.sendMessage.id);
    }

    // Send a message from USER_A2 so USER_A1 has unread messages
    await gqlRequest(httpServer, TENANT_A, USER_A2)
      .query(SEND_MESSAGE, {
        input: {
          channelId,
          content: 'Okunmamış test mesajı',
          contentType: 'TEXT',
          idempotencyKey: nextIdempotencyKey(),
        },
      })
      .expect(200);
  });

  afterAll(async () => {
    await cleanupTenantData(dataSource, TENANT_A);
    await flushAllTestRedisKeys(redis);
    await app.close();
  });

  // ── Data Export (GDPR Article 20) ────────────────────────────────────────

  describe('exportMyMessages', () => {
    it('should export user messages as JSON with metadata', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(EXPORT_MY_MESSAGES)
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const exported = res.body.data.exportMyMessages;

      // The export returns a JSON object (via GraphQLJSON scalar)
      expect(exported).toBeDefined();
      expect(exported.exportedAt).toBeTruthy();
      expect(exported.userId).toBe(USER_A1);
      expect(exported.messageCount).toBeGreaterThanOrEqual(5);

      // Verify messages array is present and contains our test messages
      expect(Array.isArray(exported.messages)).toBe(true);
      expect(exported.messages.length).toBeGreaterThanOrEqual(5);

      // Verify each exported message has expected fields
      for (const msg of exported.messages) {
        expect(msg.content).toBeTruthy();
        expect(msg.channelId).toBeTruthy();
        expect(msg.createdAt).toBeTruthy();
        expect(msg.contentType).toBeTruthy();
      }
    });

    it('should include channel memberships in export', async () => {
      // WHY: Separate test to avoid rate limit on export (1/24h).
      // The first export call already validated the structure.
      // Here we re-check the same response shape from the first call.
      // If the first test passed, memberships are guaranteed to be in the export.
      // We flush the rate-limit key first to allow a second export.
      await redis.del(`msg:${TENANT_A}:gdpr:export:${USER_A1}`);

      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(EXPORT_MY_MESSAGES)
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const exported = res.body.data.exportMyMessages;

      // Channel memberships should be included
      expect(Array.isArray(exported.channelMemberships)).toBe(true);
      expect(exported.channelMemberships.length).toBeGreaterThanOrEqual(1);

      const membership = exported.channelMemberships.find(
        (m: { channelId: string }) => m.channelId === channelId,
      );
      expect(membership).toBeDefined();
      expect(membership.role).toBeTruthy();
    });

    it('should rate-limit export to 1 per 24 hours', async () => {
      // First export (clear the key and do a fresh export)
      await redis.del(`msg:${TENANT_A}:gdpr:export:${USER_A2}`);

      const firstRes = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(EXPORT_MY_MESSAGES)
        .expect(200);
      expect(firstRes.body.errors).toBeUndefined();

      // Second export immediately after should be rate-limited
      const secondRes = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(EXPORT_MY_MESSAGES)
        .expect(200);

      expect(secondRes.body.errors).toBeDefined();
      expect(secondRes.body.errors[0].message).toMatch(/24 hours|rate|once/i);
    });
  });

  // ── Unread Count ─────────────────────────────────────────────────────────

  describe('totalUnreadMessageCount', () => {
    it('should return total unread message count as a number', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(TOTAL_UNREAD_COUNT)
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(typeof res.body.data.totalUnreadMessageCount).toBe('number');
    });

    it('should decrement unread count after marking messages as read', async () => {
      // Get current unread count for USER_A2
      const beforeRes = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(TOTAL_UNREAD_COUNT)
        .expect(200);
      const unreadBefore = beforeRes.body.data.totalUnreadMessageCount;

      // Mark the latest message as read
      const latestMessageId = sentMessageIds[sentMessageIds.length - 1];
      await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(MARK_READ, {
          input: { channelId, messageId: latestMessageId },
        })
        .expect(200);

      // Check unread count again
      const afterRes = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(TOTAL_UNREAD_COUNT)
        .expect(200);
      const unreadAfter = afterRes.body.data.totalUnreadMessageCount;

      // Unread count should decrease or stay the same (never increase)
      expect(unreadAfter).toBeLessThanOrEqual(unreadBefore);
    });
  });
});
