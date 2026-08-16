import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { ChannelMember } from '../channel/entities/channel-member.entity';
import { AttachmentObjectPurgeService } from '../compliance/services/attachment-object-purge.service';
import {
  LegalHoldDestructiveMutationAuthority,
  LegalHoldDestructiveMutationBlocked,
} from '../compliance/services/legal-hold-destructive-mutation.authority';
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
 * erasure. A hold intersecting the user scope blocks the entire transaction.
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

  function buildQueryRunner(footprint: boolean, held: boolean): Record<string, unknown> {
    let isTransactionActive = false;
    const query = jest.fn((sql: string, params: unknown[] = []) => {
      queryCalls.push({ sql, params });
      if (sql.includes('has_messages')) {
        return Promise.resolve([{ has_messages: footprint }]);
      }
      if (sql.includes('has_memberships')) {
        return Promise.resolve([{ has_memberships: footprint }]);
      }
      if (sql.includes('FROM legal_holds')) {
        return Promise.resolve(held ? [{ id: 'hold-1', channelId: heldChannelId }] : []);
      }
      if (sql.includes('SELECT DISTINCT scope."channelId"')) {
        return Promise.resolve(
          footprint ? [{ channelId: heldChannelId }, { channelId: openChannelId }] : [],
        );
      }
      if (sql.includes('SELECT id, "channelId" FROM messages')) {
        return Promise.resolve([
          { id: heldMessageId, channelId: heldChannelId },
          { id: openMessageId, channelId: openChannelId },
        ]);
      }
      if (sql.includes('SELECT "storageKey", "thumbnailKey" FROM message_attachments')) {
        return Promise.resolve([
          {
            storageKey: `messaging/${tenantId}/ch/open.png`,
            thumbnailKey: `messaging/${tenantId}/ch/open-thumb.png`,
          },
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
      manager: { query },
      release: jest.fn().mockResolvedValue(undefined),
    };
  }

  async function build(footprint: boolean, held = false): Promise<void> {
    queryCalls = [];
    purgeAtCall = -1;
    commitTransaction = jest.fn();
    purgeObjects = jest.fn().mockImplementation(() => {
      purgeAtCall = commitTransaction.mock.calls.length;
      return Promise.resolve({ requested: 2, deleted: 2, failed: 0 });
    });

    const queryRunner = buildQueryRunner(footprint, held);
    const dataSource = { createQueryRunner: () => queryRunner };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagingNatsHandler,
        LegalHoldDestructiveMutationAuthority,
        { provide: getRepositoryToken(ChannelMember), useValue: {} },
        { provide: getRepositoryToken(Message), useValue: {} },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: PartitionManagerService, useValue: {} },
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

  it('scopes the attachment row delete to the authority-cleared message IDs', async () => {
    await build(true);

    await handler.handleUserDeleted({ tenantId, deletedUserId });

    const deleteCall = queryCalls.find((c) => c.sql.includes('DELETE FROM message_attachments'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.params[0]).toEqual([heldMessageId, openMessageId]);
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

  it('rolls back and preserves the complete user footprint when any scoped channel is held', async () => {
    await build(true, true);

    await expect(handler.handleUserDeleted({ tenantId, deletedUserId })).rejects.toBeInstanceOf(
      LegalHoldDestructiveMutationBlocked,
    );

    expect(purgeObjects).not.toHaveBeenCalled();
    expect(queryCalls.some((call) => call.sql.includes('DELETE FROM message_attachments'))).toBe(
      false,
    );
  });
});
