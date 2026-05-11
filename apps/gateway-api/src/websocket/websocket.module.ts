import { buildNatsTransportOptions } from '@aquaculture/backend-common/nats';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { FarmNatsBridgeService } from './farm-nats-bridge.service';
import { FarmGateway } from './farm.gateway';
import { MessagingNatsBridgeService } from './messaging-nats-bridge.service';
import { MessagingGateway } from './messaging.gateway';
import { NatsBridgeService } from './nats-bridge.service';
import { SensorReadingsGateway } from './sensor-readings.gateway';
import { DeviceOwnershipService } from './services/device-ownership.service';
import { STLanguageBridgeService } from './st-language-bridge.service';
import { STLanguageGateway } from './st-language.gateway';

@Module({
  imports: [
    ConfigModule,
    JwtModule,
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        transport: Transport.NATS,
        /** SEC-H01: Use shared factory for NATS auth credentials. */
        options: buildNatsTransportOptions('gateway-api-websocket'),
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
  ],
  exports: [
    SensorReadingsGateway,
    STLanguageGateway,
    MessagingGateway,
    FarmGateway,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WebSocketModule {}
