import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Message } from '../../entities/message.entity';
import { ChannelMemberRole } from '../../../channel/entities/channel-member.entity';
import { MessagingOutbox } from '../../../outbox/messaging-outbox.entity';
import { DeleteMessageHandler } from '../delete-message.handler';
import { DeleteMessageCommand } from '../delete-message.command';
import {
  createMockMessage,
  createMockRepository,
  createMockQueryRunner,
  createMockDataSource,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';

describe('DeleteMessageHandler', () => {
  let handler: DeleteMessageHandler;
  let messageRepo: MockRepository<Message>;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;

  const tenantId = 'tenant-0001-0001-0001-000000000001';
  const channelId = fakeUuid('ch');
  const messageId = fakeUuid('msg');
  const senderId = fakeUuid('usr');
  const actorId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    messageRepo = createMockRepository<Message>();
    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeleteMessageHandler,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(Message), useValue: messageRepo },
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
    messageRepo.findOne.mockResolvedValue(msg);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, null);

    const result = await handler.execute(cmd);

    expect(result).toBe(true);
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
    messageRepo.findOne.mockResolvedValue(msg);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, ChannelMemberRole.ADMIN);

    const result = await handler.execute(cmd);
    expect(result).toBe(true);
  });

  it('channel OWNER can delete any message', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId });
    messageRepo.findOne.mockResolvedValue(msg);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, ChannelMemberRole.OWNER);

    const result = await handler.execute(cmd);
    expect(result).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Unauthorized
  // -----------------------------------------------------------------------
  it('regular MEMBER cannot delete others messages', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId }); // someone else
    messageRepo.findOne.mockResolvedValue(msg);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, ChannelMemberRole.MEMBER);

    await expect(handler.execute(cmd)).rejects.toThrow(ForbiddenException);
  });

  // -----------------------------------------------------------------------
  // Compliance: content preserved
  // -----------------------------------------------------------------------
  it('sets isDeleted=true, preserves content for compliance', async () => {
    const originalContent = 'Sensitive data here';
    const msg = createMockMessage({
      id: messageId, channelId, senderId: actorId, content: originalContent,
    });
    messageRepo.findOne.mockResolvedValue(msg);

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
    messageRepo.findOne.mockResolvedValue(msg);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, null);

    await handler.execute(cmd);

    const outboxSave = queryRunner.manager.save.mock.calls.find(
      (c) => c[0] === MessagingOutbox,
    );
    expect(outboxSave).toBeDefined();
    const outboxData = outboxSave![1] as Partial<MessagingOutbox>;
    expect(outboxData.eventType).toBe('MessageDeleted');
  });

  // -----------------------------------------------------------------------
  // Not found
  // -----------------------------------------------------------------------
  it('throws NotFoundException when message not found', async () => {
    messageRepo.findOne.mockResolvedValue(null);

    const cmd = new DeleteMessageCommand(tenantId, actorId, messageId, null);

    await expect(handler.execute(cmd)).rejects.toThrow(NotFoundException);
  });
});
