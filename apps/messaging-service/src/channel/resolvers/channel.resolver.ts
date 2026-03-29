/**
 * @module ChannelResolver
 * @description GraphQL resolver for channel queries and mutations.
 * Handles channel CRUD, membership management, notification preferences,
 * and channel archival with CQRS command/query dispatch.
 * @see ADR-012 section 3.4 (Channel GraphQL API)
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  ObjectType,
  Field,
} from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import {
  TenantGuard,
  Tenant,
  CurrentUser,
  CurrentUserPayload,
  Roles,
  Role,
} from '@aquaculture/backend-common';

// Entities
import { Channel, ChannelType } from '../entities/channel.entity';
import { ChannelMember, ChannelMemberRole, NotificationPreference } from '../entities/channel-member.entity';

// DTOs
import { CreateChannelInput } from '../dto/create-channel.input';
import { UpdateChannelInput } from '../dto/update-channel.input';
import { ChannelFilterInput } from '../dto/channel-filter.input';

// Commands
import { CreateChannelCommand } from '../commands/create-channel.command';
import { UpdateChannelCommand } from '../commands/update-channel.command';
import { AddMemberCommand } from '../commands/add-member.command';
import { RemoveMemberCommand } from '../commands/remove-member.command';
import { ArchiveChannelCommand } from '../commands/archive-channel.command';

// Queries
import { GetChannelsQuery } from '../queries/get-channels.query';
import { GetChannelQuery } from '../queries/get-channel.query';

// Service
import { ChannelService } from '../services/channel.service';

// Handler result types
import { GetChannelsResult } from '../queries/get-channels.handler';

// ============================================================================
// RESPONSE TYPES
// ============================================================================

/**
 * Paginated channel list response for the myChannels query.
 */
@ObjectType()
export class ChannelPage {
  @Field(() => [Channel])
  items!: Channel[];

  @Field(() => Int)
  total!: number;
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => Channel)
@UseGuards(TenantGuard)
export class ChannelResolver {
  private readonly logger = new Logger(ChannelResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly channelService: ChannelService,
    private readonly dataSource: DataSource,
  ) {}

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  /**
   * Return the paginated list of channels the authenticated user belongs to.
   */
  @Query(() => ChannelPage, { description: 'List channels for the current user' })
  @Roles(Role.MODULE_USER)
  async myChannels(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('filter', { type: () => ChannelFilterInput, nullable: true })
    filter?: ChannelFilterInput,
  ): Promise<ChannelPage> {
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;

    this.logger.debug(`myChannels for user ${user.sub}, limit=${limit}, offset=${offset}`);

    return this.queryBus.execute<GetChannelsQuery, GetChannelsResult>(
      new GetChannelsQuery(tenantId, user.sub, limit, offset),
    );
  }

