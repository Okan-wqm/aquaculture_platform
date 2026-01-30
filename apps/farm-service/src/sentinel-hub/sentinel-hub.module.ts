/**
 * Sentinel Hub Module
 *
 * Tenant bazlı Sentinel Hub kimlik yönetimi modülü.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SentinelHubSettings } from './entities/sentinel-hub-settings.entity';
import { SentinelHubService } from './sentinel-hub.service';
import { SentinelHubResolver } from './sentinel-hub.resolver';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([SentinelHubSettings]),
  ],
  providers: [SentinelHubService, SentinelHubResolver],
  exports: [SentinelHubService],
})
export class SentinelHubModule {}
