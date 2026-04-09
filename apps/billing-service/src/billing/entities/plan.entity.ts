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
import { MoneyColumn } from '@aquaculture/backend-common';
import Decimal from 'decimal.js';
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
  // MoneyColumn: numeric(19,4) with lossless Decimal.js transformer.
  // basePrice is used in subscription pricing calculations.
  @MoneyColumn({ name: 'base_price' })
  basePrice!: Decimal;

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

  // Soft-delete: plan templates must not be physically deleted because existing subscriptions
  // reference them. Hard-deleting a plan would orphan all active subscriptions on that plan.
  // BEFORE: no soft-delete — plan records could be permanently removed, breaking subscription references.
  @Field()
  @Column({ default: false, name: 'is_deleted' })
  @Index()
  isDeleted: boolean = false;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  @Column({ nullable: true, name: 'deleted_by' })
  deletedBy?: string;

  softDelete(deletedBy?: string): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
  }

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
