import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { ObjectType, Field, ID, registerEnumType, Float, Int } from '@nestjs/graphql';
import { BillingCycle, PlanTier, PlanLimits, PlanPricing } from './subscription.entity';

/**
 * Plan Entity
 *
 * Defines subscription plan templates that tenants can subscribe to.
 * Plans are versioned and auditable. Price changes on a plan do NOT
 * affect existing subscriptions — only new subscriptions use the
 * current plan pricing.
 */
@ObjectType()
@Entity('plans')
@Index(['tier'])
@Index(['isActive'])
@Index(['isPublic'])
@Index(['sortOrder'])
@Index(['name'], { unique: true })
export class Plan {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Field(() => PlanTier)
  @Column({ type: 'enum', enum: PlanTier })
  tier!: PlanTier;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2, name: 'base_price' })
  basePrice!: number;

  @Field()
  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency!: string;

  @Field(() => BillingCycle)
  @Column({ type: 'enum', enum: BillingCycle, name: 'billing_cycle', default: BillingCycle.MONTHLY })
  billingCycle!: BillingCycle;

  @Field(() => PlanLimits)
  @Column('jsonb')
  limits!: PlanLimits;

  @Field(() => PlanPricing)
  @Column('jsonb')
  pricing!: PlanPricing;

  @Field(() => [String])
  @Column('jsonb', { default: [] })
  features!: string[];

  @Field()
  @Column({ default: true, name: 'is_active' })
  isActive!: boolean;

  @Field()
  @Column({ default: true, name: 'is_public' })
  isPublic!: boolean;

  @Field(() => Int)
  @Column({ type: 'int', default: 0, name: 'sort_order' })
  sortOrder!: number;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ nullable: true, name: 'created_by' })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true, name: 'updated_by' })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;

  /**
   * Normalize plan name before save
   */
  @BeforeInsert()
  @BeforeUpdate()
  sanitize(): void {
    if (this.name) {
      this.name = this.name.trim();
    }
  }
}
