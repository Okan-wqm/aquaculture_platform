import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
import { Message } from '../../entities/message.entity';
import { ChannelMember } from '../../../channel/entities/channel-member.entity';
import { GetMessagesHandler, MessagePage } from '../get-messages.handler';
import { GetMessagesQuery } from '../get-messages.query';
import {
  createMockMessage,
  createMockChannelMember,
  createMockRepository,
  createMockQueryBuilder,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
} from '../../../__tests__/test-helpers';
import { SelectQueryBuilder } from 'typeorm';

describe('GetMessagesHandler', () => {
  let handler: GetMessagesHandler;
  let messageRepo: MockRepository<Message>;
  let memberRepo: MockRepository<ChannelMember>;
  let qb: jest.Mocked<SelectQueryBuilder<Message>>;

  const tenantId = 'tenant-0001-0001-0001-000000000001';
  const channelId = fakeUuid('ch');
  const userId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    messageRepo = createMockRepository<Message>();
    memberRepo = createMockRepository<ChannelMember>();
    qb = createMockQueryBuilder<Message>();

    messageRepo.createQueryBuilder.mockReturnValue(qb as unknown as SelectQueryBuilder<Message>);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetMessagesHandler,
        { provide: getRepositoryToken(Message), useValue: messageRepo },
        { provide: getRepositoryToken(ChannelMember), useValue: memberRepo },
      ],
    }).compile();

    handler = module.get(GetMessagesHandler);

    // Default: user is a channel member (leftAt: undefined means active in IsNull() check)
    memberRepo.findOne.mockResolvedValue(
      createMockChannelMember({ channelId, userId, leftAt: null }),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Pagination
  // -----------------------------------------------------------------------
  it('returns paginated messages (cursor-based)', async () => {
    const messages = [
      createMockMessage({ channelId, createdAt: new Date('2026-03-10T12:05:00Z') }),
      createMockMessage({ channelId, createdAt: new Date('2026-03-10T12:00:00Z') }),
    ];
    qb.getMany.mockResolvedValue(messages);

    const query = new GetMessagesQuery(tenantId, userId, channelId, 20, null, null, null);

    const result = await handler.execute(query);

    expect(result.items).toHaveLength(2);
    expect(qb.where).toHaveBeenCalled();
    expect(qb.orderBy).toHaveBeenCalled();
    expect(qb.take).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Deleted filter
  // -----------------------------------------------------------------------
  it('filters deleted messages (isDeleted=false)', async () => {
    qb.getMany.mockResolvedValue([]);

    const query = new GetMessagesQuery(tenantId, userId, channelId, 20, null, null, null);

    await handler.execute(query);

    const whereCallArgs = qb.andWhere.mock.calls.map((call) => call[0] as string);
    const hasDeletedFilter = whereCallArgs.some((arg) => arg.includes('isDeleted'));
    expect(hasDeletedFilter).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Membership check
  // -----------------------------------------------------------------------
  it('validates user is channel member', async () => {
    memberRepo.findOne.mockReset();
    memberRepo.findOne.mockResolvedValue(null);

    const query = new GetMessagesQuery(tenantId, userId, channelId, 20, null, null, null);

    await expect(handler.execute(query)).rejects.toThrow(ForbiddenException);
  });

  // -----------------------------------------------------------------------
  // hasMore flag
  // -----------------------------------------------------------------------
  it('returns hasMore=true when more messages exist', async () => {
    const limit = 2;
    // Return limit+1 to signal more exist
    const messages = [
      createMockMessage({ channelId }),
      createMockMessage({ channelId }),
      createMockMessage({ channelId }),
    ];
    qb.getMany.mockResolvedValue(messages);

    const query = new GetMessagesQuery(tenantId, userId, channelId, limit, null, null, null);

    const result = await handler.execute(query);

    expect(result.hasMore).toBe(true);
    expect(result.items).toHaveLength(limit);
  });

  // -----------------------------------------------------------------------
  // Cursor
  // -----------------------------------------------------------------------
  it('returns correct cursor for next page', async () => {
    const oldestMessage = createMockMessage({
      channelId,
      createdAt: new Date('2026-03-10T12:00:00Z'),
    });
    qb.getMany.mockResolvedValue([
      createMockMessage({ channelId, createdAt: new Date('2026-03-10T12:05:00Z') }),
      oldestMessage,
    ]);

    const query = new GetMessagesQuery(tenantId, userId, channelId, 20, null, null, null);

    const result = await handler.execute(query);

    expect(result.cursor).toBeDefined();
    expect(result.cursor).not.toBeNull();
    // Cursor is base64url encoded, decode it to verify
    const decoded = JSON.parse(
      Buffer.from(result.cursor as string, 'base64url').toString('utf-8'),
    );
    expect(decoded.createdAt).toBe(oldestMessage.createdAt.toISOString());
  });

  // -----------------------------------------------------------------------
  // Eager load attachments
  // -----------------------------------------------------------------------
  it('eagerly loads attachments via left join', async () => {
    qb.getMany.mockResolvedValue([]);

    const query = new GetMessagesQuery(tenantId, userId, channelId, 20, null, null, null);

    await handler.execute(query);

    const joinCalls = qb.leftJoinAndSelect.mock.calls.map((call) => call[0] as string);
    const hasAttachmentJoin = joinCalls.some((arg) => arg.includes('attachments'));
    expect(hasAttachmentJoin).toBe(true);
  });

  // -----------------------------------------------------------------------
  // take argument is limit + 1
  // -----------------------------------------------------------------------
  it('requests limit+1 rows to check hasMore', async () => {
    qb.getMany.mockResolvedValue([]);

    const query = new GetMessagesQuery(tenantId, userId, channelId, 50, null, null, null);

    await handler.execute(query);

    const takeArg = (qb.take as jest.Mock).mock.calls[0][0] as number;
    expect(takeArg).toBe(51); // 50 + 1
  });
});
