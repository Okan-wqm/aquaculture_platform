/**
 * Sentinel Hub Module
 *
 * Manages per-tenant Sentinel Hub credential storage and satellite imagery access.
 * Provides both GraphQL API (for configuration management) and REST proxy
 * endpoints (for server-side token injection on satellite tile requests).
 *
 * SEC-C14: The SentinelHubProxyController proxies all Sentinel Hub API calls
 * through the backend, ensuring OAuth tokens never reach the browser.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SentinelHubSettings } from './entities/sentinel-hub-settings.entity';
import { SentinelHubService } from './sentinel-hub.service';
import { SentinelHubResolver } from './sentinel-hub.resolver';
import { SentinelHubProxyController } from './sentinel-hub-proxy.controller';
import { SentinelProxyPolicy } from './sentinel-proxy.policy';
// Read query handlers (fail-closed tenant boundary — FARM-HIGH-060)
import { GetSentinelHubStatusHandler } from './handlers/get-sentinel-hub-status.handler';
import { GetSentinelHubCredentialsHandler } from './handlers/get-sentinel-hub-credentials.handler';
import { IsSentinelHubConfiguredHandler } from './handlers/is-sentinel-hub-configured.handler';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([SentinelHubSettings]),
  ],
  controllers: [SentinelHubProxyController],
  providers: [
    SentinelHubService,
    SentinelHubResolver,
    SentinelProxyPolicy,
    GetSentinelHubStatusHandler,
    GetSentinelHubCredentialsHandler,
    IsSentinelHubConfiguredHandler,
  ],
  // SentinelProxyPolicy is exported because MarineDataModule imports this module
  // and MarineDataService constructor-injects it. Providing it without exporting
  // it left the policy private to this module, crash-looping farm-service boot
  // ("Nest can't resolve dependencies of MarineDataService ... SentinelProxyPolicy").
  exports: [SentinelHubService, SentinelProxyPolicy],
})
export class SentinelHubModule {}
