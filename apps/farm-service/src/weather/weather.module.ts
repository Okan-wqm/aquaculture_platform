/**
 * Weather Module
 * Canonical tenant environmental monitoring.
 */
import { CircuitBreakerModule } from '@aquaculture/backend-common/resilience';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SentinelHubModule } from '../sentinel-hub/sentinel-hub.module';
import { Site } from '../site/entities/site.entity';
import { MarineObservation } from './entities/marine-observation.entity';
import { EnvironmentMetricSyncOutcome } from './entities/environment-metric-sync-outcome.entity';
import { SatelliteSceneCoverageAssessment } from './entities/satellite-scene-coverage-assessment.entity';
import { SatelliteSceneObservation } from './entities/satellite-scene-observation.entity';
import { SiteEnvironmentSyncState } from './entities/site-environment-sync-state.entity';
import { WeatherObservation } from './entities/weather-observation.entity';
// Frozen persistence metadata only; no provider, resolver, reader, or writer consumes it.
import { WeatherSettings } from './entities/weather-settings.entity';
import { EnvironmentResolver } from './environment.resolver';
import { CdseSentinelProvider } from './services/cdse-sentinel.provider';
import { CmemsDatasetRegistry, CmemsHttpClient } from './services/cmems-provider';
import { CmemsRegionalService } from './services/cmems-regional.service';
import { EnvironmentCronService } from './services/environment-cron.service';
import { EnvironmentIngestionService } from './services/environment-ingestion.service';
import { EnvironmentMonitoringGate } from './services/environment-monitoring-gate.service';
import { EnvironmentProviderConfigurationService } from './services/environment-provider-configuration.service';
import { EnvironmentReadService } from './services/environment-read.service';
import { EnvironmentSyncStore } from './services/environment-sync-store.service';
import { FrostObservationsService } from './services/frost-observations.service';
import { MetLocationForecastService } from './services/met-locationforecast.service';
import { MET_NORWAY_PROVIDER_CONFIG } from './services/met-norway-provider';

@Module({
  imports: [
    CircuitBreakerModule,
    SentinelHubModule,
    TypeOrmModule.forFeature([
      WeatherObservation,
      MarineObservation,
      EnvironmentMetricSyncOutcome,
      WeatherSettings,
      Site,
      SatelliteSceneObservation,
      SatelliteSceneCoverageAssessment,
      SiteEnvironmentSyncState,
    ]),
  ],
  providers: [
    EnvironmentResolver,
    EnvironmentReadService,
    EnvironmentMonitoringGate,
    EnvironmentProviderConfigurationService,
    {
      provide: MET_NORWAY_PROVIDER_CONFIG,
      inject: [EnvironmentProviderConfigurationService],
      useFactory: (configuration: EnvironmentProviderConfigurationService) =>
        configuration.metNorwayProviderConfig(),
    },
    MetLocationForecastService,
    FrostObservationsService,
    CmemsHttpClient,
    CmemsDatasetRegistry,
    CmemsRegionalService,
    CdseSentinelProvider,
    EnvironmentSyncStore,
    EnvironmentIngestionService,
    EnvironmentCronService,
    SiteAuthorizationService,
  ],
  exports: [EnvironmentReadService, EnvironmentMonitoringGate, CdseSentinelProvider],
})
export class WeatherModule {}
