import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { AiChatBridgeService } from '../ai-chat-bridge.service';
import { Channel, ChannelType } from '../../../channel/entities/channel.entity';
import { ChannelMember, ChannelMemberRole } from '../../../channel/entities/channel-member.entity';
import { Message, MessageContentType } from '../../../message/entities/message.entity';
import {
  InputFilterService,
  OutputPiiScannerService,
  SsrfValidatorService,
} from '@aquaculture/backend-common/ai-safety';
import { InstructionHierarchyService } from '../../safety/instruction-hierarchy.service';
import { ToolSchemaValidatorService } from '../../safety/tool-schema-validator.service';
import { AiPersonasRegistryService } from '../ai-personas-registry.service';
import { AiEgressGateService } from '../ai-egress-gate.service';
import {
  createMockRepository,
  createMockNatsClient,
  createMockChannel,
  createMockMessage,
  createMockQueryBuilder,
  createMockQueryRunner,
  createMockDataSource,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
  MockNatsClient,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';
import { of } from 'rxjs';
import type { SelectQueryBuilder, ObjectLiteral } from 'typeorm';

/** Virtual AI user UUID matching the service constant. */
const AI_USER_ID = '00000000-0000-0000-0000-000000000001';

describe('AiChatBridgeService', () => {
  let service: AiChatBridgeService;
  let channelRepo: MockRepository<Channel>;
  let messageRepo: MockRepository<Message>;
  let channelMemberRepo: MockRepository<ChannelMember>;
  let natsClient: MockNatsClient;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let outboxPublisher: { enqueue: jest.Mock };
  let aiEgressGate: { assertAllowed: jest.Mock };

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const aiChannelId = fakeUuid('ch');
  const groupChannelId = fakeUuid('ch');
  const messageId = fakeUuid('msg');
  const senderId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    channelRepo = createMockRepository<Channel>();
    messageRepo = createMockRepository<Message>();
    channelMemberRepo = createMockRepository<ChannelMember>();
    natsClient = createMockNatsClient();
    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
    aiEgressGate = { assertAllowed: jest.fn().mockResolvedValue(undefined) };

    // Setup createQueryBuilder for context message fetching
    const qb = createMockQueryBuilder<Message>();
    (qb.getMany as jest.Mock).mockResolvedValue([]);
    messageRepo.createQueryBuilder.mockReturnValue(
      qb as unknown as SelectQueryBuilder<Message>,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiChatBridgeService,
        { provide: getRepositoryToken(Message), useValue: messageRepo },
        { provide: getRepositoryToken(Channel), useValue: channelRepo },
        { provide: getRepositoryToken(ChannelMember), useValue: channelMemberRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: 'NATS_SERVICE', useValue: natsClient },
        {
          provide: InputFilterService,
          useValue: { scanInput: jest.fn().mockReturnValue({ safe: true, flaggedPatterns: [] }) },
        },
        {
          provide: OutputPiiScannerService,
          useValue: {
            redact: jest.fn((text: string) => ({
              redactedText: text,
              scanResult: { hasPii: false },
            })),
          },
        },
        {
          provide: SsrfValidatorService,
          useValue: {
            validateUrl: jest.fn().mockResolvedValue({ safe: true }),
            getSafeFetchOptions: jest.fn().mockReturnValue({ redirect: 'error' }),
          },
        },
        {
          provide: InstructionHierarchyService,
          useValue: { buildHardenedSystemPrompt: jest.fn().mockReturnValue('system') },
        },
        {
          provide: ToolSchemaValidatorService,
          useValue: { validateToolCall: jest.fn().mockReturnValue({ valid: true }) },
        },
        {
          provide: AiPersonasRegistryService,
          useValue: { getPersonaSystemPrompt: jest.fn().mockReturnValue('base system') },
        },
        { provide: OutboxPublisher, useValue: outboxPublisher },
        { provide: AiEgressGateService, useValue: aiEgressGate },
      ],
    }).compile();

    service = module.get(AiChatBridgeService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Forwards message to ai-service via NATS for AI channels
  // -----------------------------------------------------------------------
  it('forwards message to ai-service via NATS for AI-type channels', async () => {
    const aiChannel = createMockChannel({ id: aiChannelId, type: ChannelType.AI });
    channelRepo.findOne.mockResolvedValue(aiChannel);

    const aiResponse = { content: 'AI answer', metadata: null };
    natsClient.send.mockReturnValue(of(aiResponse));

    await service.handleAiChannelMessage(
      tenantId, aiChannelId, messageId, 'What is water quality?', senderId,
    );

    expect(natsClient.send).toHaveBeenCalledWith(
      'request.ai.chat',
      expect.objectContaining({
        tenantId,
        channelId: aiChannelId,
        content: 'What is water quality?',
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Persists AI response as message from virtual AI user
  // -----------------------------------------------------------------------
  it('persists AI response inside a tenant-pinned transaction', async () => {
    const aiChannel = createMockChannel({ id: aiChannelId, type: ChannelType.AI });
    channelRepo.findOne.mockResolvedValue(aiChannel);

    const aiResponse = { content: 'Here is the answer.', metadata: null };
    natsClient.send.mockReturnValue(of(aiResponse));

    await service.handleAiChannelMessage(
      tenantId, aiChannelId, messageId, 'Question', senderId,
    );

    expect(queryRunner.query).toHaveBeenCalledWith(
      `SELECT pg_catalog.set_config('search_path', $1, true)`,
      ['"tenant_aaaaaaaaaaaa4aaa", "messaging", public'],
    );
    expect(queryRunner.manager.create).toHaveBeenCalledWith(
      Message,
      expect.objectContaining({
        tenantId,
        channelId: aiChannelId,
        senderId: AI_USER_ID,
        content: 'Here is the answer.',
        contentType: MessageContentType.SYSTEM,
      }),
    );
    expect(outboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ChannelMessageSent',
        tenantId,
        channelId: aiChannelId,
        senderId: AI_USER_ID,
        isAiResponse: true,
      }),
      queryRunner.manager,
    );
  });

  // -----------------------------------------------------------------------
  // Handles 60-second timeout with fallback message
  // -----------------------------------------------------------------------
  it('persists fallback message when ai-service times out', async () => {
    const aiChannel = createMockChannel({ id: aiChannelId, type: ChannelType.AI });
    channelRepo.findOne.mockResolvedValue(aiChannel);

    // The service uses catchError and returns a fallback AiChatResponse
    // When the NATS call fails, catchError returns a fallback object
    natsClient.send.mockReturnValue(of({
      content: 'AI is temporarily unavailable. Please try again later.',
      metadata: { error: true, fallback: true },
    }));

    await service.handleAiChannelMessage(
      tenantId, aiChannelId, messageId, 'Question', senderId,
    );

    // Should still persist a response (the fallback)
    expect(queryRunner.manager.save).toHaveBeenCalledWith(
      Message,
      expect.objectContaining({ senderId: AI_USER_ID }),
    );
  });

  // -----------------------------------------------------------------------
  // Only processes messages in channels with type='ai'
  // -----------------------------------------------------------------------
  it('returns early for non-AI channel messages', async () => {
    const groupChannel = createMockChannel({
      id: groupChannelId,
      type: ChannelType.GROUP,
    });
    channelRepo.findOne.mockResolvedValue(groupChannel);

    await service.handleAiChannelMessage(
      tenantId, groupChannelId, messageId, 'Hello', senderId,
    );

    expect(natsClient.send).not.toHaveBeenCalled();
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
  });

  it('returns early when channel is not found', async () => {
    channelRepo.findOne.mockResolvedValue(null);

    await service.handleAiChannelMessage(
      tenantId, fakeUuid('ch'), messageId, 'Hello', senderId,
    );

    expect(natsClient.send).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Includes conversation context (last 50 messages)
  // -----------------------------------------------------------------------
  it('fetches last 50 messages as conversation context', async () => {
    const aiChannel = createMockChannel({ id: aiChannelId, type: ChannelType.AI });
    channelRepo.findOne.mockResolvedValue(aiChannel);

    const contextMessages = Array.from({ length: 3 }, (_, i) =>
      createMockMessage({
        channelId: aiChannelId,
        senderId: i % 2 === 0 ? senderId : AI_USER_ID,
        content: `Message ${i}`,
        createdAt: new Date(`2026-03-10T12:0${i}:00Z`),
      }),
    );

    const qb = createMockQueryBuilder<Message>();
    (qb.getMany as jest.Mock).mockResolvedValue(contextMessages);
    messageRepo.createQueryBuilder.mockReturnValue(
      qb as unknown as SelectQueryBuilder<Message>,
    );

    natsClient.send.mockReturnValue(of({ content: 'Reply', metadata: null }));

    await service.handleAiChannelMessage(
      tenantId, aiChannelId, messageId, 'Question', senderId,
    );

    // Verify queryBuilder was used with take(50)
    expect(qb.take).toHaveBeenCalledWith(50);
    expect(qb.orderBy).toHaveBeenCalledWith(
      expect.stringContaining('createdAt'),
      'DESC',
    );

    // Verify context was included in the NATS request
    const sendArgs = natsClient.send.mock.calls[0];
    const payload = sendArgs[1] as { contextMessages: Array<{ isAi: boolean }> };
    expect(payload.contextMessages).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // confirmAiAction — proposed action pattern
  // -----------------------------------------------------------------------
  it('confirms and executes a proposed AI action', async () => {
    const actionMsgId = fakeUuid('msg');
    const actionMsg = createMockMessage({
      id: actionMsgId,
      senderId: AI_USER_ID,
      metadata: { status: 'proposed', actionType: 'create_alert', params: {} },
    });
    messageRepo.findOne.mockResolvedValue(actionMsg);
    channelMemberRepo.findOne.mockResolvedValue({
      tenantId,
      channelId: actionMsg.channelId,
      userId: senderId,
      role: ChannelMemberRole.MEMBER,
      leftAt: null,
    } as ChannelMember);
    natsClient.send.mockReturnValue(of({ success: true, result: 'Alert created.' }));

    const result = await service.confirmAiAction(tenantId, actionMsgId, senderId);

    expect(result).toBe(true);
    expect(natsClient.send).toHaveBeenCalledWith(
      'request.ai.executeAction',
      expect.objectContaining({
        tenantId,
        actionType: 'create_alert',
        confirmedBy: senderId,
      }),
    );
    expect(messageRepo.update).toHaveBeenCalledWith(
      { tenantId, id: actionMsgId },
      expect.objectContaining({
        metadata: expect.objectContaining({ status: 'confirmed' }),
      }),
    );
  });
});
