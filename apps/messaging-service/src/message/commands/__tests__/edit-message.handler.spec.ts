import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { Message } from '../../entities/message.entity';
import { LegalHoldService } from '../../../compliance/services/legal-hold.service';
import { EditMessageHandler } from '../edit-message.handler';
import { EditMessageCommand } from '../edit-message.command';
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

describe('EditMessageHandler', () => {
  let handler: EditMessageHandler;
  let messageRepo: MockRepository<Message>;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let legalHoldService: { isUnderLegalHold: jest.Mock };
  let outboxPublisher: { enqueue: jest.Mock };

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const channelId = fakeUuid('ch');
  const messageId = fakeUuid('msg');
  const senderId = fakeUuid('usr');
  const actorId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    messageRepo = createMockRepository<Message>();
    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    legalHoldService = { isUnderLegalHold: jest.fn().mockResolvedValue(false) };
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EditMessageHandler,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(Message), useValue: messageRepo },
        { provide: LegalHoldService, useValue: legalHoldService },
        { provide: OutboxPublisher, useValue: outboxPublisher },
      ],
    }).compile();

    handler = module.get(EditMessageHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------
  it('owner can edit own message (content + editedAt updated, legal-hold checked first)', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId: actorId, content: 'original' });
    queryRunner.manager.findOne.mockResolvedValue(msg);

    const cmd = new EditMessageCommand(tenantId, actorId, messageId, 'edited text');

    await handler.execute(cmd);

    expect(legalHoldService.isUnderLegalHold).toHaveBeenCalledWith(
      tenantId,
      channelId,
      queryRunner.manager,
    );
    const saveCalls = queryRunner.manager.save.mock.calls.filter((c) => c[0] === Message);
    expect(saveCalls.length).toBeGreaterThan(0);
    const savedMsg = saveCalls[0][1] as Message;
    expect(savedMsg.content).toBe('edited text');
    expect(savedMsg.editedAt).toBeInstanceOf(Date);
  });

  it('writes a MessageUpdated event to the outbox on success', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId: actorId, content: 'original' });
    queryRunner.manager.findOne.mockResolvedValue(msg);

    await handler.execute(new EditMessageCommand(tenantId, actorId, messageId, 'edited'));

    expect(outboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'MessageUpdated', tenantId, channelId, messageId }),
      queryRunner.manager,
    );
  });

  // -----------------------------------------------------------------------
  // MSG-HIGH-062: legal hold blocks the edit (spoliation guard, parity w/ delete)
  // -----------------------------------------------------------------------
  it('rejects the edit when the channel is under an active legal hold', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId: actorId, content: 'original' });
    queryRunner.manager.findOne.mockResolvedValue(msg);
    legalHoldService.isUnderLegalHold.mockResolvedValue(true);

    await expect(
      handler.execute(new EditMessageCommand(tenantId, actorId, messageId, 'tampered')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('does NOT mutate content or emit an outbox event when a hold blocks the edit', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId: actorId, content: 'original' });
    queryRunner.manager.findOne.mockResolvedValue(msg);
    legalHoldService.isUnderLegalHold.mockResolvedValue(true);

    await expect(
      handler.execute(new EditMessageCommand(tenantId, actorId, messageId, 'tampered')),
    ).rejects.toThrow(ForbiddenException);

    // Held content is preserved: no save of the Message entity, no outbox event.
    const saveCalls = queryRunner.manager.save.mock.calls.filter((c) => c[0] === Message);
    expect(saveCalls).toHaveLength(0);
    expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
    expect(msg.content).toBe('original');
  });

  it('propagates a fail-closed hold-registry error instead of editing (LegalHoldCheckUnavailable)', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId: actorId, content: 'original' });
    queryRunner.manager.findOne.mockResolvedValue(msg);
    legalHoldService.isUnderLegalHold.mockRejectedValue(new Error('hold registry timeout'));

    await expect(
      handler.execute(new EditMessageCommand(tenantId, actorId, messageId, 'edited')),
    ).rejects.toThrow('hold registry timeout');

    const saveCalls = queryRunner.manager.save.mock.calls.filter((c) => c[0] === Message);
    expect(saveCalls).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Authorization / not-found
  // -----------------------------------------------------------------------
  it('rejects an edit of someone else\'s message (ForbiddenException), never reaching the hold check', async () => {
    const msg = createMockMessage({ id: messageId, channelId, senderId }); // different author
    queryRunner.manager.findOne.mockResolvedValue(msg);

    await expect(
      handler.execute(new EditMessageCommand(tenantId, actorId, messageId, 'edited')),
    ).rejects.toThrow(ForbiddenException);
    expect(legalHoldService.isUnderLegalHold).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the message does not exist', async () => {
    queryRunner.manager.findOne.mockResolvedValue(null);

    await expect(
      handler.execute(new EditMessageCommand(tenantId, actorId, messageId, 'edited')),
    ).rejects.toThrow(NotFoundException);
  });
});
