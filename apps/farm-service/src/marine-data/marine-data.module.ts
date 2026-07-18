import { Module } from '@nestjs/common';

import { CircuitBreakerModule } from '@aquaculture/backend-common/resilience';

import { SentinelHubModule } from '../sentinel-hub/sentinel-hub.module';

import { MarineCachePolicy } from './marine-cache.policy';
import { MarineDataController } from './marine-data.controller';
import { MarineDataService } from './marine-data.service';
import { MarineUpstreamClient } from './providers/marine-upstream.client';

@Module({
  imports: [SentinelHubModule, CircuitBreakerModule],
  controllers: [MarineDataController],
  providers: [MarineDataService, MarineCachePolicy, MarineUpstreamClient],
  exports: [MarineDataService, MarineCachePolicy],
})
export class MarineDataModule {}
