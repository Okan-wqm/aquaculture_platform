import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { Sensor } from '../database/entities/sensor.entity';

import { ChannelResolver } from './resolvers/channel.resolver';
import { RegistrationResolver } from './resolvers/registration.resolver';
import { ChannelDiscoveryService } from './services/channel-discovery.service';
import { ChannelManagementService } from './services/channel-management.service';
import { SensorRegistrationService } from './services/sensor-registration.service';

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
