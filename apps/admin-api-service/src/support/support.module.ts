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

import { AnnouncementController } from './controllers/announcement.controller';
import { MessagingController } from './controllers/messaging.controller';
import { OnboardingController } from './controllers/onboarding.controller';
import { TicketController } from './controllers/ticket.controller';
import {
  MessageThread,
  Message,
  Announcement,
  AnnouncementAcknowledgment,
  SupportTicket,
  TicketComment,
  OnboardingProgress,
} from './entities/support.entity';

// External Entities (read-only)

// Services
import { AnnouncementService } from './services/announcement.service';
import { MessagingService } from './services/messaging.service';
import { OnboardingService } from './services/onboarding.service';
import { TicketService } from './services/ticket.service';

// Controllers

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MessageThread,
      Message,
      Announcement,
      AnnouncementAcknowledgment,
      SupportTicket,
      TicketComment,
      OnboardingProgress,
      TenantReadOnly,
    ]),
    ScheduleModule.forRoot(),
  ],
  controllers: [
    MessagingController,
    AnnouncementController,
    TicketController,
    OnboardingController,
  ],
  providers: [
    MessagingService,
    AnnouncementService,
    TicketService,
    OnboardingService,
  ],
  exports: [
    MessagingService,
    AnnouncementService,
    TicketService,
    OnboardingService,
  ],
})
export class SupportModule {}
