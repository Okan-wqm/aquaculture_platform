/**
 * @module Messaging Features E2E Tests
 * @description End-to-end tests for pin/unpin, reactions, message forwarding,
 * and unread count tracking. Split from messaging-core to stay under 500 lines.
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

describe('Messaging Features (E2E)', () => {
  let ctx: E2eTestContext;
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let redis: Redis;

  let channelId: string;
  let forwardTargetChannelId: string;

  beforeAll(async () => {
    ctx = await createE2eTestApp();
    ({ app, httpServer, dataSource, redis } = ctx);
    await setupTenantSchemas(dataSource, [TENANT_A]);
    resetIdempotencyCounter();

    // Create test channels
    const channelRes = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
      .query(`
        mutation CreateChannel($input: CreateChannelInput!) {
          createChannel(input: $input) { id }
        }
      `, {
        input: {
          type: 'GROUP',
          name: 'Features Test Kanalı',
          memberIds: [USER_A1, USER_A2, ADMIN_A],
        },
      })
      .expect(200);
    channelId = channelRes.body.data.createChannel.id;

    const targetRes = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
      .query(`
        mutation CreateChannel($input: CreateChannelInput!) {
          createChannel(input: $input) { id }
        }
      `, {
        input: {
          type: 'GROUP',
          name: 'Forward Hedef',
          memberIds: [USER_A1, USER_A2],
        },
      })
      .expect(200);
    forwardTargetChannelId = targetRes.body.data.createChannel.id;
  });

  afterAll(async () => {
    await cleanupTenantData(dataSource, TENANT_A);
    await flushAllTestRedisKeys(redis);
    await app.close();
  });

  // ── Pin / Unpin ───────────────────────────────────────────────────────

  describe('Pin Messages', () => {
    let pinnableMessageId: string;

    beforeAll(async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id createdAt }
          }
        `, {
          input: {
            channelId,
            content: 'Bu sabitlenecek',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      pinnableMessageId = res.body.data.sendMessage.id;
    });

    it('should pin a message (admin/owner)', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation PinMessage($channelId: ID!, $messageId: ID!) {
            pinMessage(channelId: $channelId, messageId: $messageId) {
              id pinnedBy channelId
            }
          }
        `, { channelId, messageId: pinnableMessageId })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.pinMessage.pinnedBy).toBe(USER_A1);
    });

    it('should reject pin from non-admin member', async () => {
      const sendRes = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id }
          }
        `, {
          input: {
            channelId,
            content: 'Pinlenemeyecek',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      const res = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(`
          mutation PinMessage($channelId: ID!, $messageId: ID!) {
            pinMessage(channelId: $channelId, messageId: $messageId) { id }
          }
        `, { channelId, messageId: sendRes.body.data.sendMessage.id })
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/admin|owner/i);
    });

    it('should get pinned messages', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          query PinnedMessages($channelId: ID!) {
            pinnedMessages(channelId: $channelId) {
              id pinnedBy
              message { id content }
            }
          }
        `, { channelId })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const pinned = res.body.data.pinnedMessages;
      expect(pinned.length).toBeGreaterThanOrEqual(1);
      expect(pinned.some((p: { message: { id: string } }) => p.message.id === pinnableMessageId)).toBe(true);
    });

    it('should unpin a message', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation UnpinMessage($channelId: ID!, $messageId: ID!) {
            unpinMessage(channelId: $channelId, messageId: $messageId)
          }
        `, { channelId, messageId: pinnableMessageId })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.unpinMessage).toBe(true);
    });
  });

  // ── Reactions ─────────────────────────────────────────────────────────

  describe('Reactions', () => {
    let reactMessageId: string;

    beforeAll(async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id }
          }
        `, {
          input: {
            channelId,
            content: 'Reaction test',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      reactMessageId = res.body.data.sendMessage.id;
    });

    it('should add a reaction', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation AddReaction($messageId: ID!, $emoji: String!) {
            addReaction(messageId: $messageId, emoji: $emoji)
          }
        `, { messageId: reactMessageId, emoji: '👍' })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.addReaction).toBe(true);
    });

    it('should handle duplicate reaction idempotently', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation AddReaction($messageId: ID!, $emoji: String!) {
            addReaction(messageId: $messageId, emoji: $emoji)
          }
        `, { messageId: reactMessageId, emoji: '👍' })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.addReaction).toBe(true);
    });

    it('should remove a reaction', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation RemoveReaction($messageId: ID!, $emoji: String!) {
            removeReaction(messageId: $messageId, emoji: $emoji)
          }
        `, { messageId: reactMessageId, emoji: '👍' })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.removeReaction).toBe(true);
    });
  });

  // ── Forward ───────────────────────────────────────────────────────────

  describe('Message Forward', () => {
    let forwardSourceId: string;
    let forwardSourceCreatedAt: string;

    beforeAll(async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id createdAt }
          }
        `, {
          input: {
            channelId,
            content: 'İletilecek mesaj',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      forwardSourceId = res.body.data.sendMessage.id;
      forwardSourceCreatedAt = res.body.data.sendMessage.createdAt;
    });

    it('should forward a message to another channel', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation Forward($sourceMessageId: ID!, $sourceMessageCreatedAt: DateTime!, $targetChannelId: ID!) {
            forwardMessage(sourceMessageId: $sourceMessageId, sourceMessageCreatedAt: $sourceMessageCreatedAt, targetChannelId: $targetChannelId) {
              id content forwardedFrom channelId
            }
          }
        `, {
          sourceMessageId: forwardSourceId,
          sourceMessageCreatedAt: forwardSourceCreatedAt,
          targetChannelId: forwardTargetChannelId,
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const forwarded = res.body.data.forwardMessage;
      expect(forwarded.channelId).toBe(forwardTargetChannelId);
      expect(forwarded.forwardedFrom).toBeTruthy();
      expect(forwarded.content).toBe('İletilecek mesaj');
    });

    it('should reject forward to non-member channel', async () => {
      const privRes = await gqlRequest(httpServer, TENANT_A, ADMIN_A, ['TENANT_ADMIN'])
        .query(`
          mutation CreateChannel($input: CreateChannelInput!) {
            createChannel(input: $input) { id }
          }
        `, {
          input: { type: 'GROUP', name: 'Gizli', memberIds: [ADMIN_A] },
        })
        .expect(200);

      const privateChannelId = privRes.body.data.createChannel.id;

      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation Forward($sourceMessageId: ID!, $sourceMessageCreatedAt: DateTime!, $targetChannelId: ID!) {
            forwardMessage(sourceMessageId: $sourceMessageId, sourceMessageCreatedAt: $sourceMessageCreatedAt, targetChannelId: $targetChannelId) { id }
          }
        `, {
          sourceMessageId: forwardSourceId,
          sourceMessageCreatedAt: forwardSourceCreatedAt,
          targetChannelId: privateChannelId,
        })
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/forbidden|not a member/i);
    });
  });

  // ── Mark Read / Unread Count ──────────────────────────────────────────

  describe('Unread Tracking', () => {
    it('should mark messages as read', async () => {
      const sendRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id }
          }
        `, {
          input: {
            channelId,
            content: 'Okunmamış mesaj',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      const msgId = sendRes.body.data.sendMessage.id;

      const readRes = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(`
          mutation MarkRead($input: MarkReadInput!) {
            markMessagesRead(input: $input)
          }
        `, { input: { channelId, messageId: msgId } })
        .expect(200);

      expect(readRes.body.errors).toBeUndefined();
      expect(readRes.body.data.markMessagesRead).toBe(true);
    });

    it('should return total unread count', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`query { totalUnreadMessageCount }`)
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(typeof res.body.data.totalUnreadMessageCount).toBe('number');
    });
  });
});
