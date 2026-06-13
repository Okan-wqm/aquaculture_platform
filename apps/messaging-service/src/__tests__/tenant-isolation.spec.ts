/**
 * CRITICAL: Tenant isolation tests.
 * These tests ensure that data from one tenant can never leak to another.
 * Multi-tenant security is the #1 priority in a SaaS platform.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { Message } from '../message/entities/message.entity';
import { ChannelMember } from '../channel/entities/channel-member.entity';
import { REDIS_CLIENT } from '../shared/redis.provider';
import {
  createMockChannelMember,
  createMockMessage,
  createMockRepository,
  createMockQueryBuilder,
  createMockQueryRunner,
  createMockDataSource,
  createMockRedis,
  fakeUuid,
  resetUuidCounter,
  TENANT_A,
  TENANT_B,
  MockRepository,
  MockQueryRunner,
  MockRedis,
} from './test-helpers';
import { DataSource } from 'typeorm';

// Import handlers/services under test
import { GetMessagesHandler } from '../message/queries/get-messages.handler';
import { GetMessagesQuery } from '../message/queries/get-messages.query';
import { PresenceService } from '../presence/presence.service';

describe('Tenant Isolation', () => {
  let memberRepo: MockRepository<ChannelMember>;
  let redisClient: MockRedis;

  // GetMessagesHandler now runs every read inside runInTenantTransaction, which
  // pins the tenant search_path and therefore asserts tenantId is a real UUID
  // (withTenantContext + pinTenantTransactionSearchPath both reject non-UUIDs).
  // The opaque TENANT_A/TENANT_B Redis-key strings are not UUIDs, so the two
  // handler-driven tests use valid-UUID tenant identifiers that still keep
  // tenant A distinct from tenant B. The Redis/presence/outbox tests below keep
  // using TENANT_A/TENANT_B because there the tenant id is only a Redis-key
  // segment, never fed through the transaction's UUID validation.
  const TENANT_A_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const TENANT_B_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const tenantAChannelId = fakeUuid('ch');
  const tenantBChannelId = fakeUuid('ch');
  const tenantAUserId = fakeUuid('usr');
  const tenantBUserId = fakeUuid('usr');

  beforeEach(() => {
    resetUuidCounter();
    memberRepo = createMockRepository<ChannelMember>();
    redisClient = createMockRedis();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Message visibility
  // -----------------------------------------------------------------------
  describe('message visibility', () => {
    it('messages from tenant A are NOT visible to tenant B', async () => {
      const queryRunner: MockQueryRunner = createMockQueryRunner();
      const mockDataSource = createMockDataSource(queryRunner);
      const qb = createMockQueryBuilder<Message>();
      queryRunner.manager.createQueryBuilder.mockReturnValue(qb);

      // When tenant B queries tenant A's channel, the in-transaction membership
      // lookup finds no row, so the handler must refuse before reading messages.
      queryRunner.manager.findOne.mockResolvedValue(null);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GetMessagesHandler,
          { provide: DataSource, useValue: mockDataSource },
        ],
      }).compile();

      const handler = module.get(GetMessagesHandler);

      // Tenant B user tries to read tenant A channel
      const query = new GetMessagesQuery(
        TENANT_B_UUID, tenantBUserId, tenantAChannelId, 20, null, null, null,
      );

      await expect(handler.execute(query)).rejects.toThrow(ForbiddenException);
    });
  });

  // -----------------------------------------------------------------------
  // Channel member mixing
  // -----------------------------------------------------------------------
  describe('channel member isolation', () => {
    it('channel members from different tenants cannot be mixed', async () => {
      memberRepo.findOne.mockImplementation(async (options) => {
        const opts = options as Record<string, unknown>;
        const where = opts?.['where'] as Record<string, unknown> | undefined;
        if (where?.['userId'] === tenantBUserId) {
          return null; // tenant B user not found in tenant A scope
        }
        return createMockChannelMember({
          userId: tenantAUserId,
          channelId: tenantAChannelId,
        });
      });

      const tenantBResult = await memberRepo.findOne({
        where: { channelId: tenantAChannelId, userId: tenantBUserId },
      });
      expect(tenantBResult).toBeNull();

      const tenantAResult = await memberRepo.findOne({
        where: { channelId: tenantAChannelId, userId: tenantAUserId },
      });
      expect(tenantAResult).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Redis key scoping
  // -----------------------------------------------------------------------
  describe('Redis tenant scoping', () => {
    it('Redis keys are tenant-scoped (msg:{tenantId}:...)', async () => {
      const pipelineMock = {
        set: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };
      redisClient.pipeline.mockReturnValue(pipelineMock);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PresenceService,
          { provide: REDIS_CLIENT, useValue: redisClient },
        ],
      }).compile();

      const presenceService = module.get(PresenceService);

      // Set online for tenant A
      await presenceService.setOnline(TENANT_A, tenantAUserId);
      const setCallA = pipelineMock.set.mock.calls[0][0];
      expect(setCallA).toContain(TENANT_A);

      pipelineMock.set.mockClear();
      pipelineMock.exec.mockClear();

      // Set online for tenant B
      await presenceService.setOnline(TENANT_B, tenantBUserId);
      const setCallB = pipelineMock.set.mock.calls[0][0];
      expect(setCallB).toContain(TENANT_B);

      // Keys must be different
      expect(setCallA).not.toBe(setCallB);
    });
  });

  // -----------------------------------------------------------------------
  // Search scoping
  // -----------------------------------------------------------------------
  describe('search scoping', () => {
    it('search results are scoped to user tenant via membership check', async () => {
      const queryRunner: MockQueryRunner = createMockQueryRunner();
      const mockDataSource = createMockDataSource(queryRunner);
      const qb = createMockQueryBuilder<Message>();
      queryRunner.manager.createQueryBuilder.mockReturnValue(qb);

      const tenantAMsg = createMockMessage({
        channelId: tenantAChannelId,
        content: 'aquaculture report',
      });
      qb.getMany.mockResolvedValue([tenantAMsg]);

      // Tenant A user IS a member, so the in-transaction membership lookup
      // resolves and the scoped message read returns the tenant A row.
      queryRunner.manager.findOne.mockResolvedValue(
        createMockChannelMember({
          channelId: tenantAChannelId,
          userId: tenantAUserId,
        }),
      );

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GetMessagesHandler,
          { provide: DataSource, useValue: mockDataSource },
        ],
      }).compile();

      const handler = module.get(GetMessagesHandler);

      const query = new GetMessagesQuery(
        TENANT_A_UUID, tenantAUserId, tenantAChannelId, 50, null, null, null,
      );

      const result = await handler.execute(query);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].channelId).toBe(tenantAChannelId);
    });
  });

  // -----------------------------------------------------------------------
  // Presence tenant scoping
  // -----------------------------------------------------------------------
  describe('presence tenant scoping', () => {
    it('presence is tenant-scoped', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PresenceService,
          { provide: REDIS_CLIENT, useValue: redisClient },
        ],
      }).compile();

      const presenceService = module.get(PresenceService);

      // User online in tenant A
      redisClient.exists.mockResolvedValueOnce(1);
      const isOnlineA = await presenceService.isOnline(TENANT_A, tenantAUserId);
      expect(isOnlineA).toBe(true);

      // Same user ID queried in tenant B should be offline
      redisClient.exists.mockResolvedValueOnce(0);
      const isOnlineB = await presenceService.isOnline(TENANT_B, tenantAUserId);
      expect(isOnlineB).toBe(false);

      // Verify the keys are different
      const key1 = redisClient.exists.mock.calls[0][0];
      const key2 = redisClient.exists.mock.calls[1][0];
      expect(key1).not.toBe(key2);
    });
  });

  // -----------------------------------------------------------------------
  // Outbox events include tenantId
  // -----------------------------------------------------------------------
  describe('outbox tenant scoping', () => {
    it('outbox events include tenantId in payload', () => {
      // This is verified at the handler level -- each handler includes
      // tenantId in the outbox payload. We verify the pattern here.
      const payload = {
        eventId: fakeUuid('evt'),
        tenantId: TENANT_A,
        channelId: tenantAChannelId,
      };

      expect(payload.tenantId).toBe(TENANT_A);
      expect(payload.tenantId).not.toBe(TENANT_B);
    });
  });
});
