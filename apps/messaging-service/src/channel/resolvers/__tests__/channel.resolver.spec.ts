/**
 * The ChannelResolver has deep coupling to @platform/cqrs and
 * @aquaculture/backend-common decorators. We mock the entire module
 * so that NestJS DI can resolve dependencies without real infrastructure.
 */

// Must mock BEFORE importing the resolver
const mockCommandBusExecute = jest.fn();
const mockQueryBusExecute = jest.fn();

jest.mock('@platform/cqrs', () => {
  class MockCommandBus { execute = mockCommandBusExecute; }
  class MockQueryBus { execute = mockQueryBusExecute; }
  return {
    CommandBus: MockCommandBus,
    QueryBus: MockQueryBus,
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
import { getRepositoryToken } from '@nestjs/typeorm';
import { Channel, ChannelType } from '../../entities/channel.entity';
import { ChannelMember, ChannelMemberRole, NotificationPreference } from '../../entities/channel-member.entity';
import { ChannelService } from '../../services/channel.service';
import { ChannelResolver } from '../channel.resolver';
import {
  createMockChannel,
  createMockChannelMember,
  fakeUuid,
  resetUuidCounter,
} from '../../../__tests__/test-helpers';

// Import mocked classes
import { CommandBus, QueryBus } from '@platform/cqrs';

describe('ChannelResolver', () => {
  let resolver: ChannelResolver;

  const tenantId = 'tenant-0001-0001-0001-000000000001';
  const userId = fakeUuid('usr');

  const mockChannelService = {
    buildDmPairKey: jest.fn(),
    validateChannelAccess: jest.fn(),
    saveChannel: jest.fn(),
    saveMember: jest.fn(),
  };

  function mockUser() {
    return {
      sub: userId,
      email: 'test@example.com',
      tenantId,
      roles: ['MODULE_MANAGER'],
      role: 'MODULE_MANAGER',
    };
  }

  beforeEach(async () => {
    resetUuidCounter();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelResolver,
        { provide: CommandBus, useValue: { execute: mockCommandBusExecute } },
        { provide: QueryBus, useValue: { execute: mockQueryBusExecute } },
        { provide: ChannelService, useValue: mockChannelService },
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
    const member = createMockChannelMember({
      notificationPreference: NotificationPreference.ALL,
    });
    mockChannelService.validateChannelAccess.mockResolvedValue(member);
    mockChannelService.saveMember.mockImplementation(async (m: ChannelMember) => m);

    const channelId = fakeUuid('ch');

    const result = await resolver.updateNotificationPreference(
      tenantId, mockUser() as never, channelId, NotificationPreference.MENTIONS,
    );

    expect(mockChannelService.validateChannelAccess).toHaveBeenCalledWith(
      channelId, userId,
    );
    expect(result.notificationPreference).toBe(NotificationPreference.MENTIONS);
  });
});
