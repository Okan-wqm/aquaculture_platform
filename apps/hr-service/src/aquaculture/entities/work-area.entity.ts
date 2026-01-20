import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Int, Float, registerEnumType } from '@nestjs/graphql';

export enum WorkAreaType {
  SHORE_FACILITY = 'shore_facility',
  SEA_CAGE = 'sea_cage',
  FLOATING_PLATFORM = 'floating_platform',
  VESSEL = 'vessel',
  FEED_BARGE = 'feed_barge',
  PROCESSING_PLANT = 'processing_plant',
  HATCHERY = 'hatchery',
  WAREHOUSE = 'warehouse',
  OFFICE = 'office',
  LABORATORY = 'laboratory',
}

export enum WorkAreaRiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

registerEnumType(WorkAreaType, { name: 'WorkAreaType' });
registerEnumType(WorkAreaRiskLevel, { name: 'WorkAreaRiskLevel' });

@ObjectType()
export class GeoCoordinates {
  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;
}

@ObjectType()
@Entity('work_areas', { schema: 'hr' })
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'workAreaType'])
@Index(['tenantId', 'siteId'])
@Index(['tenantId', 'isActive'])
export class WorkArea {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column({ length: 30 })
  code!: string;

  @Field()
  @Column({ length: 150 })
  name!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => WorkAreaType)
  @Column({ type: 'enum', enum: WorkAreaType })
  workAreaType!: WorkAreaType;

  @Field(() => WorkAreaRiskLevel)
  @Column({ type: 'enum', enum: WorkAreaRiskLevel, default: WorkAreaRiskLevel.LOW })
  riskLevel!: WorkAreaRiskLevel;

  @Field({ nullable: true })
  @Column({ nullable: true })
  siteId?: string; // Reference to site from farm module

  @Field(() => GeoCoordinates, { nullable: true })
  @Column('jsonb', { nullable: true })
  coordinates?: GeoCoordinates;

  @Field()
  @Column({ default: false })
  isOffshore!: boolean;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  maxCapacity?: number; // Max personnel allowed

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  requiredCertifications?: string[]; // Cert type IDs

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  requiredPPE?: string[]; // Personal Protective Equipment

  @Field()
  @Column({ default: false })
  requiresDivingCertification!: boolean;

  @Field()
  @Column({ default: false })
  requiresVesselCertification!: boolean;

  @Field()
  @Column({ default: false })
  requiresSeaWorthy!: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  emergencyContact?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  emergencyProcedure?: string;

  @Field({ nullable: true })
  @Column({ length: 7, nullable: true })
  colorCode?: string;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  displayOrder!: number;

  @Field()
  @Column({ default: true })
  isActive!: boolean;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;

  @Field()
  @Column({ default: false })
  isDeleted!: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedBy?: string;
}
