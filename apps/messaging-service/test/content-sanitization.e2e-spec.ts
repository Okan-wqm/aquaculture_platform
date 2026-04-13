/**
 * @module Content Sanitization E2E Tests
 * @description End-to-end tests verifying that the SendMessageHandler and
 * EditMessageHandler correctly strip HTML, block dangerous URL schemes,
 * preserve safe URLs, and keep emoji characters intact.
 *
 * SECURITY: These tests are critical for XSS prevention — a regression in
 * content sanitization could expose all channel viewers to stored XSS.
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
  E2eTestContext,
} from './e2e-setup';

describe('Content Sanitization (E2E)', () => {
  let ctx: E2eTestContext;
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let redis: Redis;

  let channelId: string;

  beforeAll(async () => {
    ctx = await createE2eTestApp();
    ({ app, httpServer, dataSource, redis } = ctx);
    await setupTenantSchemas(dataSource, [TENANT_A]);
    resetIdempotencyCounter();

    // Create a shared channel for sanitization tests
    const channelRes = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
      .query(`
        mutation CreateChannel($input: CreateChannelInput!) {
          createChannel(input: $input) { id }
        }
      `, {
        input: {
          type: 'GROUP',
          name: 'Sanitizasyon Testi',
          memberIds: [USER_A1, USER_A2],
        },
      })
      .expect(200);

    channelId = channelRes.body.data.createChannel.id;
  });

  afterAll(async () => {
    await cleanupTenantData(dataSource, TENANT_A);
    await flushAllTestRedisKeys(redis);
    await app.close();
  });

  // ── HTML Tag Stripping ─────────────────────────────────────────────────

  describe('HTML Tag Stripping', () => {
    it('should strip HTML tags from message content', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) {
              id content
            }
          }
        `, {
          input: {
            channelId,
            content: '<script>alert(1)</script>Merhaba',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const msg = res.body.data.sendMessage;
      // Script tags must be stripped; only "Merhaba" should remain
      expect(msg.content).not.toContain('<script>');
      expect(msg.content).not.toContain('</script>');
      expect(msg.content).not.toContain('alert');
      expect(msg.content).toContain('Merhaba');
    });

    it('should strip nested HTML tags from content', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id content }
          }
        `, {
          input: {
            channelId,
            content: '<div><b>Kalın</b> ve <i>italik</i> balık raporu</div>',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const content = res.body.data.sendMessage.content;
      expect(content).not.toContain('<div>');
      expect(content).not.toContain('<b>');
      expect(content).not.toContain('<i>');
      expect(content).toContain('Kalın');
      expect(content).toContain('italik');
      expect(content).toContain('balık raporu');
    });
  });

  // ── Dangerous URL Schemes ──────────────────────────────────────────────

  describe('Dangerous URL Scheme Blocking', () => {
    it('should block javascript: URL scheme', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id content }
          }
        `, {
          input: {
            channelId,
            content: 'javascript:alert(1)',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      // The sanitizer strips the javascript: prefix; if the remaining content
      // is non-empty the message is saved without the scheme, otherwise an
      // error may be returned for empty content after sanitization.
      if (res.body.errors) {
        // Acceptable: error for disallowed URL scheme or empty content
        expect(res.body.errors[0].message).toMatch(/url|scheme|content|empty/i);
      } else {
        // If message was saved, javascript: must have been stripped
        expect(res.body.data.sendMessage.content).not.toContain('javascript:');
      }
    });

    it('should sanitize data: URL from content', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id content }
          }
        `, {
          input: {
            channelId,
            content: 'Rapor: data:text/html,<h1>test</h1> bakınız',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      if (res.body.errors) {
        expect(res.body.errors[0].message).toMatch(/url|scheme/i);
      } else {
        const content = res.body.data.sendMessage.content;
        // data: scheme must be stripped
        expect(content).not.toContain('data:');
        // The surrounding text should be preserved
        expect(content).toContain('Rapor');
      }
    });
  });

  // ── Safe URL Preservation ──────────────────────────────────────────────

  describe('Safe URL Preservation', () => {
    it('should preserve http and https URLs', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id content }
          }
        `, {
          input: {
            channelId,
            content: 'Detaylar: https://example.com/balik-raporu ve http://aqua.local/durum',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const content = res.body.data.sendMessage.content;
      expect(content).toContain('https://example.com/balik-raporu');
      expect(content).toContain('http://aqua.local/durum');
    });
  });

  // ── Content Sanitization on Edit ───────────────────────────────────────

  describe('Edit Sanitization', () => {
    it('should strip HTML tags on message edit', async () => {
      // First send a clean message
      const sendRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id content }
          }
        `, {
          input: {
            channelId,
            content: 'Orijinal mesaj',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      expect(sendRes.body.errors).toBeUndefined();
      const messageId = sendRes.body.data.sendMessage.id;

      // Edit with HTML content
      const editRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation EditMessage($id: ID!, $input: EditMessageInput!) {
            editMessage(id: $id, input: $input) {
              id content editedAt
            }
          }
        `, {
          id: messageId,
          input: { content: '<b>Kalın yazı</b> ve <img src=x onerror=alert(1)> içerik' },
        })
        .expect(200);

      expect(editRes.body.errors).toBeUndefined();
      const edited = editRes.body.data.editMessage;
      expect(edited.content).not.toContain('<b>');
      expect(edited.content).not.toContain('</b>');
      expect(edited.content).not.toContain('<img');
      expect(edited.content).not.toContain('onerror');
      expect(edited.content).toContain('Kalın yazı');
      expect(edited.editedAt).not.toBeNull();
    });
  });

  // ── Emoji Preservation ─────────────────────────────────────────────────

  describe('Emoji Preservation', () => {
    it('should preserve emoji characters in content', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id content }
          }
        `, {
          input: {
            channelId,
            content: 'Balık sağlığı iyi 🐟🌊 Oksijen normal 👍',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const content = res.body.data.sendMessage.content;
      expect(content).toContain('🐟');
      expect(content).toContain('🌊');
      expect(content).toContain('👍');
      expect(content).toContain('Balık sağlığı iyi');
    });

    it('should preserve emoji-only messages', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id content }
          }
        `, {
          input: {
            channelId,
            content: '🐟🌊🦐🐠',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const content = res.body.data.sendMessage.content;
      expect(content).toContain('🐟');
      expect(content).toContain('🌊');
      expect(content).toContain('🦐');
      expect(content).toContain('🐠');
    });
  });
});
