import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Announcement } from './entities/announcement.entity';
import { AnnouncementAcknowledgment } from './entities/announcement-acknowledgment.entity';
import { AnnouncementService } from './services/announcement.service';
import { AnnouncementResolver } from './resolvers/announcement.resolver';
import { User } from '../authentication/entities/user.entity';
import { Tenant } from '../tenant/entities/tenant.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Announcement,
      AnnouncementAcknowledgment,
      User,
      Tenant,
    ]),
  ],
  providers: [AnnouncementService, AnnouncementResolver],
  exports: [AnnouncementService],
})
export class AnnouncementModule {}
