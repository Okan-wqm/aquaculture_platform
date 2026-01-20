/**
 * Sentinel Hub Module
 *
 * Tenant bazlı Sentinel Hub kimlik yönetimi modülü.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SentinelHubSettings } from './entities/sentinel-hub-settings.entity';
import { SentinelHubService } from './sentinel-hub.service';
import { SentinelHubResolver } from './sentinel-hub.resolver';

@Module({
  imports: [TypeOrmModule.forFeature([SentinelHubSettings])],
  providers: [SentinelHubService, SentinelHubResolver],
  exports: [SentinelHubService],
})
export class SentinelHubModule {}
