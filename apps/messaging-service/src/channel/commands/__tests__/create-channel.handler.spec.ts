import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { Channel, ChannelType } from '../../entities/channel.entity';
import { ChannelMember, ChannelMemberRole } from '../../entities/channel-member.entity';
import { ChannelService } from '../../services/channel.service';
import { TenantUserAdmissionService } from '../../services/tenant-user-admission.service';
import { MessagingMetricsService } from '../../../metrics/messaging-metrics.service';
import { CreateChannelHandler } from '../create-channel.handler';
import { CreateChannelCommand } from '../create-channel.command';
import { CreateChannelInput } from '../../dto/create-channel.input';
import {
  createMockChannel,
  createMockQueryRunner,
  createMockDataSource,
  fakeUuid,
  resetUuidCounter,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';

describe('CreateChannelHandler', () => {
  let handler: CreateChannelHandler;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let channelScopedRepo: { findOne: jest.Mock };
  let channelService: { buildDmPairKey: jest.Mock };
  let metricsService: { incrementChannelsCreated: jest.Mock };
  let outboxPublisher: { enqueue: jest.Mock };
  let admissionService: { assertActiveTenantUsers: jest.Mock };

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const creatorId = fakeUuid('usr');
  const memberA = fakeUuid('usr');
  const memberB = fakeUuid('usr');

  function makeInput(overrides: Partial<CreateChannelInput> = {}): CreateChannelInput {
    const input = new CreateChannelInput();
    input.type = overrides.type ?? ChannelType.GROUP;
    input.name = overrides.name ?? 'Team Chat';
    input.memberIds = overrides.memberIds ?? [memberA, memberB];
    if (overrides.description !== undefined) input.description = overrides.description;
    return input;
  }

  beforeEach(async () => {
    resetUuidCounter();

    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    // The DM-existence check goes through a TenantScopedRepository over
    // Channel (resolved from the DataSource, NOT queryRunner.manager.findOne),
    // so the DataSource must hand back a controllable repo. Default: no
    // existing DM; the idempotent-DM case overrides findOne below.
    channelScopedRepo = { findOne: jest.fn().mockResolvedValue(null) };
    mockDataSource.getRepository.mockReturnValue(channelScopedRepo);

    channelService = {
      buildDmPairKey: jest.fn((a: string, b: string) => {
        const sorted = [a.toLowerCase(), b.toLowerCase()].sort();
        return `${sorted[0]}|${sorted[1]}`;
      }),
    };
    metricsService = { incrementChannelsCreated: jest.fn() };
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
    // #406 admission gate: default to allow (assert resolves) so existing
    // create-channel cases exercise the happy path; deny-path cases override.
    admissionService = { assertActiveTenantUsers: jest.fn().mockResolvedValue(undefined) };

    // Default: manager.save returns the data it received (with an id)
    let saveCounter = 0;
    queryRunner.manager.save.mockImplementation(
      (_Entity: unknown, data: unknown) => {
        saveCounter += 1;
        if (Array.isArray(data)) return Promise.resolve(data);
        return Promise.resolve({ id: fakeUuid('saved'), ...data as Record<string, unknown> });
      },
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateChannelHandler,
        { provide: DataSource, useValue: mockDataSource },
        { provide: ChannelService, useValue: channelService },
        { provide: MessagingMetricsService, useValue: metricsService },
        { provide: OutboxPublisher, useValue: outboxPublisher },
        { provide: TenantUserAdmissionService, useValue: admissionService },
      ],
    }).compile();

    handler = module.get(CreateChannelHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // GROUP channel creation
  // -----------------------------------------------------------------------
  it('creates GROUP channel with valid input and MODULE_MANAGER role', async () => {
    const cmd = new CreateChannelCommand(
      tenantId, creatorId, makeInput(), 'MODULE_MANAGER',
    );

    const result = await handler.execute(cmd);

    expect(result).toBeDefined();
    expect(result.type).toBe(ChannelType.GROUP);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
  });

  it('allows a plain MODULE_USER member to create a GROUP (MSG-MEDIUM-070, WhatsApp-like)', async () => {
    const cmd = new CreateChannelCommand(
      tenantId, creatorId, makeInput(), 'MODULE_USER',
    );

    const result = await handler.execute(cmd);

    expect(result.type).toBe(ChannelType.GROUP);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // DIRECT channel creation
  // -----------------------------------------------------------------------
  it('creates DIRECT channel between two users', async () => {
    // No existing DM
    queryRunner.manager.findOne.mockResolvedValueOnce(null);

    const input = makeInput({
      type: ChannelType.DIRECT,
      memberIds: [memberA],
    });
    const cmd = new CreateChannelCommand(tenantId, creatorId, input, 'MODULE_MANAGER');

    const result = await handler.execute(cmd);

    expect(result).toBeDefined();
    expect(result.type).toBe(ChannelType.DIRECT);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('returns existing DM if dmPairKey already exists (idempotent)', async () => {
    const existingChannel = createMockChannel({
      type: ChannelType.DIRECT,
      dmPairKey: channelService.buildDmPairKey(creatorId, memberA),
      members: [],
    });

    channelScopedRepo.findOne.mockResolvedValueOnce(existingChannel);

    const input = makeInput({
      type: ChannelType.DIRECT,
      memberIds: [memberA],
    });
    const cmd = new CreateChannelCommand(tenantId, creatorId, input, 'MODULE_MANAGER');

    const result = await handler.execute(cmd);

    expect(result.id).toBe(existingChannel.id);
    // Idempotent early-return: the existing DM is found via the
    // pre-transaction TenantScopedRepository check, so the handler returns
    // before opening any transaction and never writes.
    expect(queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(queryRunner.manager.save).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Member role assignment
  // -----------------------------------------------------------------------
  it('sets creator as OWNER for GROUP channels', async () => {
    const cmd = new CreateChannelCommand(
      tenantId, creatorId, makeInput({ memberIds: [memberA] }), 'MODULE_MANAGER',
    );

    await handler.execute(cmd);

    // Second save call is the members array
    const membersSaveCall = queryRunner.manager.save.mock.calls.find(
      (call) => call[0] === ChannelMember,
    );
    expect(membersSaveCall).toBeDefined();
    const members = membersSaveCall![1] as Partial<ChannelMember>[];
    const ownerMember = members.find((m) => m.userId === creatorId);
    expect(ownerMember).toBeDefined();
    expect(ownerMember?.role).toBe(ChannelMemberRole.OWNER);
  });

  it('sets both users as MEMBER for DIRECT channels', async () => {
    mockDataSource.getRepository = jest.fn().mockReturnValue({
      findOne: jest.fn().mockResolvedValue(null),
    });

    const input = makeInput({
      type: ChannelType.DIRECT,
      memberIds: [memberA],
    });
    const cmd = new CreateChannelCommand(tenantId, creatorId, input, 'MODULE_MANAGER');

    await handler.execute(cmd);

    const membersSaveCall = queryRunner.manager.save.mock.calls.find(
      (call) => call[0] === ChannelMember,
    );
    expect(membersSaveCall).toBeDefined();
    const members = membersSaveCall![1] as Partial<ChannelMember>[];
    for (const m of members) {
      expect(m.role).toBe(ChannelMemberRole.MEMBER);
    }
  });

  // -----------------------------------------------------------------------
  // Outbox
  // -----------------------------------------------------------------------
  it('writes ChannelCreated event to outbox in transaction', async () => {
    const cmd = new CreateChannelCommand(
      tenantId, creatorId, makeInput({ name: 'Events' }), 'MODULE_MANAGER',
    );

    await handler.execute(cmd);

    expect(outboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ChannelCreated' }),
      queryRunner.manager,
    );
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------
  it('rejects DIRECT channel with self as the only participant', async () => {
    mockDataSource.getRepository = jest.fn().mockReturnValue({
      findOne: jest.fn().mockResolvedValue(null),
    });

    const input = makeInput({
      type: ChannelType.DIRECT,
      memberIds: [creatorId], // self
    });
    const cmd = new CreateChannelCommand(tenantId, creatorId, input, 'MODULE_MANAGER');

    await expect(handler.execute(cmd)).rejects.toThrow(BadRequestException);
  });

  // -----------------------------------------------------------------------
  // Transaction safety
  // -----------------------------------------------------------------------
  it('rolls back transaction on error', async () => {
    queryRunner.manager.save.mockRejectedValueOnce(new Error('DB failure'));

    const cmd = new CreateChannelCommand(
      tenantId, creatorId, makeInput(), 'MODULE_MANAGER',
    );

    await expect(handler.execute(cmd)).rejects.toThrow();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalled();
  });
});
