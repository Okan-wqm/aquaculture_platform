/**
 * @module Channel Management E2E Tests
 * @description End-to-end tests for channel CRUD, membership, roles,
 * DM deduplication, AI channel creation, and notification preferences.
 *
 * Tests the full NestJS stack: middleware → guards → resolvers → CQRS → database.
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
  USER_A1,
  USER_A2,
  ADMIN_A,
  E2eTestContext,
} from './e2e-setup';

describe('Channel Management (E2E)', () => {
  let ctx: E2eTestContext;
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let dataSource: DataSource;
  let redis: Redis;

  // Tracked entity IDs for sequential test steps
  let groupChannelId: string;
  let dmChannelId: string;
  let aiChannelId: string;

  beforeAll(async () => {
    ctx = await createE2eTestApp();
    ({ app, httpServer, dataSource, redis } = ctx);
    await setupTenantSchemas(dataSource, [TENANT_A]);
  });

  afterAll(async () => {
    await cleanupTenantData(dataSource, TENANT_A);
    await flushAllTestRedisKeys(redis);
    await app.close();
  });

  // ── GROUP Channel CRUD ──────────────────────────────────────────────────

  describe('Group Channel Lifecycle', () => {
    it('should create a GROUP channel with members', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation CreateChannel($input: CreateChannelInput!) {
            createChannel(input: $input) {
              id type name description createdBy isArchived
              members { userId role }
            }
          }
        `, {
          input: {
            type: 'GROUP',
            name: 'Havuz Ekibi',
            description: 'Havuz bakım ekibi kanalı',
            memberIds: [USER_A1, USER_A2, ADMIN_A],
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const channel = res.body.data.createChannel;
      expect(channel.type).toBe('GROUP');
      expect(channel.name).toBe('Havuz Ekibi');
      expect(channel.createdBy).toBe(USER_A1);
      expect(channel.isArchived).toBe(false);

      // Creator should be OWNER, others MEMBER
      const members = channel.members;
      expect(members).toHaveLength(3);
      const creator = members.find((m: { userId: string }) => m.userId === USER_A1);
      expect(creator.role).toBe('OWNER');
      const member = members.find((m: { userId: string }) => m.userId === USER_A2);
      expect(member.role).toBe('MEMBER');

      groupChannelId = channel.id;
    });

    it('should get a single channel by ID', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          query GetChannel($id: ID!) {
            channel(id: $id) {
              id name type memberCount
            }
          }
        `, { id: groupChannelId })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.channel.id).toBe(groupChannelId);
      expect(res.body.data.channel.name).toBe('Havuz Ekibi');
      expect(res.body.data.channel.memberCount).toBe(3);
    });

    it('should list channels with pagination', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          query MyChannels($filter: ChannelFilterInput) {
            myChannels(filter: $filter) {
              items { id name }
              total
            }
          }
        `, { filter: { limit: 10, offset: 0 } })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const { items, total } = res.body.data.myChannels;
      expect(total).toBeGreaterThanOrEqual(1);
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items.some((ch: { id: string }) => ch.id === groupChannelId)).toBe(true);
    });

    it('should update channel name and description', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation UpdateChannel($id: ID!, $input: UpdateChannelInput!) {
            updateChannel(id: $id, input: $input) {
              id name description
            }
          }
        `, {
          id: groupChannelId,
          input: { name: 'Havuz Bakım', description: 'Güncellenmiş açıklama' },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateChannel.name).toBe('Havuz Bakım');
      expect(res.body.data.updateChannel.description).toBe('Güncellenmiş açıklama');
    });

    it('should archive a channel', async () => {
      // Create a channel to archive (don't archive the main test channel)
      const createRes = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation CreateChannel($input: CreateChannelInput!) {
            createChannel(input: $input) { id }
          }
        `, {
          input: { type: 'GROUP', name: 'Arşivlenecek', memberIds: [USER_A1] },
        })
        .expect(200);

      const archiveId = createRes.body.data.createChannel.id;

      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation ArchiveChannel($id: ID!) {
            archiveChannel(id: $id)
          }
        `, { id: archiveId })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.archiveChannel).toBe(true);
    });
  });

  // ── Membership Management ─────────────────────────────────────────────

  describe('Channel Membership', () => {
    let membershipChannelId: string;

    beforeAll(async () => {
      // Create a dedicated channel for membership tests
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation CreateChannel($input: CreateChannelInput!) {
            createChannel(input: $input) { id }
          }
        `, {
          input: { type: 'GROUP', name: 'Üyelik Testi', memberIds: [USER_A1] },
        })
        .expect(200);

      membershipChannelId = res.body.data.createChannel.id;
    });

    it('should add a member to the channel', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation AddMember($channelId: ID!, $userId: ID!, $role: ChannelMemberRole) {
            addChannelMember(channelId: $channelId, userId: $userId, role: $role) {
              userId role
            }
          }
        `, {
          channelId: membershipChannelId,
          userId: USER_A2,
          role: 'MEMBER',
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.addChannelMember.userId).toBe(USER_A2);
      expect(res.body.data.addChannelMember.role).toBe('MEMBER');
    });

    it('should remove a member from the channel', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation RemoveMember($channelId: ID!, $userId: ID!) {
            removeChannelMember(channelId: $channelId, userId: $userId)
          }
        `, { channelId: membershipChannelId, userId: USER_A2 })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.removeChannelMember).toBe(true);
    });

    it('should allow self-leave from a channel', async () => {
      // First re-add USER_A2
      await gqlRequest(httpServer, TENANT_A, USER_A1, ['TENANT_ADMIN'])
        .query(`
          mutation AddMember($channelId: ID!, $userId: ID!) {
            addChannelMember(channelId: $channelId, userId: $userId) { userId }
          }
        `, { channelId: membershipChannelId, userId: USER_A2 })
        .expect(200);

      // USER_A2 leaves on their own
      const res = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(`
          mutation RemoveMember($channelId: ID!, $userId: ID!) {
            removeChannelMember(channelId: $channelId, userId: $userId)
          }
        `, { channelId: membershipChannelId, userId: USER_A2 })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.removeChannelMember).toBe(true);
    });

    it('should update notification preference', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation UpdatePref($channelId: ID!, $preference: NotificationPreference!) {
            updateNotificationPreference(channelId: $channelId, preference: $preference) {
              id notificationPreference
            }
          }
        `, { channelId: membershipChannelId, preference: 'MENTIONS' })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateNotificationPreference.notificationPreference).toBe('MENTIONS');
    });

    it('should reject non-member access to a channel', async () => {
      // USER_A2 was removed — should not access
      const res = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(`
          query GetChannel($id: ID!) {
            channel(id: $id) { id name }
          }
        `, { id: membershipChannelId })
        .expect(200);

      // GraphQL returns errors array for ForbiddenException
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/forbidden|not a member/i);
    });
  });

  // ── Direct Messages (DM) ─────────────────────────────────────────────

  describe('Direct Messages', () => {
    it('should create a DIRECT channel between two users', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation CreateChannel($input: CreateChannelInput!) {
            createChannel(input: $input) {
              id type
              members { userId role }
            }
          }
        `, {
          input: {
            type: 'DIRECT',
            memberIds: [USER_A1, USER_A2],
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const channel = res.body.data.createChannel;
      expect(channel.type).toBe('DIRECT');
      expect(channel.members).toHaveLength(2);

      dmChannelId = channel.id;
    });

    it('should deduplicate DM — return same channel for same pair', async () => {
      // Create from the other user's perspective (reversed order)
      const res = await gqlRequest(httpServer, TENANT_A, USER_A2)
        .query(`
          mutation CreateChannel($input: CreateChannelInput!) {
            createChannel(input: $input) { id }
          }
        `, {
          input: {
            type: 'DIRECT',
            memberIds: [USER_A2, USER_A1],
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      // dmPairKey ensures same channel is returned regardless of member order
      expect(res.body.data.createChannel.id).toBe(dmChannelId);
    });

    it('should get-or-create DM via directChannel query', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          query DirectChannel($userId: ID!) {
            directChannel(userId: $userId) { id type }
          }
        `, { userId: USER_A2 })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.directChannel.id).toBe(dmChannelId);
      expect(res.body.data.directChannel.type).toBe('DIRECT');
    });
  });

  // ── AI Channel ────────────────────────────────────────────────────────

  describe('AI Channel', () => {
    it('should create an AI channel with a persona', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation CreateChannel($input: CreateChannelInput!) {
            createChannel(input: $input) {
              id type aiPersona
              members { userId }
            }
          }
        `, {
          input: {
            type: 'AI',
            memberIds: [USER_A1],
            aiPersona: 'expert-v1',
          },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const channel = res.body.data.createChannel;
      expect(channel.type).toBe('AI');
      expect(channel.aiPersona).toBe('expert-v1');

      aiChannelId = channel.id;
    });

    it('should create an AI channel without a persona', async () => {
      const res = await gqlRequest(httpServer, TENANT_A, USER_A1)
        .query(`
          mutation CreateChannel($input: CreateChannelInput!) {
            createChannel(input: $input) { id type aiPersona }
          }
        `, {
          input: { type: 'AI', memberIds: [USER_A1] },
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const channel = res.body.data.createChannel;
      expect(channel.type).toBe('AI');
      expect(channel.aiPersona).toBeNull();
    });
  });
});
