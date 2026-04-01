import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { buildNatsTransportOptions } from '@aquaculture/backend-common';

import { NatsBridgeService } from './nats-bridge.service';
import { SensorReadingsGateway } from './sensor-readings.gateway';
import { DeviceOwnershipService } from './services/device-ownership.service';
import { STLanguageGateway } from './st-language.gateway';
import { STLanguageBridgeService } from './st-language-bridge.service';
import { MessagingGateway } from './messaging.gateway';
import { MessagingNatsBridgeService } from './messaging-nats-bridge.service';

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
  ],
  exports: [SensorReadingsGateway, STLanguageGateway, MessagingGateway],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WebSocketModule {}
