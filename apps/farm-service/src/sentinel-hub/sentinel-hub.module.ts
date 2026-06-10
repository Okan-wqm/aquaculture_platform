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

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([SentinelHubSettings]),
  ],
  controllers: [SentinelHubProxyController],
  providers: [SentinelHubService, SentinelHubResolver, SentinelProxyPolicy],
  exports: [SentinelHubService],
})
export class SentinelHubModule {}
