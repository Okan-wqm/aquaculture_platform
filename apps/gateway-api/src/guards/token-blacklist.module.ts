import { RedisService } from '@aquaculture/backend-common/redis';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  buildGatewayTokenBlacklistStore,
  TOKEN_BLACKLIST_STORE,
} from './redis-token-blacklist.store';

/**
 * The ONE token-revocation store of the gateway, as a module every consumer
 * imports: the global AuthGuard and JwtMiddleware (root), and WebSocketModule's
 * WsTokenRevalidator, which re-checks live sockets against the same store.
 *
 * WHY a module: the store used to be a provider of AppModule itself, which a
 * child module cannot see — WebSocketModule's factory injected
 * TOKEN_BLACKLIST_STORE and gateway-api could not boot ("Nest can't resolve
 * dependencies of the WsTokenRevalidator (?)… Symbol(TOKEN_BLACKLIST_STORE)",
 * live since a77b0f74f, exposed by the 2026-09-20 outage). RedisService comes
 * from the @Global RedisModule the root registers.
 *
 * Production boot fails if an operator attempts to select the
 * non-distributed development fallback (see buildGatewayTokenBlacklistStore).
 */
@Module({
  providers: [
    {
      provide: TOKEN_BLACKLIST_STORE,
      useFactory: (redisService: RedisService, configService: ConfigService) =>
        buildGatewayTokenBlacklistStore(
          redisService,
          configService.get<string>('NODE_ENV'),
          configService.get<string>('TOKEN_BLACKLIST_USE_REDIS'),
        ),
      inject: [RedisService, ConfigService],
    },
  ],
  exports: [TOKEN_BLACKLIST_STORE],
})
export class GatewayTokenBlacklistModule {}
