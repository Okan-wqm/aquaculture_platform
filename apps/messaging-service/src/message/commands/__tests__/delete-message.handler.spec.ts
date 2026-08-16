import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { Message } from '../../entities/message.entity';
import { ChannelMemberRole } from '../../../channel/entities/channel-member.entity';
import { LegalHoldDestructiveMutationAuthority } from '../../../compliance/services/legal-hold-destructive-mutation.authority';
import { DeleteMessageHandler } from '../delete-message.handler';
import { DeleteMessageCommand } from '../delete-message.command';
import {
  createMockMessage,
  createMockQueryRunner,
  createMockDataSource,
  fakeUuid,
  resetUuidCounter,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';

describe('DeleteMessageHandler', () => {
  let handler: DeleteMessageHandler;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let outboxPublisher: { enqueue: jest.Mock };

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const channelId = fakeUuid('ch');
  const messageId = fakeUuid('msg');
  const senderId = fakeUuid('usr');
  const actorId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeleteMessageHandler,
        LegalHoldDestructiveMutationAuthority,
        { provide: DataSource, useValue: mockDataSource },
        { provide: OutboxPublisher, useValue: outboxPublisher },
      ],
    }).compile();

    handler = module.get(DeleteMessageHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Owner deleting own message
  // -----------------------------------------------------------------------
  it('owner can delete own message (soft-delete)', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId: actorId });
    queryRunner.manager.findOne.mockResolvedValue(msg);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, null);

    const result = await handler.execute(cmd);

    expect(result).toBe(true);
    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.any(Array),
    );
    // Verify isDeleted set to true in the save call
    const saveCalls = queryRunner.manager.save.mock.calls.filter((c) => c[0] === Message);
    expect(saveCalls.length).toBeGreaterThan(0);
    const savedMsg = saveCalls[0][1] as Message;
    expect(savedMsg.isDeleted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Channel role-based deletion
  // -----------------------------------------------------------------------
  it('channel ADMIN can delete any message', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId }); // someone else's message
    queryRunner.manager.findOne.mockResolvedValue(msg);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, ChannelMemberRole.ADMIN);

    const result = await handler.execute(cmd);
    expect(result).toBe(true);
  });

  it('channel OWNER can delete any message', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId });
    queryRunner.manager.findOne.mockResolvedValue(msg);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, ChannelMemberRole.OWNER);

    const result = await handler.execute(cmd);
    expect(result).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Unauthorized
  // -----------------------------------------------------------------------
  it('regular MEMBER cannot delete others messages', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId }); // someone else
    queryRunner.manager.findOne.mockResolvedValue(msg);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, ChannelMemberRole.MEMBER);

    await expect(handler.execute(cmd)).rejects.toThrow(ForbiddenException);
  });

  // -----------------------------------------------------------------------
  // Compliance: content preserved
  // -----------------------------------------------------------------------
  it('sets isDeleted=true, preserves content for compliance', async () => {
    const originalContent = 'Sensitive data here';
    const msg = createMockMessage({
      id: messageId,
      channelId,
      senderId: actorId,
      content: originalContent,
    });
    queryRunner.manager.findOne.mockResolvedValue(msg);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, null);

    await handler.execute(cmd);

    const saveCalls = queryRunner.manager.save.mock.calls.filter((c) => c[0] === Message);
    const savedMsg = saveCalls[0][1] as Message;
    expect(savedMsg.isDeleted).toBe(true);
    // Content NOT wiped -- kept for compliance/audit
    expect(savedMsg.content).toBe(originalContent);
  });

  // -----------------------------------------------------------------------
  // Outbox
  // -----------------------------------------------------------------------
  it('writes MessageDeleted event to outbox', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId: actorId });
    queryRunner.manager.findOne.mockResolvedValue(msg);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, null);

    await handler.execute(cmd);

    expect(outboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'MessageDeleted',
        tenantId,
        channelId,
        messageId,
      }),
      queryRunner.manager,
    );
  });

  // -----------------------------------------------------------------------
  // Not found
  // -----------------------------------------------------------------------
  it('throws NotFoundException when message not found', async () => {
    queryRunner.manager.findOne.mockResolvedValue(null);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, null);

    await expect(handler.execute(cmd)).rejects.toThrow(NotFoundException);
  });
});
