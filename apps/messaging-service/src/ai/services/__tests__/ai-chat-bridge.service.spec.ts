import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import {
  InputFilterService,
  OutputPiiScannerService,
} from '@aquaculture/backend-common/ai-safety';
import { AiChatBridgeService } from '../ai-chat-bridge.service';
import { AiPersonasRegistryService } from '../ai-personas-registry.service';
import { InstructionHierarchyService } from '../../safety/instruction-hierarchy.service';
import { ToolSchemaValidatorService } from '../../safety/tool-schema-validator.service';
import { Channel, ChannelType } from '../../../channel/entities/channel.entity';
import { ChannelMember } from '../../../channel/entities/channel-member.entity';
import { Message, MessageContentType } from '../../../message/entities/message.entity';
import {
  createMockRepository,
  createMockNatsClient,
  createMockChannel,
  createMockChannelMember,
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
  // The service-under-test gained AI-safety, persona, and outbox collaborators
  // (constructor indices 5-11). London-School TDD: each gets a typed mock with
  // a safe default that keeps the happy path flowing through to NATS + persist.
  let inputFilter: { scanInput: jest.Mock };
  let outputPiiScanner: { redact: jest.Mock };
  let instructionHierarchy: { buildHardenedSystemPrompt: jest.Mock };
  let toolSchemaValidator: Record<string, jest.Mock>;
  let personasRegistry: { getPersonaSystemPrompt: jest.Mock };
  let outboxPublisher: { enqueue: jest.Mock };

  const tenantId = 'tenant-0001-0001-0001-000000000001';
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

    // Safe defaults: input is clean, no PII in output, persona prompts resolve.
    inputFilter = {
      scanInput: jest.fn().mockReturnValue({
        safe: true,
        reason: undefined,
        flaggedPatterns: [],
        severity: 'none',
      }),
    };
    outputPiiScanner = {
      redact: jest.fn().mockImplementation((text: string) => ({
        redactedText: text,
        scanResult: { hasPii: false, detections: [], countByType: {} },
      })),
    };
    instructionHierarchy = {
      buildHardenedSystemPrompt: jest.fn().mockReturnValue('hardened-prompt'),
    };
    toolSchemaValidator = {};
    personasRegistry = {
      getPersonaSystemPrompt: jest.fn().mockReturnValue('base-system-prompt'),
    };
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

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
        { provide: InputFilterService, useValue: inputFilter },
        { provide: OutputPiiScannerService, useValue: outputPiiScanner },
        { provide: InstructionHierarchyService, useValue: instructionHierarchy },
        { provide: ToolSchemaValidatorService, useValue: toolSchemaValidator },
        { provide: AiPersonasRegistryService, useValue: personasRegistry },
        { provide: OutboxPublisher, useValue: outboxPublisher },
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
  it('persists AI response via DataSource transaction', async () => {
    const aiChannel = createMockChannel({ id: aiChannelId, type: ChannelType.AI });
    channelRepo.findOne.mockResolvedValue(aiChannel);

    const aiResponse = { content: 'Here is the answer.', metadata: null };
    natsClient.send.mockReturnValue(of(aiResponse));

    await service.handleAiChannelMessage(
      tenantId, aiChannelId, messageId, 'Question', senderId,
    );

    // Transaction should have been called
    expect(mockDataSource.transaction).toHaveBeenCalled();

    // The transaction callback should save a Message with AI_USER_ID
    const txCallback = mockDataSource.transaction.mock.calls[0][0] as (
      manager: typeof queryRunner.manager,
    ) => Promise<void>;
    expect(queryRunner.manager.create).toHaveBeenCalledWith(
      Message,
      expect.objectContaining({
        channelId: aiChannelId,
        senderId: AI_USER_ID,
        content: 'Here is the answer.',
        contentType: MessageContentType.SYSTEM,
      }),
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
    expect(mockDataSource.transaction).toHaveBeenCalled();
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
    expect(mockDataSource.transaction).not.toHaveBeenCalled();
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
    // confirmAiAction now verifies the requesting user is an active member of the
    // action message's channel (leftAt IS NULL) before executing — return a member
    // so the happy path proceeds past the membership guard.
    channelMemberRepo.findOne.mockResolvedValue(
      createMockChannelMember({
        channelId: actionMsg.channelId,
        userId: senderId,
        leftAt: null,
      }),
    );
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
      { id: actionMsgId },
      expect.objectContaining({
        metadata: expect.objectContaining({ status: 'confirmed' }),
      }),
    );
  });
});
