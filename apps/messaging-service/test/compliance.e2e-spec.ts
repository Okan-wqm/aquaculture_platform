/**
 * @module Compliance E2E Tests
 * @description End-to-end tests for compliance features: retention policies,
 * legal holds, audit log, and role-based access control.
 *
 * All compliance operations require TENANT_ADMIN role.
 * Tests verify the full NestJS stack: middleware -> guards -> resolver -> CQRS -> database.
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
    sendMessage(input: $input) { id createdAt }
  }
`;

const DELETE_MESSAGE = `
  mutation DeleteMessage($id: ID!) {
    deleteMessage(id: $id)
  }
`;

const SET_RETENTION_POLICY = `
  mutation SetRetentionPolicy($input: SetRetentionPolicyInput!) {
    setRetentionPolicy(input: $input) {
      id retentionDays channelId
    }
  }
`;

const GET_RETENTION_POLICIES = `
  query RetentionPolicies {
    retentionPolicies { id retentionDays channelId }
  }
`;

const TOGGLE_LEGAL_HOLD = `
  mutation ToggleLegalHold($input: ToggleLegalHoldInput!) {
    toggleLegalHold(input: $input) {
      id isActive legalMatterId reason channelId
    }
  }
`;

const GET_AUDIT_LOG = `
  query AuditLog($limit: Int) {
    auditLog(limit: $limit) {
      items { id action resourceType userId }
      hasMore
      totalCount
    }
  }
`;

const GET_COMPLIANCE_STATS = `
  query ComplianceStats {
    complianceStats {
      activeHoldsCount retentionPoliciesCount
    }
  }
`;

// ── Test Suite ──────────────────────────────────────────────────────────────

describe('Compliance (E2E)', () => {
  let ctx: E2eTestContext;
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let redis: Redis;

  let channelId: string;
  let messageId: string;

  const LEGAL_MATTER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  beforeAll(async () => {
    ctx = await createE2eTestApp();
    ({ app, httpServer, dataSource, redis } = ctx);
    await setupTenantSchemas(dataSource, [TENANT_A]);
    resetIdempotencyCounter();

    // Create a test channel with all users
    const channelRes = await gqlRequest(httpServer, TENANT_A, ADMIN_A, ['TENANT_ADMIN'])
      .query(CREATE_CHANNEL, {
        input: {
          type: 'GROUP',
          name: 'Uyumluluk Test Kanalı',
          memberIds: [USER_A1, USER_A2, ADMIN_A],
        },
      })
      .expect(200);
    channelId = channelRes.body.data.createChannel.id;

    // Send a test message
    const msgRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
      .query(SEND_MESSAGE, {
        input: {
          channelId,
          content: 'Uyumluluk testi mesajı',
          contentType: 'TEXT',
          idempotencyKey: nextIdempotencyKey(),
        },
      })
      .expect(200);
    messageId = msgRes.body.data.sendMessage.id;
  });

  afterAll(async () => {
    await cleanupTenantData(dataSource, TENANT_A);
    await flushAllTestRedisKeys(redis);
    await app.close();
  });

  // ── Retention Policies ───────────────────────────────────────────────────

  describe('Retention Policies', () => {
    it('should create a tenant-wide retention policy', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, ADMIN_A, ['TENANT_ADMIN'])
        .query(SET_RETENTION_POLICY, {
          input: { retentionDays: 365, channelId: null },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const policy = res.body.data.setRetentionPolicy;
      expect(policy.retentionDays).toBe(365);
      expect(policy.channelId).toBeNull();
      expect(policy.id).toBeTruthy();
    });

    it('should create a channel-level retention override', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, ADMIN_A, ['TENANT_ADMIN'])
        .query(SET_RETENTION_POLICY, {
          input: { retentionDays: 90, channelId },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const policy = res.body.data.setRetentionPolicy;
      expect(policy.retentionDays).toBe(90);
      expect(policy.channelId).toBe(channelId);
    });

    it('should list all retention policies for the tenant', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, ADMIN_A, ['TENANT_ADMIN'])
        .query(GET_RETENTION_POLICIES)
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const policies = res.body.data.retentionPolicies;
      expect(policies.length).toBeGreaterThanOrEqual(2);

      // Verify both tenant-wide and channel-level policies exist
      const tenantWide = policies.find(
        (p: { channelId: string | null }) => p.channelId === null,
      );
      const channelLevel = policies.find(
        (p: { channelId: string | null }) => p.channelId === channelId,
      );
      expect(tenantWide).toBeDefined();
      expect(channelLevel).toBeDefined();
      expect(tenantWide.retentionDays).toBe(365);
      expect(channelLevel.retentionDays).toBe(90);
    });
  });

  // ── Legal Holds ──────────────────────────────────────────────────────────

  describe('Legal Holds', () => {
    let holdId: string;
    let holdTargetMessageId: string;

    beforeAll(async () => {
      // Send a message that will be tested under legal hold
      const msgRes = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(SEND_MESSAGE, {
          input: {
            channelId,
            content: 'Yasal bekleme altındaki mesaj',
            contentType: 'TEXT',
            idempotencyKey: nextIdempotencyKey(),
          },
        })
        .expect(200);
      holdTargetMessageId = msgRes.body.data.sendMessage.id;
    });

    it('should activate a legal hold on a channel', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, ADMIN_A, ['TENANT_ADMIN'])
        .query(TOGGLE_LEGAL_HOLD, {
          input: {
            activate: true,
            channelId,
            legalMatterId: LEGAL_MATTER_ID,
            reason: 'Soruşturma kapsamında kanal donduruluyor',
            holdId: null,
            legalMatterDescription: null,
            requestedBy: null,
            expiresAt: null,
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const hold = res.body.data.toggleLegalHold;
      expect(hold.isActive).toBe(true);
      expect(hold.legalMatterId).toBe(LEGAL_MATTER_ID);
      expect(hold.reason).toBe('Soruşturma kapsamında kanal donduruluyor');
      expect(hold.channelId).toBe(channelId);

      holdId = hold.id;
    });

    it('should block message deletion when channel is under legal hold', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(DELETE_MESSAGE, { id: holdTargetMessageId })
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/legal hold/i);
    });

    it('should release a legal hold', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, ADMIN_A, ['TENANT_ADMIN'])
        .query(TOGGLE_LEGAL_HOLD, {
          input: {
            activate: false,
            holdId,
            channelId: null,
            legalMatterId: null,
            reason: null,
            legalMatterDescription: null,
            requestedBy: null,
            expiresAt: null,
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const hold = res.body.data.toggleLegalHold;
      expect(hold.isActive).toBe(false);
    });

    it('should allow message deletion after legal hold is released', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(DELETE_MESSAGE, { id: holdTargetMessageId })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.deleteMessage).toBe(true);
    });
  });

  // ── Audit Log ────────────────────────────────────────────────────────────

  describe('Audit Log', () => {
    it('should return paginated audit log entries', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, ADMIN_A, ['TENANT_ADMIN'])
        .query(GET_AUDIT_LOG, { limit: 10 })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const auditPage = res.body.data.auditLog;
      expect(auditPage.items).toBeDefined();
      expect(Array.isArray(auditPage.items)).toBe(true);
      expect(typeof auditPage.totalCount).toBe('number');

      // Verify each entry has required fields
      for (const entry of auditPage.items) {
        expect(entry.id).toBeTruthy();
        expect(entry.action).toBeTruthy();
        expect(entry.resourceType).toBeTruthy();
        expect(entry.userId).toBeTruthy();
      }
    });
  });

  // ── Compliance Stats ─────────────────────────────────────────────────────

  describe('Compliance Stats', () => {
    it('should return compliance statistics', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, ADMIN_A, ['TENANT_ADMIN'])
        .query(GET_COMPLIANCE_STATS)
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const stats = res.body.data.complianceStats;
      expect(typeof stats.activeHoldsCount).toBe('number');
      expect(typeof stats.retentionPoliciesCount).toBe('number');
    });
  });

  // ── Role-Based Access Control ────────────────────────────────────────────

  describe('Non-admin Access Denied', () => {
    it('should reject retention policy query from MODULE_USER', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['MODULE_USER'])
        .query(GET_RETENTION_POLICIES)
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toBe('Access denied');
      expect(res.body.errors[0].extensions?.code).toBe('FORBIDDEN');
    });

    it('should reject legal hold mutation from MODULE_USER', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['MODULE_USER'])
        .query(TOGGLE_LEGAL_HOLD, {
          input: {
            activate: true,
            channelId,
            legalMatterId: LEGAL_MATTER_ID,
            reason: 'Yetkisiz deneme',
            holdId: null,
            legalMatterDescription: null,
            requestedBy: null,
            expiresAt: null,
          },
        })
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toBe('Access denied');
      expect(res.body.errors[0].extensions?.code).toBe('FORBIDDEN');
    });

    it('should reject audit log query from MODULE_USER', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['MODULE_USER'])
        .query(GET_AUDIT_LOG, { limit: 5 })
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toBe('Access denied');
      expect(res.body.errors[0].extensions?.code).toBe('FORBIDDEN');
    });

    it('should reject compliance stats query from MODULE_USER', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['MODULE_USER'])
        .query(GET_COMPLIANCE_STATS)
        .expect(200);

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toBe('Access denied');
      expect(res.body.errors[0].extensions?.code).toBe('FORBIDDEN');
    });
  });
});
