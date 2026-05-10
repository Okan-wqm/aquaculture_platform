/**
 * @module Presence E2E Tests
 * @description End-to-end tests for the PresenceService via Redis and the
 * userPresence GraphQL query. Validates online/offline detection, tenant
 * scoping, and batch presence checks.
 *
 * SECURITY: Presence is tenant-scoped — a user online in TENANT_A must
 * appear offline when queried from TENANT_B.
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
  TENANT_A,
  TENANT_B,
  USER_A1,
  USER_A2,
  USER_B1,
  E2eTestContext,
  closeE2eTestApp,
} from './e2e-setup';

/** Redis key format used by PresenceService */
function presenceKey(tenantId: string, userId: string): string {
  return `msg:${tenantId}:presence:${userId}`;
}

/** TTL used by PresenceService for presence keys */
const PRESENCE_TTL = 300;

/** GraphQL query for userPresence */
const USER_PRESENCE_QUERY = `
  query UserPresence($userIds: [ID!]!) {
    userPresence(userIds: $userIds) {
      id
      isOnline
      lastSeenAt
    }
  }
`;

describe('Presence (E2E)', () => {
  let ctx: E2eTestContext;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let redis: Redis;

  beforeAll(async () => {
    ctx = await createE2eTestApp();
    ({ httpServer, dataSource, redis } = ctx);
    await setupTenantSchemas(dataSource, [TENANT_A, TENANT_B]);
  });

  afterAll(async () => {
    await cleanupTenantData(dataSource, TENANT_A);
    await cleanupTenantData(dataSource, TENANT_B);
    await flushAllTestRedisKeys(redis);
    await closeE2eTestApp(ctx);
  });

  afterEach(async () => {
    // Clean up presence keys between tests for isolation
    await redis.del(presenceKey(TENANT_A, USER_A1));
    await redis.del(presenceKey(TENANT_A, USER_A2));
    await redis.del(presenceKey(TENANT_B, USER_A1));
    await redis.del(presenceKey(TENANT_B, USER_B1));
  });

  // ── Online Status Detection ────────────────────────────────────────────

  describe('Online Status', () => {
    it('should return isOnline=true when presence key exists in Redis', async () => {
      // Set user online in Redis (same key format as PresenceService)
      await redis.set(presenceKey(TENANT_A, USER_A1), 'online', 'EX', PRESENCE_TTL);

      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(USER_PRESENCE_QUERY, { userIds: [USER_A1] })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const users = res.body.data.userPresence;
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe(USER_A1);
      expect(users[0].isOnline).toBe(true);
    });

    it('should return isOnline=false when no presence key exists', async () => {
      // Ensure no presence key exists
      await redis.del(presenceKey(TENANT_A, USER_A2));

      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(USER_PRESENCE_QUERY, { userIds: [USER_A2] })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const users = res.body.data.userPresence;
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe(USER_A2);
      expect(users[0].isOnline).toBe(false);
    });
  });

  // ── Tenant Scoping ─────────────────────────────────────────────────────

  describe('Tenant Scoping', () => {
    it('should show user as offline in another tenant', async () => {
      // Set USER_A1 online in TENANT_A
      await redis.set(presenceKey(TENANT_A, USER_A1), 'online', 'EX', PRESENCE_TTL);

      // Verify online in TENANT_A
      const resA = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(USER_PRESENCE_QUERY, { userIds: [USER_A1] })
        .expect(200);

      expect(resA.body.errors).toBeUndefined();
      expect(resA.body.data.userPresence[0].isOnline).toBe(true);

      // Query from TENANT_B — must show offline
      const resB = await gqlRequest(httpServer, TENANT_B, USER_B1)
        .query(USER_PRESENCE_QUERY, { userIds: [USER_A1] })
        .expect(200);

      expect(resB.body.errors).toBeUndefined();
      expect(resB.body.data.userPresence[0].isOnline).toBe(false);

      // Verify the Redis key for TENANT_B does not exist
      const existsB = await redis.exists(presenceKey(TENANT_B, USER_A1));
      expect(existsB).toBe(0);
    });
  });

  // ── Batch Presence Check ───────────────────────────────────────────────

  describe('Batch Presence Check', () => {
    it('should return correct online status for multiple users', async () => {
      // Set USER_A1 online, leave USER_A2 offline
      await redis.set(presenceKey(TENANT_A, USER_A1), 'online', 'EX', PRESENCE_TTL);
      await redis.del(presenceKey(TENANT_A, USER_A2));

      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(USER_PRESENCE_QUERY, { userIds: [USER_A1, USER_A2] })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const users = res.body.data.userPresence;
      expect(users).toHaveLength(2);

      const userA1 = users.find((u: { id: string }) => u.id === USER_A1);
      const userA2 = users.find((u: { id: string }) => u.id === USER_A2);

      expect(userA1.isOnline).toBe(true);
      expect(userA2.isOnline).toBe(false);
    });

    it('should return all offline for empty Redis state', async () => {
      // Ensure both keys are deleted
      await redis.del(presenceKey(TENANT_A, USER_A1));
      await redis.del(presenceKey(TENANT_A, USER_A2));

      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(USER_PRESENCE_QUERY, { userIds: [USER_A1, USER_A2] })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const users = res.body.data.userPresence;
      expect(users).toHaveLength(2);
      expect(users.every((u: { isOnline: boolean }) => u.isOnline === false)).toBe(true);
    });
  });

  // ── Last Seen Tracking ─────────────────────────────────────────────────

  describe('Last Seen', () => {
    it('should return lastSeenAt for offline user with last-seen key', async () => {
      // Simulate a user who went offline — no presence key, but has last-seen
      const lastSeenKey = `msg:${TENANT_A}:lastseen:${USER_A2}`;
      const lastSeenTime = new Date().toISOString();
      await redis.set(lastSeenKey, lastSeenTime);
      await redis.del(presenceKey(TENANT_A, USER_A2));

      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(USER_PRESENCE_QUERY, { userIds: [USER_A2] })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const user = res.body.data.userPresence[0];
      expect(user.isOnline).toBe(false);
      expect(user.lastSeenAt).not.toBeNull();

      // Cleanup
      await redis.del(lastSeenKey);
    });
  });
});
