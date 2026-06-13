import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { Channel, ChannelType } from '../../entities/channel.entity';
import { ChannelMember, ChannelMemberRole } from '../../entities/channel-member.entity';
import { TenantUserAdmissionService } from '../../services/tenant-user-admission.service';
import { AddMemberHandler } from '../add-member.handler';
import { AddMemberCommand } from '../add-member.command';
import {
  createMockChannel,
  createMockChannelMember,
  createMockQueryRunner,
  createMockDataSource,
  fakeUuid,
  resetUuidCounter,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';

describe('AddMemberHandler', () => {
  let handler: AddMemberHandler;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let outboxPublisher: { enqueue: jest.Mock };
  let admissionService: { assertActiveTenantUsers: jest.Mock };

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const channelId = fakeUuid('ch');
  const actorId = fakeUuid('usr');
  const targetUserId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
    // DİLİM-2 admission gate: the handler asserts targetUserId belongs to the
    // tenant (fail-closed) BEFORE opening the transaction. Default to allow
    // (assert resolves) so the role-hierarchy cases exercise the membership
    // write path; a deny-path case would override this to reject.
    admissionService = { assertActiveTenantUsers: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AddMemberHandler,
        { provide: DataSource, useValue: mockDataSource },
        { provide: OutboxPublisher, useValue: outboxPublisher },
        { provide: TenantUserAdmissionService, useValue: admissionService },
      ],
    }).compile();

    handler = module.get(AddMemberHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Sets up mock findOne calls in sequence:
   * 1. channel lookup
   * 2. actor membership lookup
   * 3. target existing membership lookup (if provided)
   */
  function setupFinds(
    channel: Partial<Channel>,
    actorMember: Partial<ChannelMember> | null,
    targetMember: Partial<ChannelMember> | null = null,
  ): void {
    queryRunner.manager.findOne
      .mockResolvedValueOnce(channel)       // channel
      .mockResolvedValueOnce(actorMember)   // actor
      .mockResolvedValueOnce(targetMember); // target
  }

  const defaultChannel = createMockChannel({
    id: channelId,
    type: ChannelType.GROUP,
    isArchived: false,
  });

  // -----------------------------------------------------------------------
  // OWNER permissions
  // -----------------------------------------------------------------------
  it('OWNER can add member with MEMBER role', async () => {
    setupFinds(
      defaultChannel,
      createMockChannelMember({ channelId, userId: actorId, role: ChannelMemberRole.OWNER }),
      null,
    );

    const cmd = new AddMemberCommand(tenantId, actorId, channelId, targetUserId, ChannelMemberRole.MEMBER);
    const result = await handler.execute(cmd);

    expect(result).toBeDefined();
    expect(result.userId).toBe(targetUserId);
    expect(result.tenantId).toBe(tenantId);
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.query).toHaveBeenCalledWith(
      `SELECT pg_catalog.set_config('search_path', $1, true)`,
      ['"tenant_aaaaaaaaaaaa4aaa", "messaging", public'],
    );
  });

  it('OWNER can add member with ADMIN role', async () => {
    setupFinds(
      defaultChannel,
      createMockChannelMember({ channelId, userId: actorId, role: ChannelMemberRole.OWNER }),
      null,
    );

    const cmd = new AddMemberCommand(tenantId, actorId, channelId, targetUserId, ChannelMemberRole.ADMIN);
    const result = await handler.execute(cmd);
    expect(result.role).toBe(ChannelMemberRole.ADMIN);
  });

  it('OWNER can add member with OWNER role', async () => {
    setupFinds(
      defaultChannel,
      createMockChannelMember({ channelId, userId: actorId, role: ChannelMemberRole.OWNER }),
      null,
    );

    const cmd = new AddMemberCommand(tenantId, actorId, channelId, targetUserId, ChannelMemberRole.OWNER);
    const result = await handler.execute(cmd);
    expect(result.role).toBe(ChannelMemberRole.OWNER);
  });

  // -----------------------------------------------------------------------
  // ADMIN permissions
  // -----------------------------------------------------------------------
  it('ADMIN can add member with MEMBER role', async () => {
    setupFinds(
      defaultChannel,
      createMockChannelMember({ channelId, userId: actorId, role: ChannelMemberRole.ADMIN }),
      null,
    );

    const cmd = new AddMemberCommand(tenantId, actorId, channelId, targetUserId, ChannelMemberRole.MEMBER);
    const result = await handler.execute(cmd);
    expect(result.role).toBe(ChannelMemberRole.MEMBER);
  });

  it('ADMIN can add member with ADMIN role', async () => {
    setupFinds(
      defaultChannel,
      createMockChannelMember({ channelId, userId: actorId, role: ChannelMemberRole.ADMIN }),
      null,
    );

    const cmd = new AddMemberCommand(tenantId, actorId, channelId, targetUserId, ChannelMemberRole.ADMIN);
    const result = await handler.execute(cmd);
    expect(result.role).toBe(ChannelMemberRole.ADMIN);
  });

  it('ADMIN CANNOT add member with OWNER role (ForbiddenException)', async () => {
    setupFinds(
      defaultChannel,
      createMockChannelMember({ channelId, userId: actorId, role: ChannelMemberRole.ADMIN }),
      null,
    );

    const cmd = new AddMemberCommand(tenantId, actorId, channelId, targetUserId, ChannelMemberRole.OWNER);

    await expect(handler.execute(cmd)).rejects.toThrow(ForbiddenException);
  });

  // -----------------------------------------------------------------------
  // MEMBER permissions
  // -----------------------------------------------------------------------
  it('MEMBER cannot add anyone (ForbiddenException)', async () => {
    setupFinds(
      defaultChannel,
      createMockChannelMember({ channelId, userId: actorId, role: ChannelMemberRole.MEMBER }),
      null,
    );

    const cmd = new AddMemberCommand(tenantId, actorId, channelId, targetUserId, ChannelMemberRole.MEMBER);

    await expect(handler.execute(cmd)).rejects.toThrow(ForbiddenException);
  });

  // -----------------------------------------------------------------------
  // Re-activation of previously left member
  // -----------------------------------------------------------------------
  it('re-activates member who previously left (sets leftAt = null)', async () => {
    const leftMember = createMockChannelMember({
      channelId,
      userId: targetUserId,
      role: ChannelMemberRole.MEMBER,
      leftAt: new Date('2026-03-15T00:00:00Z'),
    });

    setupFinds(
      defaultChannel,
      createMockChannelMember({ channelId, userId: actorId, role: ChannelMemberRole.OWNER }),
      leftMember,
    );

    const cmd = new AddMemberCommand(tenantId, actorId, channelId, targetUserId, ChannelMemberRole.MEMBER);
    const result = await handler.execute(cmd);

    expect(result.leftAt).toBeNull();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Duplicate check
  // -----------------------------------------------------------------------
  it('rejects adding member already in channel (active)', async () => {
    const activeMember = createMockChannelMember({
      channelId,
      userId: targetUserId,
      leftAt: null, // active
    });

    setupFinds(
      defaultChannel,
      createMockChannelMember({ channelId, userId: actorId, role: ChannelMemberRole.OWNER }),
      activeMember,
    );

    const cmd = new AddMemberCommand(tenantId, actorId, channelId, targetUserId, ChannelMemberRole.MEMBER);

    await expect(handler.execute(cmd)).rejects.toThrow(BadRequestException);
  });

  // -----------------------------------------------------------------------
  // Outbox
  // -----------------------------------------------------------------------
  it('writes ChannelMemberAdded event to outbox', async () => {
    setupFinds(
      defaultChannel,
      createMockChannelMember({ channelId, userId: actorId, role: ChannelMemberRole.OWNER }),
      null,
    );

    const cmd = new AddMemberCommand(tenantId, actorId, channelId, targetUserId, ChannelMemberRole.MEMBER);
    await handler.execute(cmd);

    expect(outboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ChannelMemberAdded',
        tenantId,
        channelId,
        userId: targetUserId,
      }),
      queryRunner.manager,
    );
  });
});