  /**
   * Return a single channel by ID (with active members list).
   */
  @Query(() => Channel, { description: 'Get a channel by ID' })
  @Roles(Role.MODULE_USER)
  async channel(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Channel> {
    return this.queryBus.execute<GetChannelQuery, Channel>(
      new GetChannelQuery(tenantId, user.sub, id),
    );
  }

  /**
   * Get-or-create a DIRECT channel with another user.
   */
  @Query(() => Channel, { description: 'Get or create a direct channel with another user' })
  @Roles(Role.MODULE_USER)
  async directChannel(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('userId', { type: () => ID }) targetUserId: string,
  ): Promise<Channel> {
    const input = new CreateChannelInput();
    input.type = ChannelType.DIRECT;
    input.memberIds = [user.sub, targetUserId];

    const primaryRole = this.getPrimaryRole(user);

    return this.commandBus.execute<CreateChannelCommand, Channel>(
      new CreateChannelCommand(tenantId, user.sub, input, primaryRole),
    );
  }

  // ==========================================================================
  // MUTATIONS
  // ==========================================================================

  /**
   * Create a new channel (GROUP, DIRECT, or AI).
   */
  @Mutation(() => Channel, { description: 'Create a new channel' })
  @Roles(Role.MODULE_USER)
  async createChannel(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('input') input: CreateChannelInput,
  ): Promise<Channel> {
    const primaryRole = this.getPrimaryRole(user);

    return this.commandBus.execute<CreateChannelCommand, Channel>(
      new CreateChannelCommand(tenantId, user.sub, input, primaryRole),
    );
  }

  /**
   * Update channel metadata (name, description, avatarUrl).
   */
  @Mutation(() => Channel, { description: 'Update channel metadata' })
  @Roles(Role.MODULE_USER)
  async updateChannel(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateChannelInput,
  ): Promise<Channel> {
    return this.commandBus.execute<UpdateChannelCommand, Channel>(
      new UpdateChannelCommand(tenantId, user.sub, id, input),
    );
  }

  /**
   * Archive a channel (soft-delete). Only ADMIN+ can archive.
   */
  @Mutation(() => Boolean, { description: 'Archive a channel' })
  @Roles(Role.MODULE_USER)
  async archiveChannel(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    return this.commandBus.execute<ArchiveChannelCommand, boolean>(
      new ArchiveChannelCommand(tenantId, user.sub, id),
    );
  }

  /**
   * Add a member to a channel with a specified role.
   */
  @Mutation(() => ChannelMember, { description: 'Add a member to a channel' })
  @Roles(Role.MODULE_USER)
  async addChannelMember(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('channelId', { type: () => ID }) channelId: string,
    @Args('userId', { type: () => ID }) targetUserId: string,
    @Args('role', { type: () => ChannelMemberRole, defaultValue: ChannelMemberRole.MEMBER })
    role: ChannelMemberRole,
  ): Promise<ChannelMember> {
    return this.commandBus.execute<AddMemberCommand, ChannelMember>(
      new AddMemberCommand(tenantId, user.sub, channelId, targetUserId, role),
    );
  }

  /**
   * Remove a member from a channel (or self-leave).
   */
  @Mutation(() => Boolean, { description: 'Remove a member from a channel' })
  @Roles(Role.MODULE_USER)
  async removeChannelMember(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('channelId', { type: () => ID }) channelId: string,
    @Args('userId', { type: () => ID }) targetUserId: string,
  ): Promise<boolean> {
    return this.commandBus.execute<RemoveMemberCommand, boolean>(
      new RemoveMemberCommand(tenantId, user.sub, channelId, targetUserId),
    );
  }

  /**
   * Update the notification preference for the current user in a channel.
   */
  @Mutation(() => ChannelMember, { description: 'Update notification preference for a channel' })
  @Roles(Role.MODULE_USER)
  async updateNotificationPreference(
    @Tenant() _tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('channelId', { type: () => ID }) channelId: string,
    @Args('preference', { type: () => NotificationPreference })
    preference: NotificationPreference,
  ): Promise<ChannelMember> {
    const member = await this.channelService.validateChannelAccess(
      channelId,
      user.sub,
    );

    member.notificationPreference = preference;
    await this.dataSource.transaction(async (manager) => {
      await manager.save(ChannelMember, member);
    });

    this.logger.log(
      `User ${user.sub} updated notification preference to ${preference} in channel ${channelId}`,
    );

    return member;
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  /**
   * Extract the highest platform role from the user payload.
   */
  private getPrimaryRole(user: CurrentUserPayload): string {
    const hierarchy: string[] = [
      Role.SUPER_ADMIN,
      Role.TENANT_ADMIN,
      Role.MODULE_MANAGER,
      Role.MODULE_USER,
    ];

    const userRoles = user.roles ?? [];
    if (user.role && !userRoles.includes(user.role)) {
      userRoles.push(user.role);
    }

    for (const role of hierarchy) {
      if (userRoles.includes(role)) {
        return role;
      }
    }

    return Role.MODULE_USER;
  }
}
