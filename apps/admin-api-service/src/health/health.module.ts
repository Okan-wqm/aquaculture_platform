import { Module, OnApplicationBootstrap } from '@nestjs/common';

import { SettingsModule } from '../settings/settings.module';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [SettingsModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule implements OnApplicationBootstrap {
  constructor(private readonly healthService: HealthService) {}

  onApplicationBootstrap(): void {
    this.healthService.markStartupComplete();
  }
}
