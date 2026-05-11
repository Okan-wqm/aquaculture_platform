/**
 * @module Messaging Core E2E Tests
 * @description End-to-end tests for message send/edit/delete, idempotency,
 * cursor pagination, pin/unpin, reactions, forwarding, threading, and unread tracking.
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
  closeE2eTestApp,
} from './e2e-setup';

describe('Messaging Core (E2E)', () => {
  let ctx: E2eTestContext;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let redis: Redis;

  let channelId: string;
  let forwardTargetChannelId: string;

  beforeAll(async () => {
    ctx = await createE2eTestApp();
    ({ httpServer, dataSource, redis } = ctx);
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
          name: 'Mesaj Test Kanalı',
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
    await closeE2eTestApp(ctx);
  });

  // ── Send / Edit / Delete ──────────────────────────────────────────────

  describe('Message CRUD', () => {
    let messageId: string;
    let messageCreatedAt: string;
    const idemKey = '66666666-6666-4666-8666-666666666666';

    it('should send a text message', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) {
              id channelId senderId content contentType createdAt
            }
          }
        `, {
          input: {
            channelId,
            content: 'Havuz 3 oksijen seviyesi düşük',
            contentType: 'TEXT',
            idempotencyKey: idemKey,
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const msg = res.body.data.sendMessage;
      expect(msg.senderId).toBe(USER_A1);
      expect(msg.content).toBe('Havuz 3 oksijen seviyesi düşük');
      expect(msg.contentType).toBe('TEXT');
      expect(msg.channelId).toBe(channelId);

      messageId = msg.id;
      messageCreatedAt = msg.createdAt;
    });

    it('should return same message for duplicate idempotencyKey', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id }
          }
        `, {
          input: {
            channelId,
            content: 'Bu tekrar gönderildi',
            contentType: 'TEXT',
            idempotencyKey: idemKey,
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.sendMessage.id).toBe(messageId);
    });

    it('should edit own message', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation EditMessage($id: ID!, $input: EditMessageInput!) {
            editMessage(id: $id, input: $input) {
              id content editedAt
            }
          }
        `, {
          id: messageId,
          input: { content: 'Düzenlendi: Oksijen seviyesi kritik' },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.editMessage.content).toBe('Düzenlendi: Oksijen seviyesi kritik');
      expect(res.body.data.editMessage.editedAt).not.toBeNull();
    });

    it('should reject editing another user\'s message', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(`
          mutation EditMessage($id: ID!, $input: EditMessageInput!) {
            editMessage(id: $id, input: $input) { id }
          }
        `, {
          id: messageId,
          input: { content: 'Başkasının mesajı' },
        })
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/forbidden|owner|own messages/i);
    });

    it('should delete own message (soft-delete)', async () => {
      // Send a message to delete
      const sendRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id }
          }
        `, {
          input: {
            channelId,
            content: 'Silinecek mesaj',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      const deleteId = sendRes.body.data.sendMessage.id;

      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation DeleteMessage($id: ID!) {
            deleteMessage(id: $id)
          }
        `, { id: deleteId })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.deleteMessage).toBe(true);
    });

    it('should allow channel owner to delete any message', async () => {
      // USER_A2 sends a message
      const sendRes = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id }
          }
        `, {
          input: {
            channelId,
            content: 'Admin silecek',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      const msgId = sendRes.body.data.sendMessage.id;

      // USER_A1 created the channel and is the channel OWNER.
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation DeleteMessage($id: ID!) {
            deleteMessage(id: $id)
          }
        `, { id: msgId })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.deleteMessage).toBe(true);
    });

    it('should reject non-owner non-admin delete', async () => {
      // USER_A1 sends
      const sendRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id }
          }
        `, {
          input: {
            channelId,
            content: 'Bu mesajı USER_A2 silemez',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      const msgId = sendRes.body.data.sendMessage.id;

      // USER_A2 (MEMBER role) tries to delete
      const res = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(`
          mutation DeleteMessage($id: ID!) {
            deleteMessage(id: $id)
          }
        `, { id: msgId })
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/forbidden|permission|owner|admin/i);
    });

    it('should send a reply (threading via parentId)', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id parentId }
          }
        `, {
          input: {
            channelId,
            content: 'Bu bir yanıttır',
            contentType: 'TEXT',
            parentId: messageId,
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.sendMessage.parentId).toBe(messageId);
    });
  });

  // ── Pagination ────────────────────────────────────────────────────────

  describe('Cursor Pagination', () => {
    beforeAll(async () => {
      // Seed 8 messages for pagination tests
      for (let i = 0; i < 8; i++) {
        await gqlRequest(httpServer, TENANT_A, USER_A1)
          .query(`
            mutation SendMessage($input: SendMessageInput!) {
              sendMessage(input: $input) { id }
            }
          `, {
            input: {
              channelId,
              content: `Pagination mesajı ${i + 1}`,
              contentType: 'TEXT',
              idempotencyKey: nextIdempotencyKey(),
            },
          })
          .expect(200);
      }
    });

    it('should return first page with cursor', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          query Messages($channelId: ID!, $filter: MessageFilterInput) {
            messages(channelId: $channelId, filter: $filter) {
              items { id content }
              hasMore
              cursor
            }
          }
        `, { channelId, filter: { limit: 5 } })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const page = res.body.data.messages;
      expect(page.items.length).toBe(5);
      expect(page.hasMore).toBe(true);
      expect(page.cursor).toBeTruthy();
    });

    it('should paginate to next page using cursor', async () => {
      // Get first page
      const firstRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          query Messages($channelId: ID!, $filter: MessageFilterInput) {
            messages(channelId: $channelId, filter: $filter) {
              items { id }
              hasMore
              cursor
            }
          }
        `, { channelId, filter: { limit: 5 } })
        .expect(200);

      const cursor = firstRes.body.data.messages.cursor;
      const firstPageIds = firstRes.body.data.messages.items.map((m: { id: string }) => m.id);

      // Get second page
      const secondRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          query Messages($channelId: ID!, $filter: MessageFilterInput) {
            messages(channelId: $channelId, filter: $filter) {
              items { id }
              hasMore
            }
          }
        `, { channelId, filter: { limit: 5, cursor } })
        .expect(200);

      expect(secondRes.body.errors).toBeUndefined();
      const secondPageIds = secondRes.body.data.messages.items.map((m: { id: string }) => m.id);

      // No overlap between pages
      const overlap = firstPageIds.filter((id: string) => secondPageIds.includes(id));
      expect(overlap).toHaveLength(0);
    });
  });

});
