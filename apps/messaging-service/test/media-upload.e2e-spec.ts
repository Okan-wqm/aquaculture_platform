/**
 * @module Media Upload E2E Tests
 * @description End-to-end tests for media upload presigned URL generation,
 * MIME type validation, and channel membership enforcement.
 *
 * SECURITY: SVG uploads are blocked because SVG files can contain embedded
 * JavaScript (<script> tags, event handlers) that execute when browsers
 * render them — a stored XSS vector for all channel viewers.
 *
 * Note: Presigned URL generation may fail without a real MinIO instance.
 * These tests focus on validation logic (MIME checks, membership checks)
 * that runs BEFORE the S3 presigned URL call. If MinIO is available,
 * the full flow is tested; if not, we verify the correct validation errors.
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

const REQUEST_MEDIA_UPLOAD = `
  mutation RequestMediaUpload($input: RequestMediaUploadInput!) {
    requestMediaUpload(input: $input) {
      uploadUrl
      storageKey
      expiresAt
    }
  }
`;

describe('Media Upload (E2E)', () => {
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

    // Create a channel with USER_A1 and USER_A2 (ADMIN_A excluded for non-member test)
    const channelRes = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
      .query(`
        mutation CreateChannel($input: CreateChannelInput!) {
          createChannel(input: $input) { id }
        }
      `, {
        input: {
          type: 'GROUP',
          name: 'Medya Yükleme Testi',
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

  // ── MIME Type Validation ───────────────────────────────────────────────

  describe('MIME Type Validation', () => {
    it('should accept valid image MIME type (image/jpeg)', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(REQUEST_MEDIA_UPLOAD, {
          input: {
            channelId,
            filename: 'balik-foto.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1024,
          },
        })
        .expect(200);

      if (res.body.errors) {
        // If MinIO is not available, the error should NOT be about MIME validation.
        // MIME validation runs before the S3 call, so a MIME error here means failure.
        const errorMsg = res.body.errors[0].message;
        expect(errorMsg).not.toMatch(/mime|not allowed|svg/i);
      } else {
        // Full success — MinIO is available
        const result = res.body.data.requestMediaUpload;
        expect(result.uploadUrl).toBeTruthy();
        expect(result.storageKey).toBeTruthy();
        expect(result.expiresAt).toBeTruthy();
        // Storage key should contain the tenant ID for isolation
        expect(result.storageKey).toContain(TENANT_A);
      }
    });

    it('should accept valid PNG MIME type', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(REQUEST_MEDIA_UPLOAD, {
          input: {
            channelId,
            filename: 'havuz-harita.png',
            mimeType: 'image/png',
            fileSize: 2048,
          },
        })
        .expect(200);

      if (res.body.errors) {
        // Should not be a MIME validation error
        expect(res.body.errors[0].message).not.toMatch(/mime|not allowed/i);
      } else {
        expect(res.body.data.requestMediaUpload.storageKey).toBeTruthy();
      }
    });

    it('should accept PDF MIME type', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(REQUEST_MEDIA_UPLOAD, {
          input: {
            channelId,
            filename: 'su-kalitesi-raporu.pdf',
            mimeType: 'application/pdf',
            fileSize: 5120,
          },
        })
        .expect(200);

      if (res.body.errors) {
        expect(res.body.errors[0].message).not.toMatch(/mime|not allowed/i);
      } else {
        expect(res.body.data.requestMediaUpload.storageKey).toBeTruthy();
      }
    });

    it('should block SVG MIME type (XSS vector)', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(REQUEST_MEDIA_UPLOAD, {
          input: {
            channelId,
            filename: 'logo.svg',
            mimeType: 'image/svg+xml',
            fileSize: 512,
          },
        })
        .expect(200);

      // SVG must be rejected at the MIME validation layer
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/mime|not allowed|svg/i);
    });

    it('should block executable MIME type', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(REQUEST_MEDIA_UPLOAD, {
          input: {
            channelId,
            filename: 'setup.exe',
            mimeType: 'application/x-msdownload',
            fileSize: 1024,
          },
        })
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/mime|not allowed/i);
    });
  });

  // ── Channel Membership Enforcement ─────────────────────────────────────

  describe('Channel Membership', () => {
    it('should reject upload request from non-member', async () => {
      // ADMIN_A is NOT a member of the test channel
      const res = await gqlRequest(httpServer, TENANT_A, ADMIN_A)
        .query(REQUEST_MEDIA_UPLOAD, {
          input: {
            channelId,
            filename: 'yetkisiz.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1024,
          },
        })
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/forbidden|not (an active )?member/i);
    });

    it('should allow upload from channel member', async () => {
      // USER_A2 IS a member
      const res = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(REQUEST_MEDIA_UPLOAD, {
          input: {
            channelId,
            filename: 'uye-foto.jpg',
            mimeType: 'image/jpeg',
            fileSize: 1024,
          },
        })
        .expect(200);

      if (res.body.errors) {
        // Should not be a membership error
        expect(res.body.errors[0].message).not.toMatch(/forbidden|not (an active )?member/i);
      } else {
        expect(res.body.data.requestMediaUpload.storageKey).toBeTruthy();
      }
    });
  });

  // ── Message with Attachment Keys ───────────────────────────────────────

  describe('Message with Attachments', () => {
    it('should accept sendMessage with attachmentKeys parameter', async () => {
      // WHY: This tests that the sendMessage mutation accepts attachmentKeys
      // without validation errors (the attachment validation against MinIO
      // may fail, but the GraphQL schema and input validation should pass).
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation SendMessage($input: SendMessageInput!) {
            sendMessage(input: $input) { id content }
          }
        `, {
          input: {
            channelId,
            content: 'Ek dosya ile mesaj',
            contentType: 'FILE',
            idempotencyKey: nextIdempotencyKey(),
            attachmentKeys: [`messaging/${TENANT_A}/${channelId}/2026/04/test-file.jpg`],
          },
        })
        .expect(200);

      // The attachment key validation may fail (no real MinIO), but the
      // error should be about the attachment not being found — not about
      // schema validation or membership.
      if (res.body.errors) {
        const msg = res.body.errors[0].message;
        // Acceptable errors: attachment not found, upload incomplete, or S3 error
        expect(msg).toMatch(/attachment|not found|upload|could not verify|s3/i);
      } else {
        // If MinIO is available and the key resolves, message should be created
        expect(res.body.data.sendMessage.id).toBeTruthy();
      }
    });
  });

  // ── Audio MIME Types (Voice Notes) ─────────────────────────────────────

  describe('Audio MIME Types', () => {
    it('should accept audio/webm for voice notes', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(REQUEST_MEDIA_UPLOAD, {
          input: {
            channelId,
            filename: 'sesli-not.webm',
            mimeType: 'audio/webm',
            fileSize: 8192,
          },
        })
        .expect(200);

      if (res.body.errors) {
        // Should not be a MIME validation error
        expect(res.body.errors[0].message).not.toMatch(/mime|not allowed/i);
      } else {
        expect(res.body.data.requestMediaUpload.storageKey).toBeTruthy();
      }
    });

    it('should accept audio/ogg for audio messages', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(REQUEST_MEDIA_UPLOAD, {
          input: {
            channelId,
            filename: 'kayit.ogg',
            mimeType: 'audio/ogg',
            fileSize: 4096,
          },
        })
        .expect(200);

      if (res.body.errors) {
        expect(res.body.errors[0].message).not.toMatch(/mime|not allowed/i);
      } else {
        expect(res.body.data.requestMediaUpload.storageKey).toBeTruthy();
      }
    });
  });
});
