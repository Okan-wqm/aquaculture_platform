import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../authentication/entities/user.entity';
import { Tenant } from '../tenant/entities/tenant.entity';

import { SupportTicket } from './entities/support-ticket.entity';
import { TicketComment } from './entities/ticket-comment.entity';
import { SupportResolver } from './resolvers/support.resolver';
import { SupportService } from './services/support.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([SupportTicket, TicketComment, User, Tenant]),
  ],
  providers: [SupportService, SupportResolver],
  exports: [SupportService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class SupportModule {}
