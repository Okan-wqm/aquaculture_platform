import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { OutboxPublisher } from '@platform/outbox';

import { ChannelMember } from '../../../channel/entities/channel-member.entity';
import {
  createMockDataSource,
  createMockOutboxPublisher,
  createMockQueryBuilder,
  createMockQueryRunner,
  createMockRedis,
} from '../../../__tests__/test-helpers';
import { Message } from '../../entities/message.entity';
import { MessageReceipt, ReceiptStatus } from '../../entities/message-receipt.entity';
import { MarkReadCommand } from '../mark-read.command';
import { MarkReadHandler } from '../mark-read.handler';
import { TenantPrincipalService } from '../../../principal/tenant-principal.service';

describe('MarkReadHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const channelId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const messageId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const messageCreatedAt = new Date('2026-05-01T12:00:00.000Z');

  it('records read-receipt idempotency key inside the tenant transaction', async () => {
    const queryRunner = createMockQueryRunner();
    const dataSource = createMockDataSource(queryRunner);
    const redis = createMockRedis();
    const outboxPublisher = createMockOutboxPublisher();
    const tenantPrincipalService = {
      upsertActiveUsers: jest.fn().mockResolvedValue(undefined),
    };
    const unreadCountBuilder = createMockQueryBuilder<Message>();
    unreadCountBuilder.getCount.mockResolvedValue(0);

    queryRunner.manager.createQueryBuilder.mockReturnValue(unreadCountBuilder);
    queryRunner.manager.findOne.mockImplementation((entity: unknown) => {
      if (entity === Message) {
        return Promise.resolve({
          id: messageId,
          tenantId,
          channelId,
          senderId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          createdAt: messageCreatedAt,
          isDeleted: false,
        } as Message);
      }
      if (entity === ChannelMember) {
        return Promise.resolve({
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          tenantId,
          channelId,
          userId,
          lastReadAt: null,
        } as ChannelMember);
      }
      if (entity === MessageReceipt) {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    const handler = new MarkReadHandler(
      dataSource as unknown as DataSource,
      redis as unknown as Redis,
      outboxPublisher as unknown as OutboxPublisher,
      tenantPrincipalService as unknown as TenantPrincipalService,
    );

    await expect(
      handler.execute(new MarkReadCommand(tenantId, userId, channelId, messageId)),
    ).resolves.toBe(true);

    expect(queryRunner.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "message_read_receipt_keys"'),
      [tenantId, messageId, messageCreatedAt, userId],
    );
    expect(tenantPrincipalService.upsertActiveUsers).toHaveBeenCalledWith(
      queryRunner.manager,
      tenantId,
      [userId],
    );
    expect(queryRunner.manager.save).toHaveBeenCalledWith(
      MessageReceipt,
      expect.objectContaining({
        tenantId,
        messageId,
        messageCreatedAt,
        userId,
        status: ReceiptStatus.READ,
      }),
    );
    expect(outboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        channelId,
        messageId,
        userId,
      }),
      queryRunner.manager,
    );
  });
});
