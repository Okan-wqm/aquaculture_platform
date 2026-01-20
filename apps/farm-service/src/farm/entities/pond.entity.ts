import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
// Note: Farm and Batch are referenced via string to avoid circular dependency

/**
 * Water type enum
 */
export enum WaterType {
  FRESHWATER = 'freshwater',
  SALTWATER = 'saltwater',
  BRACKISH = 'brackish',
}

registerEnumType(WaterType, {
  name: 'WaterType',
  description: 'Type of water in the pond',
});

/**
 * Pond status enum
 */
export enum PondStatus {
  ACTIVE = 'active',
  MAINTENANCE = 'maintenance',
  INACTIVE = 'inactive',
  PREPARING = 'preparing',
}

registerEnumType(PondStatus, {
  name: 'PondStatus',
  description: 'Current status of the pond',
});

/**
 * Pond entity - represents a water body within a farm
 */
@ObjectType()
@Entity('ponds')
@Index(['farmId', 'name'], { unique: true })
@Index(['tenantId', 'status'])
export class Pond {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  name: string;

  @Field(() => Float)
  @Column('decimal', { precision: 10, scale: 2 })
  capacity: number; // in cubic meters

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  depth?: number; // in meters

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  surfaceArea?: number; // in square meters

  @Field(() => WaterType)
  @Column({ type: 'enum', enum: WaterType, default: WaterType.FRESHWATER })
  waterType: WaterType;

  @Field(() => PondStatus)
  @Column({ type: 'enum', enum: PondStatus, default: PondStatus.ACTIVE })
  status: PondStatus;

  @Field()
  @Column()
  @Index()
  farmId: string;

  @ManyToOne('Farm', 'ponds', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'farmId' })
  farm: any;

  // Note: batches relation available via TypeORM but not exposed in GraphQL
  // Use pond.batches query in resolver instead to avoid circular type issues
  @OneToMany('Batch', 'pond')
  batches?: any[];

  @Field()
  @Column()
  @Index()
  tenantId: string;

  @Field()
  @Column({ default: true })
  isActive: boolean;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  createdBy?: string;
}
