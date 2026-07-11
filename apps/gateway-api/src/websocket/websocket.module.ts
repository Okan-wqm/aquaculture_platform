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
  exports: [
    SensorReadingsGateway,
    STLanguageGateway,
    MessagingGateway,
    FarmGateway,
    AiChatGateway,
  ],
})
 
export class WebSocketModule {}
