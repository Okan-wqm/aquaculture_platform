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
  ResolveField,
  Parent,
  Context,
} from '@nestjs/graphql';
import { UseGuards, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { DataSource, IsNull } from 'typeorm';
import DataLoader from 'dataloader';
import { Tenant, CurrentUser, CurrentUserPayload, Roles, Role, hasResourcePermission } from '@aquaculture/backend-common/decorators';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { TenantGuard } from '@aquaculture/backend-common/guards';

// Entities
import { Channel, ChannelType } from '../entities/channel.entity';
import { ChannelMember, ChannelMemberRole, NotificationPreference } from '../entities/channel-member.entity';
import { Message } from '../../message/entities/message.entity';

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

// Handler result types
import { GetChannelsResult } from '../queries/get-channels.handler';

// Message resolver types (for user federation)
import { PublicUserProfile } from '../../message/resolvers/message.resolver';
import { PresenceService } from '../../presence/presence.service';

// Enum input-boundary normalization SSoT (NAME → DB VALUE)
import { normalizeEnumInput } from '../../shared/enum-wire.util';

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
    private readonly dataSource: DataSource,
    private readonly presenceService: PresenceService,
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
    // Tenant-RBAC (Faz 7c): only GROUP creation is capability-gated —
    // `channels:create_group`. DM + AI channels stay open to any member, so the
    // check is conditional (a blanket guard on this multi-type mutation would
    // wrongly block DMs). Uses the shared SSoT check that TenantPermissionGuard
    // uses, so admins bypass and the verdict matches the FE hasPermission gate
    // (AquaMobil NewChatPage). The default seeded roles grant create_group to
    // every role (WhatsApp-like), so behaviour is preserved until a tenant admin
    // narrows it. Enforced independently of the FE's button-hiding.
    if (
      input.type === ChannelType.GROUP &&
      !hasResourcePermission(user, 'channels:create_group')
    ) {
      throw new ForbiddenException(
        'You do not have permission to create group channels',
      );
    }

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
    // INFRA-CRITICAL-013: GraphQL enum input boundary normalization.
    // The GraphQL enum literal can be either the TS enum NAME ('MEMBER')
    // or VALUE ('member') depending on coercion path; the CHECK constraint
    // chk_member_role only accepts the VALUE form. normalizeEnumInput is the
    // single canonical NAME→VALUE projection (derived from the enum object, so
    // it cannot drift) — the same helper the receipt/content WS path inverts via
    // toWireEnumName, and the same one updateNotificationPreference now uses.
    const normalizedRole = normalizeEnumInput(ChannelMemberRole, role);
    return this.commandBus.execute<AddMemberCommand, ChannelMember>(
      new AddMemberCommand(tenantId, user.sub, channelId, targetUserId, normalizedRole),
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
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('channelId', { type: () => ID }) channelId: string,
    @Args('preference', { type: () => NotificationPreference })
    preference: NotificationPreference,
  ): Promise<ChannelMember> {
    const member = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) => {
        const activeMember = await queryRunner.manager.findOne(ChannelMember, {
          where: { tenantId, channelId, userId: user.sub, leftAt: IsNull() },
        });

        if (!activeMember) {
          throw new NotFoundException(
            `User ${user.sub} is not an active member of channel ${channelId}`,
          );
        }

        // INFRA-CRITICAL-013 (parity with addChannelMember): the GraphQL enum
        // literal may arrive as the UPPERCASE NAME ('ALL') or the lowercase VALUE
        // ('all') depending on coercion path; chk_notification_pref accepts ONLY
        // the VALUE. Normalize through the same canonical helper so this write
        // path is uniformly constraint-safe (no fragile raw assignment).
        activeMember.notificationPreference = normalizeEnumInput(
          NotificationPreference,
          preference,
        );
        return queryRunner.manager.save(ChannelMember, activeMember);
      },
    );


    this.logger.log(
      `User ${user.sub} updated notification preference to ${preference} in channel ${channelId}`,
    );

    return member;
  }

  // ==========================================================================
  // FIELD RESOLVERS — computed fields for Channel @ObjectType
  // ==========================================================================

  /**
   * Resolve the lastMessage field for a channel.
   * Returns the most recent non-deleted message in the channel, or null.
   * When the channel list query (GetChannelsHandler) already computed lastMessageAt,
   * we still need to fetch the full message object for the GraphQL response.
   */
  @ResolveField(() => Message, { name: 'lastMessage', nullable: true, description: 'Most recent message in the channel' })
  async resolveLastMessage(
    @Parent() channel: Channel,
    @Tenant() tenantId: string,
    @Context() ctx: { lastMessageLoader?: DataLoader<string, Message | null> },
  ): Promise<Message | null> {
    if (!ctx.lastMessageLoader) {
      ctx.lastMessageLoader = new DataLoader<string, Message | null>(
        async (channelIds: readonly string[]) => {
          return this.batchLoadLastMessages(tenantId, [...channelIds]);
        },
        { cache: true },
      );
    }
    return ctx.lastMessageLoader.load(channel.id);
  }

  /**
   * Resolve the members field for a channel.
   * Returns active (non-left) members. For the channel list query,
   * members are eagerly loaded by GetChannelsHandler only for the
   * single-channel query; for the list query we resolve lazily via DataLoader.
   */
  @ResolveField(() => [ChannelMember], { name: 'members', nullable: true, description: 'Active channel members' })
  async resolveMembers(
    @Parent() channel: Channel,
    @Tenant() tenantId: string,
    @Context() ctx: { membersLoader?: DataLoader<string, ChannelMember[]> },
  ): Promise<ChannelMember[]> {
    // If already loaded (e.g. single-channel query), return directly
    if (channel.members && channel.members.length > 0 && channel.members[0]?.id) {
      return channel.members;
    }

    if (!ctx.membersLoader) {
      ctx.membersLoader = new DataLoader<string, ChannelMember[]>(
        async (channelIds: readonly string[]) => {
          return this.batchLoadMembers(tenantId, [...channelIds]);
        },
        { cache: true },
      );
    }
    return ctx.membersLoader.load(channel.id);
  }

  /**
   * Resolve the unreadCount field for a channel.
   * If already computed by GetChannelsHandler (list query), return the cached value.
   * Otherwise compute on demand for single-channel queries.
   */
  @ResolveField(() => Int, { name: 'unreadCount', nullable: true, description: 'Unread message count for the current user' })
  async resolveUnreadCount(
    @Parent() channel: Channel & { unreadCount?: number },
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<number> {
    // Already computed by GetChannelsHandler
    if (channel.unreadCount !== undefined && channel.unreadCount !== null) {
      return channel.unreadCount;
    }

    // Compute on-demand for single-channel view
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const membership = await queryRunner.manager.findOne(ChannelMember, {
        where: { tenantId, channelId: channel.id, userId: user.sub, leftAt: IsNull() },
        select: ['lastReadAt'],
      });

      if (!membership) return 0;

      const lastReadAt = membership.lastReadAt ?? new Date('1970-01-01');
      return queryRunner.manager
        .createQueryBuilder(Message, 'm')
        .where('m."tenantId" = :tenantId', { tenantId })
        .andWhere('m."channelId" = :channelId', { channelId: channel.id })
        .andWhere('m."isDeleted" = false')
        .andWhere('m."createdAt" > :lastReadAt', { lastReadAt })
        .getCount();
    });
  }

  /**
   * Resolve the memberCount field for a channel.
   * If already computed by GetChannelsHandler (list query), return the cached value.
   * Otherwise compute on demand.
   */
  @ResolveField(() => Int, { name: 'memberCount', nullable: true, description: 'Active member count' })
  async resolveMemberCount(
    @Parent() channel: Channel & { memberCount?: number },
    @Tenant() tenantId: string,
  ): Promise<number> {
    // Already computed by GetChannelsHandler
    if (channel.memberCount !== undefined && channel.memberCount !== null) {
      return channel.memberCount;
    }

    // Compute on-demand in the tenant schema, not through the source repository.
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
      queryRunner.manager.count(ChannelMember, {
        where: { tenantId, channelId: channel.id, leftAt: IsNull() },
      }),
    );
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  /**
   * Batch load the most recent non-deleted message for each channel.
   * Uses a lateral join pattern to efficiently fetch one message per channel
   * in a single query, avoiding N+1.
   *
   * @param channelIds - Array of channel UUIDs to load last messages for
   * @returns Array of Message|null in the same order as channelIds
   */
  private async batchLoadLastMessages(tenantId: string, channelIds: string[]): Promise<(Message | null)[]> {
    if (channelIds.length === 0) return [];

    const messages = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) => queryRunner.manager
        .createQueryBuilder(Message, 'm')
        .where('m."tenantId" = :tenantId', { tenantId })
        .andWhere('m."channelId" IN (:...channelIds)', { channelIds })
        .andWhere('m."isDeleted" = false')
        .orderBy('m.channelId', 'ASC')
        .addOrderBy('m.createdAt', 'DESC')
        .distinctOn(['m."channelId"'])
        .getMany(),
    );

    // Build lookup map
    const messageByChannel = new Map<string, Message>();
    for (const msg of messages) {
      messageByChannel.set(msg.channelId, msg);
    }

    return channelIds.map((id) => messageByChannel.get(id) ?? null);
  }

  /**
   * Batch load active members for multiple channels in a single query.
   *
   * @param channelIds - Array of channel UUIDs
   * @returns Array of ChannelMember arrays in the same order as channelIds
   */
  private async batchLoadMembers(tenantId: string, channelIds: string[]): Promise<ChannelMember[][]> {
    if (channelIds.length === 0) return [];

    const allMembers = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) => queryRunner.manager.find(ChannelMember, {
        where: channelIds.map((channelId) => ({ tenantId, channelId, leftAt: IsNull() })),
        order: { joinedAt: 'ASC' },
      }),
    );

    // Group by channel
    const membersByChannel = new Map<string, ChannelMember[]>();
    for (const member of allMembers) {
      const list = membersByChannel.get(member.channelId) ?? [];
      list.push(member);
      membersByChannel.set(member.channelId, list);
    }

    return channelIds.map((id) => membersByChannel.get(id) ?? []);
  }

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

