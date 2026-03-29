/**
 * @module ChannelModule
 * @description Channel domain module providing CQRS command/query handlers,
 * GraphQL resolver, and domain services for channel lifecycle management.
 * @see ADR-012 section 3 (Channel domain)
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { Channel } from './entities/channel.entity';
import { ChannelMember } from './entities/channel-member.entity';

// Command Handlers
import { CreateChannelHandler } from './commands/create-channel.handler';
import { AddMemberHandler } from './commands/add-member.handler';
import { RemoveMemberHandler } from './commands/remove-member.handler';
import { UpdateChannelHandler } from './commands/update-channel.handler';

// Query Handlers
import { GetChannelsHandler } from './queries/get-channels.handler';
import { GetChannelHandler } from './queries/get-channel.handler';

// Resolver
import { ChannelResolver } from './resolvers/channel.resolver';

// Service
import { ChannelService } from './services/channel.service';

const commandHandlers = [
  CreateChannelHandler,
  AddMemberHandler,
  RemoveMemberHandler,
  UpdateChannelHandler,
];

const queryHandlers = [
  GetChannelsHandler,
  GetChannelHandler,
];

@Module({
  imports: [TypeOrmModule.forFeature([Channel, ChannelMember])],
  providers: [
    ...commandHandlers,
    ...queryHandlers,
    ChannelResolver,
    ChannelService,
  ],
  exports: [ChannelService, TypeOrmModule],
})
export class ChannelModule {}
