/**
 * @module ChannelModule
 * @description Channel domain module providing CQRS command/query handlers,
 * GraphQL resolvers (Channel + ChannelMember), and domain services for
 * channel lifecycle management.
 * @see ADR-012 section 3 (Channel domain)
 */
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { buildNatsTransportOptions } from '@aquaculture/backend-common/nats';

// Entities
import { Channel } from './entities/channel.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { Message } from '../message/entities/message.entity';

// Command Handlers
import { CreateChannelHandler } from './commands/create-channel.handler';
import { AddMemberHandler } from './commands/add-member.handler';
import { RemoveMemberHandler } from './commands/remove-member.handler';
import { UpdateChannelHandler } from './commands/update-channel.handler';
import { ArchiveChannelHandler } from './commands/archive-channel.handler';

// Query Handlers
import { GetChannelsHandler } from './queries/get-channels.handler';
import { GetChannelHandler } from './queries/get-channel.handler';

// Resolvers
import { ChannelResolver, ChannelMemberResolver } from './resolvers/channel.resolver';

// Service
import { ChannelService } from './services/channel.service';
import { TenantUserAdmissionService } from './services/tenant-user-admission.service';
import { PrincipalModule } from '../principal/principal.module';

// Cross-module services needed for field resolvers
import { PresenceModule } from '../presence/presence.module';

const commandHandlers = [
  CreateChannelHandler,
  AddMemberHandler,
  RemoveMemberHandler,
  UpdateChannelHandler,
  ArchiveChannelHandler,
];

const queryHandlers = [
  GetChannelsHandler,
  GetChannelHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Channel, ChannelMember, Message]),
    CqrsModule,
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        transport: Transport.NATS,
        options: buildNatsTransportOptions('messaging-service'),
      },
    ]),
    forwardRef(() => PresenceModule),
    PrincipalModule,
  ],
  providers: [
    ...commandHandlers,
    ...queryHandlers,
    ChannelResolver,
    ChannelMemberResolver,
    ChannelService,
    TenantUserAdmissionService,
  ],
  exports: [ChannelService, TenantUserAdmissionService, PrincipalModule, TypeOrmModule],
})
export class ChannelModule {}
