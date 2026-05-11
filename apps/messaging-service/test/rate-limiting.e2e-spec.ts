/**
 * @module Rate Limiting E2E Tests
 * @description End-to-end tests for the Redis sliding-window rate limiter.
 *
 * IMPORTANT: Uses createE2eTestApp({ enableRateLimiting: true }) to keep the
 * MessagingRateLimitInterceptor active. The default E2E setup disables it
 * via THROTTLE_SKIP env var.
 *
 * The sendMessage rate limit is 30 requests per 60 seconds per user.
 * @see MessagingRateLimitInterceptor DEFAULT_RULES
 */
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import {
  createE2eTestApp,
  gqlRequest,
  expectGqlOk,
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

// ── GraphQL Operations ─────────────────────────────────────────────────────

const CREATE_CHANNEL = `
  mutation CreateChannel($input: CreateChannelInput!) {
    createChannel(input: $input) { id }
  }
`;

const SEND_MESSAGE = `
  mutation SendMessage($input: SendMessageInput!) {
    sendMessage(input: $input) { id }
  }
`;

// ── Test Suite ──────────────────────────────────────────────────────────────

describe('Rate Limiting (E2E)', () => {
  let ctx: E2eTestContext;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let redis: Redis;

  let channelId: string;

  beforeAll(async () => {
    // IMPORTANT: Enable rate limiting for this test suite
    ctx = await createE2eTestApp({ enableRateLimiting: true });
    ({ httpServer, dataSource, redis } = ctx);
    await setupTenantSchemas(dataSource, [TENANT_A]);
    resetIdempotencyCounter();

    // Create a test channel with both users.
    // expectGqlOk surfaces the GraphQL `errors` array on failure
    // (TRACK E) — replaces the historical .expect(200) +
    // body.data.X.id pattern that silently produced
    // "Cannot read properties of null" with no diagnostic content.
    const channelRes = await gqlRequest(httpServer, TENANT_A, ADMIN_A, ['TENANT_ADMIN'])
      .query(CREATE_CHANNEL, {
        input: {
          type: 'GROUP',
          name: 'Hız Sınırı Test Kanalı',
          memberIds: [USER_A1, USER_A2, ADMIN_A],
        },
      });
    const created = expectGqlOk<{ createChannel: { id: string } }>(
      channelRes,
      'createChannel',
    );
    channelId = created.createChannel.id;

    // Flush rate limit keys to ensure clean state
    await flushAllTestRedisKeys(redis);
  });

  afterAll(async () => {
    await cleanupTenantData(dataSource, TENANT_A);
    await flushAllTestRedisKeys(redis);
    // Restore THROTTLE_SKIP for other test suites
    process.env['THROTTLE_SKIP'] = 'true';
    await closeE2eTestApp(ctx);
  });

  // ── Sliding Window Rate Limiter ──────────────────────────────────────────

  describe('sendMessage rate limit (30/min)', () => {
    beforeEach(async () => {
      // Clean rate limit keys before each test to avoid cross-test interference
      await flushAllTestRedisKeys(redis);
    });

    it('should allow up to 30 messages within the rate limit window', async () => {
      const results: boolean[] = [];

      for (let i = 0; i < 30; i++) {
        const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
          .query(SEND_MESSAGE, {
            input: {
              channelId,
              content: `Hız testi mesajı ${i + 1}`,
              contentType: 'TEXT',
              idempotencyKey: nextIdempotencyKey(),
            },
          })
          .expect(200);

        const hasErrors = res.body.errors !== undefined;
        results.push(!hasErrors);
      }

      // All 30 messages should succeed
      const successCount = results.filter(Boolean).length;
      expect(successCount).toBe(30);
    });

    it('should reject the 31st message with rate limit error', async () => {
      // Send 30 messages to fill the window
      for (let i = 0; i < 30; i++) {
        await gqlRequest(httpServer, TENANT_A, USER_A1)
          .query(SEND_MESSAGE, {
            input: {
              channelId,
              content: `Doldurucu mesaj ${i + 1}`,
              contentType: 'TEXT',
              idempotencyKey: nextIdempotencyKey(),
            },
          })
          .expect(200);
      }

      // The 31st message should be rate limited
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(SEND_MESSAGE, {
          input: {
            channelId,
            content: 'Bu mesaj engellenmeli',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        });

      // Rate limit may return 429 status or a GraphQL error
      if (res.status === 429) {
        expect(res.body.message).toMatch(/rate limit|too many/i);
      } else {
        expect(res.body.errors).toBeDefined();
        expect(res.body.errors[0].message).toMatch(/rate limit|too many/i);
      }
    });

    it('should enforce independent rate limits per user', async () => {
      // USER_A1 sends 30 messages (fills their window)
      for (let i = 0; i < 30; i++) {
        await gqlRequest(httpServer, TENANT_A, USER_A1)
          .query(SEND_MESSAGE, {
            input: {
              channelId,
              content: `A1 mesajı ${i + 1}`,
              contentType: 'TEXT',
              idempotencyKey: nextIdempotencyKey(),
            },
          })
          .expect(200);
      }

      // USER_A1 should be rate limited now
      const blockedRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(SEND_MESSAGE, {
          input: {
            channelId,
            content: 'A1 engellenmeli',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        });

      const a1Blocked =
        blockedRes.status === 429 ||
        (blockedRes.body.errors && blockedRes.body.errors[0].message.match(/rate limit|too many/i));
      expect(a1Blocked).toBeTruthy();

      // USER_A2 should still be able to send (independent limit)
      const a2Res = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(SEND_MESSAGE, {
          input: {
            channelId,
            content: 'A2 hala gönderebilir',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);

      expect(a2Res.body.errors).toBeUndefined();
      expect(a2Res.body.data.sendMessage.id).toBeTruthy();
    });
  });
});
