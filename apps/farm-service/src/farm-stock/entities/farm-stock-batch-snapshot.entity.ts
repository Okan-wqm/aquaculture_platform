import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { Directive, Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@ObjectType()
@Directive('@key(fields: "id")')
@Entity('farm_stock_batch_snapshots')
@Index(['tenantId', 'containerId', 'batchId'], { unique: true })
@Index(['tenantId', 'batchId'])
@Index(['tenantId', 'containerId'])
export class FarmStockBatchSnapshot {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field(() => ID)
  @Column('uuid')
  tenantId!: string;

  @Field(() => ID)
  @Column('uuid')
  containerId!: string;

  @Field(() => ID)
  @Column('uuid')
  batchId!: string;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  batchNumber?: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 80, nullable: true })
  batchStatus?: string | null;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  quantity!: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0, transformer: new DecimalTransformer() })
  biomassKg!: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0, transformer: new DecimalTransformer() })
  avgWeightG!: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  densityKgM3?: number | null;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  totalMortality!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  totalCull!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  harvestedQuantity!: number;

  @Field()
  @Column({ default: true })
  isPrimary!: boolean;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastMortalityAt?: Date | null;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
