import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { NatsBridgeService } from './nats-bridge.service';
import { SensorReadingsGateway } from './sensor-readings.gateway';
import { STLanguageGateway } from './st-language.gateway';
import { STLanguageBridgeService } from './st-language-bridge.service';

@Module({
  imports: [ConfigModule, JwtModule],
  providers: [
    SensorReadingsGateway,
    NatsBridgeService,
    STLanguageGateway,
    STLanguageBridgeService,
  ],
  exports: [SensorReadingsGateway, STLanguageGateway],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WebSocketModule {}
