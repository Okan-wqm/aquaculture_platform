import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupportTicket } from './entities/support-ticket.entity';
import { TicketComment } from './entities/ticket-comment.entity';
import { SupportService } from './services/support.service';
import { SupportResolver } from './resolvers/support.resolver';
import { User } from '../authentication/entities/user.entity';
import { Tenant } from '../tenant/entities/tenant.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SupportTicket, TicketComment, User, Tenant]),
  ],
  providers: [SupportService, SupportResolver],
  exports: [SupportService],
})
export class SupportModule {}
