/**
 * @module Offline Sync E2E Tests
 * @description End-to-end tests for offline synchronization queries:
 * messagesSince (single channel) and allMessagesSince (multi-channel).
 *
 * These queries power the mobile app's offline-first sync engine,
 * allowing clients to fetch all messages created after a timestamp
 * with cursor-based pagination via syncToken.
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

const MESSAGES_SINCE_QUERY = `
  query MessagesSince($channelId: ID!, $since: DateTime!) {
    messagesSince(channelId: $channelId, since: $since) {
      id content channelId
    }
  }
`;

const ALL_MESSAGES_SINCE_QUERY = `
  query AllMessagesSince($since: DateTime!, $limit: Int, $syncToken: String) {
    allMessagesSince(since: $since, limit: $limit, syncToken: $syncToken) {
      messages { id content channelId }
      hasMore
      syncToken
    }
  }
`;

// ── Helper ────────────────────────────────────────────────────────────────

/** Send a text message and return its ID */
async function sendMessage(
  httpServer: ReturnType<INestApplication['getHttpServer']>,
  tenantId: string,
  userId: string,
  channelId: string,
  content: string,
): Promise<string> {
  const res = await gqlRequest(httpServer, tenantId, userId)
    .query(`
      mutation SendMessage($input: SendMessageInput!) {
        sendMessage(input: $input) { id }
      }
    `, {
      input: {
        channelId,
        content,
        contentType: 'TEXT',
        idempotencyKey: nextIdempotencyKey(),
      },
    })
    .expect(200);

  if (res.body.errors) {
    throw new Error(`sendMessage failed: ${res.body.errors[0].message}`);
  }
  return res.body.data.sendMessage.id as string;
}

