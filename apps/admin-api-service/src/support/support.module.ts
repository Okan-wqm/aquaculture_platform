/**
 * Support Module
 *
 * Onboarding yönetimi.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { TenantReadOnly } from '../analytics/entities/external/tenant.entity';

import { OnboardingController } from './controllers/onboarding.controller';
import {
  OnboardingProgress,
} from './entities/support.entity';

// External Entities (read-only)

// Services
import { OnboardingService } from './services/onboarding.service';

// Controllers

// APA-201: the Announcement vertical (controller + service + entities) has been
// removed from this module. Announcements are owned by auth-service
// (auth.announcements) and served via GraphQL; the admin.announcements duplicate
// store is dropped by 1801700000000-MigrateAnnouncementsToAuth.
//
// APA-213 (tickets slice): the Support Ticket vertical (TicketController +
// TicketService + SupportTicket/TicketComment entities) was removed. Support
// tickets are owned by auth-service (auth.support_tickets / auth.ticket_comments)
// and served via GraphQL; the admin duplicate store is dropped by
// 1801800000000-MigrateSupportTicketsToAuth.
//
// APA-213 (messaging slice): the support-Messaging vertical (MessagingController +
// MessagingService + MessageThread/Message entities) has likewise been removed.
// Support messaging is owned by auth-service (auth.message_threads / auth.messages)
// and served via GraphQL; the admin duplicate store is dropped by
// 1801900000000-MigrateSupportMessagingToAuth. Onboarding remains admin-owned.

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OnboardingProgress,
      TenantReadOnly,
    ]),
  ],
  controllers: [
    OnboardingController,
  ],
  providers: [
    OnboardingService,
  ],
  exports: [
    OnboardingService,
  ],
})
export class SupportModule {}
