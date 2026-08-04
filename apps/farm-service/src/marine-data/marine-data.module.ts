import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Module } from '@nestjs/common';

import { WeatherModule } from '../weather/weather.module';

import { MarineCachePolicy } from './marine-cache.policy';
import { MarineDataController } from './marine-data.controller';
import { MarineDataService } from './marine-data.service';

@Module({
  imports: [WeatherModule],
  controllers: [MarineDataController],
  providers: [MarineDataService, MarineCachePolicy, SiteAuthorizationService],
  exports: [MarineDataService, MarineCachePolicy],
})
export class MarineDataModule {}
