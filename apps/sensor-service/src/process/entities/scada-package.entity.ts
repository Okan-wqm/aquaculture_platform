import {
  ObjectType,
  Field,
  ID,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * SCADA package status enum
 */
export enum ScadaPackageStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  ARCHIVED = 'archived',
}

registerEnumType(ScadaPackageStatus, {
  name: 'ScadaPackageStatus',
  description: 'Status of the SCADA package',
});

/**
 * ScadaPackage entity - stores a full SCADA HMI package (screens, alarms, controls, trends)
 */
@ObjectType()
@Entity('scada_packages')
@Index(['tenantId', 'status'])
export class ScadaPackage {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  name!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => Int)
  @Column({ type: 'int', name: 'version', default: 1 })
  version!: number;

  @Field({ nullable: true })
  @Column({ name: 'process_id', nullable: true })
  processId?: string;

  @Field(() => GraphQLJSON)
  @Column('jsonb', { name: 'package_data', default: '{}' })
  packageData!: Record<string, unknown>;

  @Field(() => ScadaPackageStatus)
  @Column({ type: 'enum', enum: ScadaPackageStatus, default: ScadaPackageStatus.DRAFT })
  status!: ScadaPackageStatus;

  @Field({ nullable: true })
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ name: 'updated_by', nullable: true })
  updatedBy?: string;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
