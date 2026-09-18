import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule } from '@nestjs/microservices';
import { NatsV3Client } from '@aquaculture/backend-common/nats';

import { NatsBridgeService } from './nats-bridge.service';
import { SensorReadingsGateway } from './sensor-readings.gateway';
import { DeviceOwnershipService } from './services/device-ownership.service';
import { STLanguageGateway } from './st-language.gateway';
import { STLanguageBridgeService } from './st-language-bridge.service';
import { MessagingGateway } from './messaging.gateway';
import { MessagingNatsBridgeService } from './messaging-nats-bridge.service';
import { FarmGateway } from './farm.gateway';
import { FarmNatsBridgeService } from './farm-nats-bridge.service';
import { AiChatGateway } from './ai-chat.gateway';
import { TenantConnectionLimiter, WsTokenRevalidator } from '@aquaculture/backend-common/websocket';
import { TOKEN_BLACKLIST_STORE, TokenBlacklistStore } from '../guards/redis-token-blacklist.store';

@Module({
  imports: [
    ConfigModule,
    JwtModule,
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        customClass: NatsV3Client,
        /** SEC-H01: Use shared factory for NATS auth credentials. */
        options: { serviceName: 'gateway-api-websocket' },
      },
    ]),
  ],
  providers: [
    DeviceOwnershipService,
    // SEC-MEDIUM-073/082 (2026-08-23 scan №26/№18): shared socket guards —
    // per-tenant connection ceiling + periodic jti/user-epoch revalidation.
    {
      provide: TenantConnectionLimiter,
      useClass: TenantConnectionLimiter,
    },
    {
      provide: WsTokenRevalidator,
      useFactory: (blacklist: Pick<TokenBlacklistStore, 'isValidToken'>) =>
        new WsTokenRevalidator({
          intervalMs: 60_000,
          isStillValid: ({ jti, userId, issuedAt }) =>
            blacklist.isValidToken(jti, userId, issuedAt ?? 0),
        }),
      inject: [TOKEN_BLACKLIST_STORE],
    },
    SensorReadingsGateway,
    NatsBridgeService,
    STLanguageGateway,
    STLanguageBridgeService,
    MessagingGateway,
    MessagingNatsBridgeService,
    // Phase B — farm domain real-time bridge: subscribes to NATS subjects
    // `events.*.{BatchCreated,MortalityRecorded,CullRecorded,...}` and
    // forwards to FarmGateway → tenant-scoped Socket.IO rooms.
    FarmGateway,
    FarmNatsBridgeService,
    // AI assistant real-time gateway (/ai namespace) — forwards ai:chat over
    // NATS request.ai.chat to ai-service, replacing the hand-rolled REST proxy.
    AiChatGateway,
  ],
  exports: [SensorReadingsGateway, STLanguageGateway, MessagingGateway, FarmGateway, AiChatGateway],
})
export class WebSocketModule {}
