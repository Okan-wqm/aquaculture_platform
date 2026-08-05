/**
 * Sentinel Hub Module
 *
 * The tenant runtime reads provider credentials from config-service only. The
 * legacy tenant entity remains registered solely for the one-shot cutover.
 */
import { MarineProviderCredentialClientModule } from '@aquaculture/backend-common/config-client';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SentinelHubSettings } from './entities/sentinel-hub-settings.entity';
import { MarineProviderCredentialsService } from './marine-provider-credentials.service';
import { SentinelCredentialCutoverService } from './sentinel-credential-cutover.service';
import { SentinelHubProxyController } from './sentinel-hub-proxy.controller';
import { SentinelHubService } from './sentinel-hub.service';

@Module({
  imports: [
    ConfigModule,
    MarineProviderCredentialClientModule.forFarmService(),
    TypeOrmModule.forFeature([SentinelHubSettings]),
  ],
  controllers: [SentinelHubProxyController],
  providers: [
    SentinelHubService,
    MarineProviderCredentialsService,
    SentinelCredentialCutoverService,
  ],
  exports: [SentinelHubService],
})
export class SentinelHubModule {}
