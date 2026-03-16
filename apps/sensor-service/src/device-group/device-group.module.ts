import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceGroup } from './entities/device-group.entity';
import { DeviceGroupMember } from './entities/device-group-member.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { DeviceGroupService } from './services/device-group.service';
import { DeviceGroupResolver } from './resolvers/device-group.resolver';

@Module({
  imports: [TypeOrmModule.forFeature([DeviceGroup, DeviceGroupMember, Sensor])],
  providers: [DeviceGroupService, DeviceGroupResolver],
  exports: [DeviceGroupService],
})
export class DeviceGroupModule {}
