import {
  ObjectType,
  Field,
  ID,
  registerEnumType,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';

export enum DeviceGroupType {
  CUSTOM = 'custom',
  SITE = 'site',
  DEPARTMENT = 'department',
  SYSTEM = 'system',
  EQUIPMENT_TYPE = 'equipment_type',
}

registerEnumType(DeviceGroupType, {
  name: 'DeviceGroupType',
  description: 'Type of device group',
});

@ObjectType()
@Entity('device_groups', { schema: 'sensor' })
@Index(['tenantId'])
export class DeviceGroup {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => DeviceGroupType)
  @Column({ type: 'varchar', length: 50, default: DeviceGroupType.CUSTOM })
  type!: DeviceGroupType;

  @Field(() => ID, { nullable: true })
  @Column({ name: 'parent_group_id', type: 'uuid', nullable: true })
  parentGroupId?: string;

  @Field(() => DeviceGroup, { nullable: true })
  @ManyToOne(() => DeviceGroup, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'parent_group_id' })
  parentGroup?: DeviceGroup;

  @Field(() => [DeviceGroup], { nullable: true })
  @OneToMany(() => DeviceGroup, group => group.parentGroup)
  childGroups?: DeviceGroup[];

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  // Virtual field for member count
  @Field({ nullable: true })
  memberCount?: number;
}
