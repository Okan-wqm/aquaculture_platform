/**
 * Support Module
 *
 * Messaging, announcements, tickets ve onboarding yönetimi.
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { TenantReadOnly } from '../analytics/entities/external/tenant.entity';

import { MessagingController } from './controllers/messaging.controller';
import { OnboardingController } from './controllers/onboarding.controller';
import { TicketController } from './controllers/ticket.controller';
import {
  MessageThread,
  Message,
  SupportTicket,
  TicketComment,
  OnboardingProgress,
} from './entities/support.entity';

// External Entities (read-only)

// Services
import { MessagingService } from './services/messaging.service';
import { OnboardingService } from './services/onboarding.service';
import { TicketService } from './services/ticket.service';

// Controllers

// APA-201: the Announcement vertical (controller + service + entities) has been
// removed from this module. Announcements are owned by auth-service
// (auth.announcements) and served via GraphQL; the admin.announcements duplicate
// store is dropped by 1801700000000-MigrateAnnouncementsToAuth.

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MessageThread,
      Message,
      SupportTicket,
      TicketComment,
      OnboardingProgress,
      TenantReadOnly,
    ]),
    ScheduleModule,
  ],
  controllers: [
    MessagingController,
    TicketController,
    OnboardingController,
  ],
  providers: [
    MessagingService,
    TicketService,
    OnboardingService,
  ],
  exports: [
    MessagingService,
    TicketService,
    OnboardingService,
  ],
})
export class SupportModule {}
