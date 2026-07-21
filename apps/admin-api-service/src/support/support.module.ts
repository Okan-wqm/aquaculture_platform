/**
 * Support Module
 *
 * Messaging, announcements, tickets ve onboarding yönetimi.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { TenantReadOnly } from '../analytics/entities/external/tenant.entity';

import { MessagingController } from './controllers/messaging.controller';
import { OnboardingController } from './controllers/onboarding.controller';
import {
  MessageThread,
  Message,
  OnboardingProgress,
} from './entities/support.entity';

// External Entities (read-only)

// Services
import { MessagingService } from './services/messaging.service';
import { OnboardingService } from './services/onboarding.service';

// Controllers

// APA-201: the Announcement vertical (controller + service + entities) has been
// removed from this module. Announcements are owned by auth-service
// (auth.announcements) and served via GraphQL; the admin.announcements duplicate
// store is dropped by 1801700000000-MigrateAnnouncementsToAuth.
//
// APA-213: the Support Ticket vertical (TicketController + TicketService +
// SupportTicket/TicketComment entities) has likewise been removed. Support
// tickets are owned by auth-service (auth.support_tickets / auth.ticket_comments)
// and served via GraphQL; the admin duplicate store is dropped by
// 1801800000000-MigrateSupportTicketsToAuth.

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MessageThread,
      Message,
      OnboardingProgress,
      TenantReadOnly,
    ]),
  ],
  controllers: [
    MessagingController,
    OnboardingController,
  ],
  providers: [
    MessagingService,
    OnboardingService,
  ],
  exports: [
    MessagingService,
    OnboardingService,
  ],
})
export class SupportModule {}
