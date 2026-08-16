import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { ChannelMember } from '../channel/entities/channel-member.entity';
import { AttachmentObjectPurgeService } from '../compliance/services/attachment-object-purge.service';
import { LegalHoldDestructiveMutationAuthority } from '../compliance/services/legal-hold-destructive-mutation.authority';
import { Message } from '../message/entities/message.entity';
import { MediaService } from '../message/services/media.service';
import { PartitionManagerService } from '../partition/partition-manager.service';
import { REDIS_CLIENT } from '../shared/redis.provider';
import { MessagingNatsHandler } from './messaging-nats.handler';

/**
 * MSG-CRITICAL-050 / SECURITY: the WS-broadcast hydration responder must return
 * the full message body AND must NEVER leak sender PII over NATS (the
 * auth-user-queries profile-oracle constraint) — only `sender: { id }` crosses
 * the boundary; the client enriches the name from its channel-members cache.
 */
describe('MessagingNatsHandler.getMessageForBroadcast', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const channelId = '22222222-2222-2222-2222-222222222222';
  const messageId = '33333333-3333-3333-3333-333333333333';
  const senderId = '44444444-4444-4444-4444-444444444444';

  let handler: MessagingNatsHandler;
  let findOne: jest.Mock;
  let find: jest.Mock;
  let generateDownloadUrl: jest.Mock;

  beforeEach(async () => {
    findOne = jest.fn();
    find = jest.fn().mockResolvedValue([]);
    generateDownloadUrl = jest.fn();

    let isTransactionActive = false;
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockImplementation(() => {
        isTransactionActive = true;
        return Promise.resolve();
      }),
      commitTransaction: jest.fn().mockImplementation(() => {
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
      query: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: { findOne, find },
    };
    const dataSource = { createQueryRunner: () => queryRunner };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagingNatsHandler,
        { provide: getRepositoryToken(ChannelMember), useValue: {} },
        { provide: getRepositoryToken(Message), useValue: {} },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: PartitionManagerService, useValue: {} },
        { provide: LegalHoldDestructiveMutationAuthority, useValue: {} },
        { provide: MediaService, useValue: { generateDownloadUrl } },
        { provide: REDIS_CLIENT, useValue: {} },
        { provide: AttachmentObjectPurgeService, useValue: { purgeObjects: jest.fn() } },
      ],
    }).compile();

    handler = moduleRef.get(MessagingNatsHandler);
  });

  function message(): Partial<Message> {
    return {
      id: messageId,
      channelId,
      senderId,
      content: 'hello',
      contentType: 'text' as Message['contentType'],
      parentId: null,
      forwardedFrom: null,
      isDeleted: false,
      createdAt: new Date('2026-06-13T10:00:00.000Z'),
      editedAt: null,
      metadata: null,
      idempotencyKey: '55555555-5555-5555-5555-555555555555',
    };
  }

  it('hydrates the full message body but exposes ONLY sender.id (no PII over NATS)', async () => {
    findOne.mockResolvedValue(message());

    const result = await handler.getMessageForBroadcast({ tenantId, channelId, messageId });

    expect(result.message).not.toBeNull();
    expect(result.message?.content).toBe('hello');
    expect(result.message?.createdAt).toBe('2026-06-13T10:00:00.000Z');
    // SECURITY: sender must be exactly { id } — no firstName/lastName/email/avatar.
    expect(result.message?.sender).toEqual({ id: senderId });
    expect(Object.keys(result.message?.sender ?? {})).toEqual(['id']);
  });

  it('emits the UPPERCASE GraphQL enum NAME for contentType (S1-CODEGEN wire parity)', async () => {
    // The DB row stores the lowercase enum VALUE ('text'); the GraphQL query
    // path serializes the enum NAME ('TEXT'). The WS hydrator MUST project the
    // value → name so the live WS wire form is byte-identical to the GraphQL
    // wire form the codegen client consumes.
    findOne.mockResolvedValue({ ...message(), contentType: 'image' as Message['contentType'] });

    const result = await handler.getMessageForBroadcast({ tenantId, channelId, messageId });

    expect(result.message?.contentType).toBe('IMAGE');
  });

  it('emits the UPPERCASE GraphQL enum NAME for receipt status (S1-CODEGEN wire parity)', async () => {
    findOne.mockResolvedValue(message());
    find
      .mockResolvedValueOnce([]) // attachments
      .mockResolvedValueOnce([
        {
          userId: '66666666-6666-6666-6666-666666666666',
          status: 'read',
          deliveredAt: new Date('2026-06-13T10:00:01.000Z'),
          readAt: new Date('2026-06-13T10:00:02.000Z'),
        },
        {
          userId: '77777777-7777-7777-7777-777777777777',
          status: 'delivered',
          deliveredAt: new Date('2026-06-13T10:00:03.000Z'),
          readAt: null,
        },
      ]);

    const result = await handler.getMessageForBroadcast({ tenantId, channelId, messageId });

    expect(result.message?.receipts?.map((r) => r.status)).toEqual(['READ', 'DELIVERED']);
  });

  it('signs attachment download/thumbnail URLs via MediaService for the tenant', async () => {
    findOne.mockResolvedValue(message());
    find
      .mockResolvedValueOnce([
        {
          id: 'att-1',
          originalFilename: 'p.jpg',
          mimeType: 'image/jpeg',
          fileSize: 1024,
          width: 10,
          height: 10,
          durationSeconds: null,
          storageKey: `messaging/${tenantId}/c/2026/06/p.jpg`,
          thumbnailKey: null,
        },
      ])
      .mockResolvedValueOnce([]);
    generateDownloadUrl.mockResolvedValue('https://minio/signed');

    const result = await handler.getMessageForBroadcast({ tenantId, channelId, messageId });

    expect(generateDownloadUrl).toHaveBeenCalledWith(
      tenantId,
      `messaging/${tenantId}/c/2026/06/p.jpg`,
    );
    expect(result.message?.attachments?.[0]?.downloadUrl).toBe('https://minio/signed');
    expect(result.message?.attachments?.[0]?.thumbnailUrl).toBeNull();
  });

  it('returns { message: null } when the message is absent in the tenant', async () => {
    findOne.mockResolvedValue(null);
    const result = await handler.getMessageForBroadcast({ tenantId, channelId, messageId });
    expect(result.message).toBeNull();
  });

  it('rejects malformed ids without touching the database', async () => {
    const result = await handler.getMessageForBroadcast({
      tenantId: 'not-a-uuid',
      channelId,
      messageId,
    });
    expect(result.message).toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });
});
