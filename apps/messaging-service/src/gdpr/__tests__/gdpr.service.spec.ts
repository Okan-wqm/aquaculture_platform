import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { Message } from '../../message/entities/message.entity';
import { REDIS_CLIENT } from '../../shared/redis.provider';
import { GdprService } from '../gdpr.service';
import { LegalHoldService } from '../../compliance/services/legal-hold.service';
import { ComplianceAuditService } from '../../compliance/services/compliance-audit.service';
import { AttachmentObjectPurgeService } from '../../compliance/services/attachment-object-purge.service';
import { MessagingMetricsService } from '../../metrics/messaging-metrics.service';
import {
  createMockMessage,
  createMockQueryBuilder,
  createMockQueryRunner,
  createMockDataSource,
  createMockRedis,
  createMockNatsClient,
  fakeUuid,
  resetUuidCounter,
  MockQueryRunner,
  MockRedis,
  MockNatsClient,
} from '../../__tests__/test-helpers';
import { of } from 'rxjs';

describe('GdprService', () => {
  let service: GdprService;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let redisClient: MockRedis;
  let natsClient: MockNatsClient;
  let outboxPublisher: { enqueue: jest.Mock };
  let attachmentPurge: { purgeObjects: jest.Mock };
  let messageQb: jest.Mocked<SelectQueryBuilder<Message>>;

  const tenantId = '00000000-0000-4000-8000-000000000001';
  const userId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    redisClient = createMockRedis();
    natsClient = createMockNatsClient();
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
    attachmentPurge = {
      purgeObjects: jest.fn().mockResolvedValue({ requested: 0, deleted: 0, skipped: 0, failed: 0 }),
    };
    messageQb = createMockQueryBuilder<Message>();
    queryRunner.manager.createQueryBuilder.mockReturnValue(messageQb as unknown as SelectQueryBuilder<Message>);
    queryRunner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, "createdAt" FROM messages')) {
        return [{ id: fakeUuid('msg'), createdAt: new Date('2026-03-10T12:00:00Z') }];
      }
      return [];
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GdprService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: REDIS_CLIENT, useValue: redisClient },
        { provide: 'NATS_SERVICE', useValue: natsClient },
        { provide: LegalHoldService, useValue: { isUnderLegalHold: jest.fn().mockResolvedValue(false) } },
        { provide: ComplianceAuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: MessagingMetricsService, useValue: { incrementGdprErasure: jest.fn() } },
        { provide: OutboxPublisher, useValue: outboxPublisher },
        { provide: AttachmentObjectPurgeService, useValue: attachmentPurge },
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
    messageQb.getMany.mockResolvedValue(messages);
    redisClient.get.mockResolvedValue(null); // no recent export

    const result = await service.exportMyMessages(userId, tenantId);

    expect(result).toBeDefined();
    expect(result.messages).toHaveLength(2);
    expect(typeof result.messages[0]?.content).toBe('string');
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
  // MSG-CRITICAL-058: attachment MinIO objects are purged after the erasure commits
  // -----------------------------------------------------------------------
  it('purges the attachment object + thumbnail keys after erasure commits', async () => {
    natsClient.send.mockReturnValue(of(true));
    queryRunner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, "createdAt" FROM messages')) {
        return [{ id: fakeUuid('msg'), createdAt: new Date('2026-03-10T12:00:00Z') }];
      }
      if (sql.includes('FROM message_attachments') && sql.includes('storageKey')) {
        return [
          {
            storageKey: `messaging/${tenantId}/ch/img.png`,
            thumbnailKey: `messaging/${tenantId}/ch/img_thumb.png`,
          },
          { storageKey: `messaging/${tenantId}/ch/doc.pdf`, thumbnailKey: null },
        ];
      }
      return [];
    });

    await service.anonymizeMyData(userId, tenantId, 'correct-password');

    expect(attachmentPurge.purgeObjects).toHaveBeenCalledTimes(1);
    const [purgeTenant, keys] = attachmentPurge.purgeObjects.mock.calls[0] as [string, string[]];
    expect(purgeTenant).toBe(tenantId);
    // storageKey then thumbnailKey per row, in row order; null thumbnails omitted.
    expect(keys).toEqual([
      `messaging/${tenantId}/ch/img.png`,
      `messaging/${tenantId}/ch/img_thumb.png`,
      `messaging/${tenantId}/ch/doc.pdf`,
    ]);
  });

  it('does not call the object purge when the user has no attachments', async () => {
    natsClient.send.mockReturnValue(of(true));
    // Default query mock returns a message id but no attachment rows.
    await service.anonymizeMyData(userId, tenantId, 'correct-password');
    expect(attachmentPurge.purgeObjects).not.toHaveBeenCalled();
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

    expect(outboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'UserDataAnonymized', tenantId, userId }),
      queryRunner.manager,
    );
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
