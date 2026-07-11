import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceGroup } from './entities/device-group.entity';
import { DeviceGroupMember } from './entities/device-group-member.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { EdgeDevice } from '../edge-device/entities/edge-device.entity';
import { VfdDevice } from '../vfd/entities/vfd-device.entity';
import { DeviceGroupService } from './services/device-group.service';
import { DeviceGroupResolver } from './resolvers/device-group.resolver';

@Module({
  // SENSOR-MEDIUM-007: EdgeDevice + VfdDevice repos are needed to verify that
  // each group member's deviceId belongs to the caller's tenant before insert.
  imports: [TypeOrmModule.forFeature([DeviceGroup, DeviceGroupMember, Sensor, EdgeDevice, VfdDevice])],
  providers: [DeviceGroupService, DeviceGroupResolver],
  exports: [DeviceGroupService],
})
export class DeviceGroupModule {}
