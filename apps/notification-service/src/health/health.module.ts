import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [NotificationModule],
  controllers: [HealthController],
})
export class HealthModule {}
