import { CircuitBreakerModule } from '@aquaculture/backend-common/resilience';
import { Module } from '@nestjs/common';

import { FarmStreamingResponseAdapter } from '../common/http/farm-streaming-response.adapter';
import { MarineExplorerFeatureGate } from './marine-explorer-feature-gate.service';

/**
 * Phase-1 platform prerequisites only. No entity, provider adapter, controller,
 * event consumer, or worker execution is registered here.
 */
@Module({
  imports: [CircuitBreakerModule],
  providers: [MarineExplorerFeatureGate, FarmStreamingResponseAdapter],
  exports: [MarineExplorerFeatureGate, FarmStreamingResponseAdapter],
})
export class MarineExplorerPlatformModule {}
