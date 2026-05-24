import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Directive, Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

export enum FarmStockContainerSource {
  TANK = 'TANK',
  EQUIPMENT = 'EQUIPMENT',
}

registerEnumType(FarmStockContainerSource, {
  name: 'FarmStockContainerSource',
});

@ObjectType()
@Directive('@key(fields: "id")')
@Entity('farm_stock_container_snapshots')
@Index(['tenantId', 'containerId'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'departmentId'])
@Index(['tenantId', 'siteId'])
@Index(['tenantId', 'hasActiveBatch'])
export class FarmStockContainerSnapshot {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field(() => ID)
  @Column('uuid')
  tenantId!: string;

  @Field(() => ID)
  @Column('uuid')
  containerId!: string;

  @Field(() => FarmStockContainerSource)
  @Column({ type: 'varchar', length: 20 })
  containerSource!: FarmStockContainerSource;

  @Field()
  @Column({ length: 255 })
  name!: string;

  @Field()
  @Column({ length: 50 })
  code!: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', nullable: true })
  departmentId?: string | null;

  @Field({ nullable: true })
  @Column({ type: 'uuid', nullable: true })
  siteId?: string | null;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 80, nullable: true })
  status?: string | null;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  volume?: number | null;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  maxBiomassKg?: number | null;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  currentQuantity?: number | null;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  currentBiomassKg?: number | null;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  capacityUsedPercent?: number | null;

  @Field()
  @Column({ default: false })
  isOverCapacity!: boolean;

  @Field()
  @Column({ default: false })
  hasActiveBatch!: boolean;

  @Field()
  @Column({ default: true })
  isActive!: boolean;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastStockEventAt?: Date | null;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
