import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { SensorTypeModule } from '../sensor-type/sensor-type.module';

import { ChannelResolver } from './resolvers/channel.resolver';
import { RegistrationResolver } from './resolvers/registration.resolver';
import { ChannelDiscoveryService } from './services/channel-discovery.service';
import { ChannelManagementService } from './services/channel-management.service';
import { SensorRegistrationService } from './services/sensor-registration.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Sensor, SensorDataChannel]),
    // SENSOR-MEDIUM-071: registerSensor bootstraps a custom type-definition's
    // channels via SensorTypeService inside the registration transaction.
    SensorTypeModule,
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
