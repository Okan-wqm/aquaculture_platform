/**
 * @module PresenceModule
 * @description Real-time user presence tracking backed by Redis.
 * Exports the shared REDIS_CLIENT provider for use by other modules.
 * @see ADR-012 section 5 (Presence)
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { redisProvider, redisDisconnectProvider } from '../shared/redis.provider';
import { PresenceService } from './presence.service';

@Module({
  imports: [ConfigModule],
  providers: [redisProvider, redisDisconnectProvider, PresenceService],
  exports: [PresenceService, redisProvider],
})
export class PresenceModule {}
