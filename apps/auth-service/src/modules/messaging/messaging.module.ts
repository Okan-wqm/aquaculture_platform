import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageThread } from './entities/message-thread.entity';
import { Message } from './entities/message.entity';
import { MessagingService } from './services/messaging.service';
import { MessagingResolver } from './resolvers/messaging.resolver';
import { User } from '../authentication/entities/user.entity';
import { Tenant } from '../tenant/entities/tenant.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([MessageThread, Message, User, Tenant]),
  ],
  providers: [MessagingService, MessagingResolver],
  exports: [MessagingService],
})
export class MessagingModule {}
