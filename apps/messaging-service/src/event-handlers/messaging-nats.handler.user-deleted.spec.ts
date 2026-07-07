import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { ChannelMember } from '../channel/entities/channel-member.entity';
import { AttachmentObjectPurgeService } from '../compliance/services/attachment-object-purge.service';
import { LegalHoldService } from '../compliance/services/legal-hold.service';
import { Message } from '../message/entities/message.entity';
import { MediaService } from '../message/services/media.service';
import { PartitionManagerService } from '../partition/partition-manager.service';
import { REDIS_CLIENT } from '../shared/redis.provider';
import { MessagingNatsHandler } from './messaging-nats.handler';

/**
 * UserDeleted cascade attachment-object erasure (MSG-CRITICAL-058).
 *
 * When a user is deleted, the cascade wipes their message content in NON-HELD
 * channels. It must also delete the attachment rows for those messages AND purge
 * the backing MinIO binaries — otherwise the user's PII media survives GDPR
 * erasure. Held-channel attachments are preserved (legal hold outranks erasure).
 * These tests pin: keys captured before the row delete, purge scoped to non-held
 * message IDs, purge runs after commit, and a no-footprint user purges nothing.
 */
describe('MessagingNatsHandler.handleUserDeleted — attachment erasure (MSG-CRITICAL-058)', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const deletedUserId = '44444444-4444-4444-4444-444444444444';
  const heldChannelId = '22222222-2222-2222-2222-222222222222';
  const openChannelId = '33333333-3333-3333-3333-333333333333';
  const heldMessageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const openMessageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  let handler: MessagingNatsHandler;
  let purgeObjects: jest.Mock;
  let queryCalls: Array<{ sql: string; params: unknown[] }>;
  let commitTransaction: jest.Mock;
  let purgeAtCall: number;

  function buildQueryRunner(footprint: boolean): Record<string, unknown> {
    let isTransactionActive = false;
    const query = jest.fn((sql: string, params: unknown[] = []) => {
      queryCalls.push({ sql, params });
      if (sql.includes('has_messages')) {
        return Promise.resolve([{ has_messages: footprint }]);
      }
      if (sql.includes('has_memberships')) {
        return Promise.resolve([{ has_memberships: footprint }]);
      }
      if (sql.includes('SELECT id, "channelId" FROM messages')) {
        return Promise.resolve([
          { id: heldMessageId, channelId: heldChannelId },
          { id: openMessageId, channelId: openChannelId },
        ]);
      }
      if (sql.includes('SELECT "storageKey", "thumbnailKey" FROM message_attachments')) {
        return Promise.resolve([
          { storageKey: `messaging/${tenantId}/ch/open.png`, thumbnailKey: `messaging/${tenantId}/ch/open-thumb.png` },
        ]);
      }
      return Promise.resolve(undefined);
    });
    return {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockImplementation(() => {
        isTransactionActive = true;
        return Promise.resolve();
      }),
      commitTransaction: commitTransaction.mockImplementation(() => {
        isTransactionActive = false;
        return Promise.resolve();
      }),
      rollbackTransaction: jest.fn().mockImplementation(() => {
        isTransactionActive = false;
        return Promise.resolve();
      }),
      get isTransactionActive(): boolean {
        return isTransactionActive;
      },
      query,
      release: jest.fn().mockResolvedValue(undefined),
    };
  }

  async function build(footprint: boolean): Promise<void> {
    queryCalls = [];
    purgeAtCall = -1;
    commitTransaction = jest.fn();
    purgeObjects = jest.fn().mockImplementation(() => {
      purgeAtCall = commitTransaction.mock.calls.length;
      return Promise.resolve({ requested: 2, deleted: 2, failed: 0 });
    });

    const queryRunner = buildQueryRunner(footprint);
    const dataSource = { createQueryRunner: () => queryRunner };
    const legalHoldService = {
      isUnderLegalHold: jest.fn((_t: string, channelId: string | null) =>
        Promise.resolve(channelId === heldChannelId),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagingNatsHandler,
        { provide: getRepositoryToken(ChannelMember), useValue: {} },
        { provide: getRepositoryToken(Message), useValue: {} },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: PartitionManagerService, useValue: {} },
        { provide: LegalHoldService, useValue: legalHoldService },
        { provide: MediaService, useValue: {} },
        { provide: REDIS_CLIENT, useValue: {} },
        { provide: AttachmentObjectPurgeService, useValue: { purgeObjects } },
      ],
    }).compile();

    handler = moduleRef.get(MessagingNatsHandler);
  }

  it('purges the attachment objects of the erased (non-held) messages after commit', async () => {
    await build(true);

    await handler.handleUserDeleted({ tenantId, deletedUserId });

    expect(purgeObjects).toHaveBeenCalledTimes(1);
    expect(purgeObjects).toHaveBeenCalledWith(tenantId, [
      `messaging/${tenantId}/ch/open.png`,
      `messaging/${tenantId}/ch/open-thumb.png`,
    ]);
    // Purge runs AFTER the transaction commits (row gone before binary dropped).
    expect(purgeAtCall).toBe(1);
  });

  it('scopes the attachment row delete to non-held message IDs only', async () => {
    await build(true);

    await handler.handleUserDeleted({ tenantId, deletedUserId });

    const deleteCall = queryCalls.find((c) =>
      c.sql.includes('DELETE FROM message_attachments'),
    );
    expect(deleteCall).toBeDefined();
    // Only the open-channel message is erasable; the held message is excluded.
    expect(deleteCall?.params[0]).toEqual([openMessageId]);
  });

  it('captures the object keys BEFORE deleting the attachment rows', async () => {
    await build(true);

    await handler.handleUserDeleted({ tenantId, deletedUserId });

    const selectIdx = queryCalls.findIndex((c) =>
      c.sql.includes('SELECT "storageKey", "thumbnailKey" FROM message_attachments'),
    );
    const deleteIdx = queryCalls.findIndex((c) =>
      c.sql.includes('DELETE FROM message_attachments'),
    );
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(selectIdx);
  });

  it('purges nothing when the user has no messaging footprint', async () => {
    await build(false);

    await handler.handleUserDeleted({ tenantId, deletedUserId });

    expect(purgeObjects).not.toHaveBeenCalled();
  });
});
