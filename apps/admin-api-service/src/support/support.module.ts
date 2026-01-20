/**
 * Support Module
 *
 * Messaging, announcements, tickets ve onboarding yönetimi.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

// Entities
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
import { TenantReadOnly } from '../analytics/entities/external/tenant.entity';

// Services
import { MessagingService } from './services/messaging.service';
import { AnnouncementService } from './services/announcement.service';
import { TicketService } from './services/ticket.service';
import { OnboardingService } from './services/onboarding.service';

// Controllers
import { MessagingController } from './controllers/messaging.controller';
import { AnnouncementController } from './controllers/announcement.controller';
import { TicketController } from './controllers/ticket.controller';
import { OnboardingController } from './controllers/onboarding.controller';

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
