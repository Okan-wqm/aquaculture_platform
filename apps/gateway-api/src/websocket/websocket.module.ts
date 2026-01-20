import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { NatsBridgeService } from './nats-bridge.service';
import { SensorReadingsGateway } from './sensor-readings.gateway';

@Module({
  imports: [ConfigModule, JwtModule],
  providers: [SensorReadingsGateway, NatsBridgeService],
  exports: [SensorReadingsGateway],
})
export class WebSocketModule {}
