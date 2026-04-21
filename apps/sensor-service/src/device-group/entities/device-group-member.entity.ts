import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { DeviceGroup } from './device-group.entity';

export enum DeviceMemberType {
  SENSOR = 'sensor',
  EDGE_DEVICE = 'edge_device',
  VFD_DEVICE = 'vfd_device',
  PLC_CONNECTION = 'plc_connection',
}

registerEnumType(DeviceMemberType, {
  name: 'DeviceMemberType',
  description: 'Type of device that can be a group member',
});

@ObjectType()
@Entity('device_group_members', { schema: 'sensor' })
@Unique(['groupId', 'deviceType', 'deviceId'])
@Index(['groupId'])
@Index(['deviceType', 'deviceId'])
export class DeviceGroupMember {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'group_id', type: 'uuid' })
  groupId!: string;

  @Field(() => DeviceGroup)
  @ManyToOne(() => DeviceGroup, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'group_id' })
  group!: DeviceGroup;

  @Field(() => DeviceMemberType)
  @Column({ name: 'device_type', type: 'varchar', length: 50 })
  deviceType!: DeviceMemberType;

  @Field()
  @Column({ name: 'device_id', type: 'uuid' })
  deviceId!: string;

  @Field()
  @CreateDateColumn({ name: 'added_at' })
  addedAt!: Date;
}
