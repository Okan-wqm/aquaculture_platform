import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../authentication/entities/user.entity';
import { Tenant } from '../tenant/entities/tenant.entity';

import { MessageThread } from './entities/message-thread.entity';
import { Message } from './entities/message.entity';
import { MessagingResolver } from './resolvers/messaging.resolver';
import { MessagingService } from './services/messaging.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([MessageThread, Message, User, Tenant]),
  ],
  providers: [MessagingService, MessagingResolver],
  exports: [MessagingService],
})
export class MessagingModule {}