// ============================================================================
// CHANNEL MEMBER RESOLVER — resolves computed fields on ChannelMember
// ============================================================================

/**
 * Resolves the `user` field on ChannelMember by loading user data
 * from the auth-service (via inter-service call or federation).
 * Uses a request-scoped DataLoader to batch user lookups and avoid N+1 queries.
 */
@Resolver(() => ChannelMember)
@UseGuards(TenantGuard)
export class ChannelMemberResolver {
  private readonly logger = new Logger(ChannelMemberResolver.name);

  constructor(
    private readonly presenceService: PresenceService,
  ) {}

  /**
   * Resolve the user field for a ChannelMember.
   * Returns a User with profile details for rendering member lists and DM channel names.
   */
  @ResolveField(() => PublicUserProfile, { name: 'user', nullable: true, description: 'User profile details for this channel member' })
  async resolveUser(
    @Parent() member: ChannelMember,
    @Tenant() tenantId: string,
    @Context() ctx: { memberUserLoader?: DataLoader<string, PublicUserProfile> },
  ): Promise<PublicUserProfile | null> {
    if (!ctx.memberUserLoader) {
      ctx.memberUserLoader = new DataLoader<string, PublicUserProfile>(
        async (userIds: readonly string[]) => {
          return this.batchLoadMemberUsers([...userIds], tenantId);
        },
        { cache: true },
      );
    }
    return ctx.memberUserLoader.load(member.userId);
  }

  /**
   * Batch load user profiles for channel members.
   *
   * TODO: Replace with actual inter-service call to auth-service for user profile data.
   *       Current implementation returns placeholder data with the user ID.
   *
   * @param userIds - Array of user UUIDs to resolve
   * @param tenantId - Tenant context for presence lookups
   * @returns Array of User objects in the same order as userIds
   */
  private async batchLoadMemberUsers(userIds: string[], tenantId: string): Promise<PublicUserProfile[]> {
    // Get online status for all users in one call
    const onlineMap = await this.presenceService.getOnlineUsers(tenantId, userIds);

    // messaging contributes only id + presence to the federated User; the gateway
    // stitches firstName/lastName/profileImageUrl from auth-service (MSG-MEDIUM-052).
    return userIds.map((id) => ({
      id,
      isOnline: onlineMap.get(id) ?? false,
      lastSeenAt: null,
    }));
  }
}
