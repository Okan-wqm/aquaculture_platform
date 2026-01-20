import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Sensor } from '../database/entities/sensor.entity';
import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { SensorRegistrationService } from './services/sensor-registration.service';
import { ChannelDiscoveryService } from './services/channel-discovery.service';
import { ChannelManagementService } from './services/channel-management.service';
import { RegistrationResolver } from './resolvers/registration.resolver';
import { ChannelResolver } from './resolvers/channel.resolver';

@Module({
  imports: [
    TypeOrmModule.forFeature([Sensor, SensorDataChannel]),
    EventEmitterModule.forRoot(),
  ],
  providers: [
    SensorRegistrationService,
    ChannelDiscoveryService,
    ChannelManagementService,
    RegistrationResolver,
    ChannelResolver,
  ],
  exports: [SensorRegistrationService, ChannelDiscoveryService, ChannelManagementService],
})
export class RegistrationModule {}
