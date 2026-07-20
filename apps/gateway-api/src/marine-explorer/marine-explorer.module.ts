import { CircuitBreakerModule } from '@aquaculture/backend-common/resilience';
import { Module } from '@nestjs/common';

import { SignedStreamingProxyService } from '../proxy/signed-streaming-proxy.service';
import { MarineExplorerCapabilityController } from './marine-explorer-capability.controller';
import { MarineExplorerFeatureService } from './marine-explorer-feature.service';

@Module({
  imports: [CircuitBreakerModule],
  controllers: [MarineExplorerCapabilityController],
  providers: [MarineExplorerFeatureService, SignedStreamingProxyService],
  exports: [MarineExplorerFeatureService, SignedStreamingProxyService],
})
export class MarineExplorerModule {}