describe('Offline Sync (E2E)', () => {
  let ctx: E2eTestContext;
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let redis: Redis;

  let channelA: string;
  let channelB: string;

  // Timestamp captured before any messages are sent
  let beforeAllMessages: string;

  beforeAll(async () => {
    ctx = await createE2eTestApp();
    ({ app, httpServer, dataSource, redis } = ctx);
    await setupTenantSchemas(dataSource, [TENANT_A]);
    resetIdempotencyCounter();

    // Create two channels for multi-channel sync tests
    const chARes = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
      .query(`
        mutation CreateChannel($input: CreateChannelInput!) {
          createChannel(input: $input) { id }
        }
      `, {
        input: {
          type: 'GROUP',
          name: 'Senkronizasyon Kanal A',
          memberIds: [USER_A1, USER_A2],
        },
      })
      .expect(200);
    channelA = chARes.body.data.createChannel.id;

    const chBRes = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
      .query(`
        mutation CreateChannel($input: CreateChannelInput!) {
          createChannel(input: $input) { id }
        }
      `, {
        input: {
          type: 'GROUP',
          name: 'Senkronizasyon Kanal B',
          memberIds: [USER_A1, USER_A2],
        },
      })
      .expect(200);
    channelB = chBRes.body.data.createChannel.id;

    // Capture timestamp before seeding messages
    beforeAllMessages = new Date(Date.now() - 1000).toISOString();
  });

  afterAll(async () => {
    await cleanupTenantData(dataSource, TENANT_A);
    await flushAllTestRedisKeys(redis);
    await app.close();
  });

  // ── messagesSince (Single Channel) ─────────────────────────────────────

  describe('messagesSince (Single Channel)', () => {
    let msgIds: string[];

    beforeAll(async () => {
      msgIds = [];
      // Send 3 messages to channelA
      for (let i = 1; i <= 3; i++) {
        const id = await sendMessage(
          httpServer, TENANT_A, USER_A1, channelA, `Senkron mesaj ${i}`,
        );
        msgIds.push(id);
      }
    });

    it('should return messages after a timestamp', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(MESSAGES_SINCE_QUERY, {
          channelId: channelA,
          since: beforeAllMessages,
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const messages = res.body.data.messagesSince;
      expect(messages.length).toBeGreaterThanOrEqual(3);

      // All seeded messages should be present
      const returnedIds = messages.map((m: { id: string }) => m.id);
      for (const id of msgIds) {
        expect(returnedIds).toContain(id);
      }
    });
  });

  // ── allMessagesSince (Multi-Channel) ───────────────────────────────────

  describe('allMessagesSince (Multi-Channel)', () => {
    let channelAMsgIds: string[];
    let channelBMsgIds: string[];
    let multiChannelSince: string;

    beforeAll(async () => {
      multiChannelSince = new Date(Date.now() - 500).toISOString();

      channelAMsgIds = [];
      channelBMsgIds = [];

      // Send messages to both channels
      for (let i = 1; i <= 2; i++) {
        const idA = await sendMessage(
          httpServer, TENANT_A, USER_A1, channelA, `Kanal A mesaj ${i}`,
        );
        channelAMsgIds.push(idA);

        const idB = await sendMessage(
          httpServer, TENANT_A, USER_A1, channelB, `Kanal B mesaj ${i}`,
        );
        channelBMsgIds.push(idB);
      }
    });

    it('should return messages from all channels', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(ALL_MESSAGES_SINCE_QUERY, {
          since: beforeAllMessages,
          limit: 200,
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const { messages } = res.body.data.allMessagesSince;

      const returnedIds = messages.map((m: { id: string }) => m.id);

      // Messages from both channels should be present
      for (const id of channelAMsgIds) {
        expect(returnedIds).toContain(id);
      }
      for (const id of channelBMsgIds) {
        expect(returnedIds).toContain(id);
      }

      // Messages should reference the correct channelIds
      const channelAMessages = messages.filter(
        (m: { channelId: string }) => m.channelId === channelA,
      );
      const channelBMessages = messages.filter(
        (m: { channelId: string }) => m.channelId === channelB,
      );
      expect(channelAMessages.length).toBeGreaterThanOrEqual(2);
      expect(channelBMessages.length).toBeGreaterThanOrEqual(2);
    });

    it('should paginate using syncToken without duplicates', async () => {
      // First page with small limit
      const firstRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(ALL_MESSAGES_SINCE_QUERY, {
          since: beforeAllMessages,
          limit: 2,
        })
        .expect(200);

      expect(firstRes.body.errors).toBeUndefined();
      const firstPage = firstRes.body.data.allMessagesSince;
      expect(firstPage.messages).toHaveLength(2);
      expect(firstPage.syncToken).toBeTruthy();
      expect(firstPage.hasMore).toBe(true);

      const firstPageIds = firstPage.messages.map((m: { id: string }) => m.id);

      // Second page using syncToken
      const secondRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(ALL_MESSAGES_SINCE_QUERY, {
          since: beforeAllMessages,
          limit: 2,
          syncToken: firstPage.syncToken,
        })
        .expect(200);

      expect(secondRes.body.errors).toBeUndefined();
      const secondPage = secondRes.body.data.allMessagesSince;
      expect(secondPage.messages.length).toBeGreaterThanOrEqual(1);

      const secondPageIds = secondPage.messages.map((m: { id: string }) => m.id);

      // No duplicates between pages
      const overlap = firstPageIds.filter((id: string) => secondPageIds.includes(id));
      expect(overlap).toHaveLength(0);
    });

    it('should cap limit at 500 without error', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(ALL_MESSAGES_SINCE_QUERY, {
          since: beforeAllMessages,
          limit: 1000,
        })
        .expect(200);

      // Should not error — limit is silently capped to 500
      expect(res.body.errors).toBeUndefined();
      const { messages } = res.body.data.allMessagesSince;
      // With our small test dataset, just verify it returned results
      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages.length).toBeLessThanOrEqual(500);
    });
  });

  // ── Deleted Messages Exclusion ─────────────────────────────────────────

  describe('Deleted Messages', () => {
    it('should exclude deleted messages from allMessagesSince', async () => {
      const sinceBefore = new Date(Date.now() - 500).toISOString();

      // Send a message then delete it
      const msgId = await sendMessage(
        httpServer, TENANT_A, USER_A1, channelA, 'Silinecek senkron mesaj',
      );

      const delRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation DeleteMessage($id: ID!) {
            deleteMessage(id: $id)
          }
        `, { id: msgId })
        .expect(200);

      expect(delRes.body.errors).toBeUndefined();
      expect(delRes.body.data.deleteMessage).toBe(true);

      // Query allMessagesSince — deleted message should NOT appear
      const syncRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(ALL_MESSAGES_SINCE_QUERY, {
          since: sinceBefore,
          limit: 200,
        })
        .expect(200);

      expect(syncRes.body.errors).toBeUndefined();
      const returnedIds = syncRes.body.data.allMessagesSince.messages.map(
        (m: { id: string }) => m.id,
      );
      expect(returnedIds).not.toContain(msgId);
    });
  });

  // ── Archived Channels Exclusion ────────────────────────────────────────

  describe('Archived Channel Exclusion', () => {
    it('should exclude messages from archived channels in allMessagesSince', async () => {
      // Create a new channel, send a message, then archive it
      const chRes = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation CreateChannel($input: CreateChannelInput!) {
            createChannel(input: $input) { id }
          }
        `, {
          input: {
            type: 'GROUP',
            name: 'Arşivlenecek Senkron',
            memberIds: [USER_A1],
          },
        })
        .expect(200);

      const archivedChannelId = chRes.body.data.createChannel.id;
      const sinceBefore = new Date(Date.now() - 500).toISOString();

      // Send a message to the channel
      const msgId = await sendMessage(
        httpServer, TENANT_A, USER_A1, archivedChannelId, 'Arşiv mesajı',
      );

      // Archive the channel
      const archRes = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation ArchiveChannel($id: ID!) {
            archiveChannel(id: $id)
          }
        `, { id: archivedChannelId })
        .expect(200);

      expect(archRes.body.errors).toBeUndefined();
      expect(archRes.body.data.archiveChannel).toBe(true);

      // Query allMessagesSince — archived channel messages must be excluded
      const syncRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(ALL_MESSAGES_SINCE_QUERY, {
          since: sinceBefore,
          limit: 200,
        })
        .expect(200);

      expect(syncRes.body.errors).toBeUndefined();
      const returnedChannelIds = syncRes.body.data.allMessagesSince.messages.map(
        (m: { channelId: string }) => m.channelId,
      );
      expect(returnedChannelIds).not.toContain(archivedChannelId);
    });
  });
});
