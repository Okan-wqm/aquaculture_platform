import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  Int,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
// Note: Pond is referenced via string to avoid circular dependency

/**
 * Batch status enum for pond batches
 * Note: Named PondBatchStatus in GraphQL to avoid conflict with batch module's BatchStatus
 */
export enum BatchStatus {
  ACTIVE = 'active',
  HARVESTED = 'harvested',
  FAILED = 'failed',
  TRANSFERRED = 'transferred',
}

registerEnumType(BatchStatus, {
  name: 'PondBatchStatus',
  description: 'Current status of a pond batch',
});

/**
 * PondBatch entity - represents a group of aquatic species in a pond
 * Note: This is the legacy batch entity for pond-based aquaculture.
 * For tank-based RAS systems, use the Batch entity from batch/entities/batch.entity.ts
 */
@ObjectType('PondBatch')
@Entity('batches')
@Index(['pondId', 'status'])
@Index(['tenantId', 'species'])
@Index(['tenantId', 'stockedAt'])
export class PondBatch {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  name: string;

  @Field()
  @Column()
  @Index()
  species: string; // e.g., "Shrimp", "Salmon", "Tilapia"

  @Field({ nullable: true })
  @Column({ nullable: true })
  strain?: string; // specific variety/strain

  @Field(() => Int)
  @Column('int')
  quantity: number; // initial stock count

  @Field(() => Int, { nullable: true })
  @Column('int', { nullable: true })
  currentQuantity?: number; // estimated current count

  @Field(() => Int, { nullable: true })
  @Column('int', { nullable: true })
  harvestedQuantity?: number;

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  averageWeight?: number; // in grams

  @Field(() => Float, { nullable: true })
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  harvestedWeight?: number; // total harvested weight in kg

  @Field()
  @Column({ type: 'date' })
  stockedAt: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  expectedHarvestDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  harvestedAt?: Date;

  @Field()
  @Column()
  @Index()
  pondId: string;

  // Note: Using string reference to avoid circular dependency
  @ManyToOne('Pond', 'batches', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pondId' })
  pond: any;

  @Field(() => BatchStatus)
  @Column({ type: 'enum', enum: BatchStatus, default: BatchStatus.ACTIVE })
  status: BatchStatus;

  @Field()
  @Column()
  @Index()
  tenantId: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  updatedBy?: string;
}
