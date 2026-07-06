/**
 * The ChannelResolver has deep coupling to @platform/cqrs and
 * @aquaculture/backend-common decorators. We mock the entire module
 * so that NestJS DI can resolve dependencies without real infrastructure.
 */

// Must mock BEFORE importing the resolver
const mockCommandBusExecute = jest.fn();
const mockQueryBusExecute = jest.fn();

jest.mock('@nestjs/cqrs', () => {
  class MockCommandBus { execute = mockCommandBusExecute; }
  class MockQueryBus { execute = mockQueryBusExecute; }
  return {
    CommandBus: MockCommandBus,
    QueryBus: MockQueryBus,
    CqrsModule: { forRoot: () => ({ module: class {} }) },
    CommandHandler: () => () => undefined,
    QueryHandler: () => () => undefined,
    ICommand: class {},
    IQuery: class {},
  };
});

jest.mock('@aquaculture/backend-common', () => ({
  TenantGuard: class {},
  Tenant: () => () => undefined,
  CurrentUser: () => () => undefined,
  Roles: () => () => undefined,
  Role: {
    SUPER_ADMIN: 'SUPER_ADMIN',
    TENANT_ADMIN: 'TENANT_ADMIN',
    MODULE_MANAGER: 'MODULE_MANAGER',
    MODULE_USER: 'MODULE_USER',
  },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Channel, ChannelType } from '../../entities/channel.entity';
import { ChannelMember, ChannelMemberRole, NotificationPreference } from '../../entities/channel-member.entity';
import { ChannelService } from '../../services/channel.service';
import { PresenceService } from '../../../presence/presence.service';
import { ChannelResolver } from '../channel.resolver';
import {
  createMockChannel,
  createMockChannelMember,
  createMockDataSource,
  createMockQueryRunner,
  fakeUuid,
  MockQueryRunner,
  resetUuidCounter,
} from '../../../__tests__/test-helpers';

// Import mocked classes
import { CommandBus, QueryBus } from '@nestjs/cqrs';

describe('ChannelResolver', () => {
  let resolver: ChannelResolver;
  let queryRunner: MockQueryRunner;

  const tenantId = '00000000-0000-4000-8000-000000000001';
  const userId = fakeUuid('usr');

  const mockChannelService = {
    buildDmPairKey: jest.fn(),
    validateChannelAccess: jest.fn(),
    saveChannel: jest.fn(),
    saveMember: jest.fn(),
  };

  function mockUser(resourcePermissions: string[] = ['channels:create_group']) {
    return {
      sub: userId,
      email: 'test@example.com',
      tenantId,
      roles: ['MODULE_MANAGER'],
      role: 'MODULE_MANAGER',
      // Faz 7c: a properly-provisioned member carries tenant-RBAC capabilities;
      // default includes channels:create_group (the WhatsApp-like seed default).
      resourcePermissions,
    };
  }

  beforeEach(async () => {
    resetUuidCounter();
    jest.clearAllMocks();
    queryRunner = createMockQueryRunner();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelResolver,
        { provide: CommandBus, useValue: { execute: mockCommandBusExecute } },
        { provide: QueryBus, useValue: { execute: mockQueryBusExecute } },
        { provide: ChannelService, useValue: mockChannelService },
        { provide: DataSource, useValue: createMockDataSource(queryRunner) },
        { provide: PresenceService, useValue: { getOnlineUsers: jest.fn() } },
      ],
    }).compile();

    resolver = module.get(ChannelResolver);
  });

  // -----------------------------------------------------------------------
  // myChannels query
  // -----------------------------------------------------------------------
  it('myChannels returns paginated channel list', async () => {
    const channels = [
      createMockChannel({ name: 'Ops' }),
      createMockChannel({ name: 'Dev' }),
    ];
    mockQueryBusExecute.mockResolvedValue({
      items: channels,
      total: 2,
    });

    const result = await resolver.myChannels(tenantId, mockUser() as never);

    expect(mockQueryBusExecute).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // channel query -- single
  // -----------------------------------------------------------------------
  it('channel returns single channel for member', async () => {
    const channel = createMockChannel({ name: 'Team' });
    mockQueryBusExecute.mockResolvedValue(channel);

    const channelId = fakeUuid('ch');
    const result = await resolver.channel(tenantId, mockUser() as never, channelId);

    expect(mockQueryBusExecute).toHaveBeenCalledTimes(1);
    expect(result.name).toBe('Team');
  });

  // -----------------------------------------------------------------------
  // createChannel mutation
  // -----------------------------------------------------------------------
  it('createChannel dispatches CreateChannelCommand via commandBus', async () => {
    const newChannel = createMockChannel({ name: 'New Channel' });
    mockCommandBusExecute.mockResolvedValue(newChannel);

    const input = {
      type: ChannelType.GROUP,
      name: 'New Channel',
      memberIds: [fakeUuid('usr')],
    };

    const result = await resolver.createChannel(tenantId, mockUser() as never, input as never);

    expect(mockCommandBusExecute).toHaveBeenCalledTimes(1);
    expect(result.name).toBe('New Channel');
  });

  it('createChannel forbids GROUP creation without the channels:create_group capability', async () => {
    const input = {
      type: ChannelType.GROUP,
      name: 'No Perm Group',
      memberIds: [fakeUuid('usr')],
    };

    // Member with NO tenant grant → group creation denied (Faz 7c). The FE hides
    // the button; the backend enforces independently.
    await expect(
      resolver.createChannel(tenantId, mockUser([]) as never, input as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockCommandBusExecute).not.toHaveBeenCalled();
  });

  it('createChannel allows a DIRECT channel WITHOUT the group capability (only GROUP is gated)', async () => {
    const newChannel = createMockChannel({ type: ChannelType.DIRECT });
    mockCommandBusExecute.mockResolvedValue(newChannel);

    const input = {
      type: ChannelType.DIRECT,
      memberIds: [fakeUuid('usr')],
    };

    await resolver.createChannel(tenantId, mockUser([]) as never, input as never);
    expect(mockCommandBusExecute).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // addChannelMember mutation
  // -----------------------------------------------------------------------
  it('addChannelMember dispatches AddMemberCommand', async () => {
    const member = createMockChannelMember({});
    mockCommandBusExecute.mockResolvedValue(member);

    const channelId = fakeUuid('ch');
    const targetUserId = fakeUuid('usr');

    const result = await resolver.addChannelMember(
      tenantId, mockUser() as never, channelId, targetUserId, ChannelMemberRole.MEMBER,
    );

    expect(mockCommandBusExecute).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // updateNotificationPreference mutation
  // -----------------------------------------------------------------------
  it('updateNotificationPreference updates preference', async () => {
    const channelId = fakeUuid('ch');
    const member = createMockChannelMember({
      tenantId,
      channelId,
      userId,
      notificationPreference: NotificationPreference.ALL,
    });
    queryRunner.manager.findOne.mockResolvedValue(member);
    queryRunner.manager.save.mockImplementation(async (_Entity: unknown, data: unknown) => data);

    const result = await resolver.updateNotificationPreference(
      tenantId, mockUser() as never, channelId, NotificationPreference.MENTIONS,
    );

    expect(queryRunner.manager.findOne).toHaveBeenCalled();
    expect(queryRunner.manager.save).toHaveBeenCalled();
    expect(result.notificationPreference).toBe(NotificationPreference.MENTIONS);
  });
});
