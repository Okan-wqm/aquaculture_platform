import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { SensorReadingsGateway } from './sensor-readings.gateway';
import { NatsBridgeService } from './nats-bridge.service';

@Module({
  imports: [ConfigModule, JwtModule],
  providers: [SensorReadingsGateway, NatsBridgeService],
  exports: [SensorReadingsGateway],
})
export class WebSocketModule {}
