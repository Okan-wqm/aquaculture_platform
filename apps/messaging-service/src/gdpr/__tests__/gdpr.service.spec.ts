import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Message, MessageContentType } from '../../message/entities/message.entity';
import { MessagingOutbox } from '../../outbox/messaging-outbox.entity';
import { REDIS_CLIENT } from '../../shared/redis.provider';
import { GdprService } from '../gdpr.service';
import { LegalHoldService } from '../../compliance/services/legal-hold.service';
import { ComplianceAuditService } from '../../compliance/services/compliance-audit.service';
import {
  createMockMessage,
  createMockAttachment,
  createMockRepository,
  createMockQueryRunner,
  createMockDataSource,
  createMockRedis,
  createMockNatsClient,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
  MockQueryRunner,
  MockRedis,
  MockNatsClient,
} from '../../__tests__/test-helpers';
import { of } from 'rxjs';

describe('GdprService', () => {
  let service: GdprService;
  let messageRepo: MockRepository<Message>;
  let outboxRepo: MockRepository<MessagingOutbox>;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let redisClient: MockRedis;
  let natsClient: MockNatsClient;

  const tenantId = 'tenant-0001-0001-0001-000000000001';
  const userId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    messageRepo = createMockRepository<Message>();
    outboxRepo = createMockRepository<MessagingOutbox>();
    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    redisClient = createMockRedis();
    natsClient = createMockNatsClient();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GdprService,
        { provide: getRepositoryToken(Message), useValue: messageRepo },
        { provide: getRepositoryToken(MessagingOutbox), useValue: outboxRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: REDIS_CLIENT, useValue: redisClient },
        { provide: 'NATS_SERVICE', useValue: natsClient },
        { provide: LegalHoldService, useValue: { isUnderLegalHold: jest.fn().mockResolvedValue(false) } },
        { provide: ComplianceAuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get(GdprService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Data export
  // -----------------------------------------------------------------------
  it('exports all user messages as JSON', async () => {
    const messages = [
      createMockMessage({ senderId: userId, content: 'Hello', attachments: [] }),
      createMockMessage({ senderId: userId, content: 'World', attachments: [] }),
    ];
    messageRepo.find.mockResolvedValue(messages);
    redisClient.get.mockResolvedValue(null); // no recent export

    const result = await service.exportMyMessages(userId, tenantId);

    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
    expect(typeof result[0].content).toBe('string');
  });

  // -----------------------------------------------------------------------
  // Export rate limit
  // -----------------------------------------------------------------------
  it('rate limits export to 1 per 24 hours', async () => {
    redisClient.get.mockResolvedValue('1'); // recent export exists

    await expect(
      service.exportMyMessages(userId, tenantId),
    ).rejects.toThrow(BadRequestException);
  });

  // -----------------------------------------------------------------------
  // Anonymize -- senderId replaced with tombstone UUID
  // -----------------------------------------------------------------------
  it('anonymizes user data: replaces senderId with tombstone UUID', async () => {
    // verifyPassword returns true
    natsClient.send.mockReturnValue(of(true));

    await service.anonymizeMyData(userId, tenantId, 'correct-password');

    // The first raw SQL query should be the UPDATE messages SET senderId = $1
    const queryCalls = queryRunner.query.mock.calls;
    const updateMsgCall = queryCalls.find((call) => {
      const sql = call[0] as string;
      return sql.includes('UPDATE messages') && sql.includes('senderId');
    });
    expect(updateMsgCall).toBeDefined();
    // First param should be the tombstone UUID
    const params = updateMsgCall![1] as string[];
    expect(params[0]).toBe('00000000-0000-0000-0000-000000000000');
  });

  // -----------------------------------------------------------------------
  // Anonymize -- content replaced
  // -----------------------------------------------------------------------
  it('sets content to [message deleted by user]', async () => {
    natsClient.send.mockReturnValue(of(true));

    await service.anonymizeMyData(userId, tenantId, 'correct-password');

    const queryCalls = queryRunner.query.mock.calls;
    const updateMsgCall = queryCalls.find((call) => {
      const sql = call[0] as string;
      return sql.includes('[message deleted by user]');
    });
    expect(updateMsgCall).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Removes user from all channels
  // -----------------------------------------------------------------------
  it('removes user from all channels (sets leftAt)', async () => {
    natsClient.send.mockReturnValue(of(true));

    await service.anonymizeMyData(userId, tenantId, 'correct-password');

    const queryCalls = queryRunner.query.mock.calls;
    const channelUpdateCall = queryCalls.find((call) => {
      const sql = call[0] as string;
      return sql.includes('channel_members') && sql.includes('leftAt');
    });
    expect(channelUpdateCall).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Deletes all message attachments
  // -----------------------------------------------------------------------
  it('deletes all message attachments', async () => {
    natsClient.send.mockReturnValue(of(true));

    await service.anonymizeMyData(userId, tenantId, 'correct-password');

    const queryCalls = queryRunner.query.mock.calls;
    const deleteAttCall = queryCalls.find((call) => {
      const sql = call[0] as string;
      return sql.includes('DELETE FROM message_attachments');
    });
    expect(deleteAttCall).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Publishes UserDataAnonymized event
  // -----------------------------------------------------------------------
  it('publishes UserDataAnonymized event via outbox', async () => {
    natsClient.send.mockReturnValue(of(true));

    await service.anonymizeMyData(userId, tenantId, 'correct-password');

    const queryCalls = queryRunner.query.mock.calls;
    // The INSERT uses $1 for eventType and $2 for JSON payload
    const outboxInsert = queryCalls.find((call) => {
      const sql = call[0] as string;
      const params = call[1] as string[] | undefined;
      // Check if this is the outbox INSERT (event type is in params, not SQL)
      if (sql.includes('messaging_outbox')) {
        // params[0] should be 'UserDataAnonymized'
        return params && params[0] === 'UserDataAnonymized';
      }
      return false;
    });
    expect(outboxInsert).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Password confirmation required
  // -----------------------------------------------------------------------
  it('rejects anonymization with invalid password', async () => {
    natsClient.send.mockReturnValue(of(false)); // password invalid

    await expect(
      service.anonymizeMyData(userId, tenantId, 'wrong-password'),
    ).rejects.toThrow(BadRequestException);
  });

  // -----------------------------------------------------------------------
  // Transaction rollback
  // -----------------------------------------------------------------------
  it('rolls back transaction on error during anonymization', async () => {
    natsClient.send.mockReturnValue(of(true));
    queryRunner.query.mockRejectedValueOnce(new Error('DB error'));

    await expect(
      service.anonymizeMyData(userId, tenantId, 'correct-password'),
    ).rejects.toThrow();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
  });
});
