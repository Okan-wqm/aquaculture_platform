import { Module } from '@nestjs/common';

import { SentinelHubModule } from '../sentinel-hub/sentinel-hub.module';

import { MarineCachePolicy } from './marine-cache.policy';
import { MarineDataController } from './marine-data.controller';
import { MarineDataService } from './marine-data.service';

@Module({
  imports: [SentinelHubModule],
  controllers: [MarineDataController],
  providers: [MarineDataService, MarineCachePolicy],
  exports: [MarineDataService, MarineCachePolicy],
})
export class MarineDataModule {}
