/**
 * FinanceSettings Entity
 *
 * Per-tenant finance configuration — one row per tenant (unique tenantId).
 *
 * `defaultCurrency` is the tenant-wide currency SSoT. It cures the
 * historical hardcode drift where feeds/equipment entities defaulted to
 * 'TRY', the feeding handler to 'NOK' and the HR employee entity to
 * 'USD' — three independent literals with no tenant-level source.
 * FinanceSettingsService is the ONLY defaulting path; changes propagate
 * to hr-service via the FinanceSettingsUpdated outbox event.
 */
import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Platform-wide fallback for a tenant that has not yet chosen a currency.
 * Chosen by the product owner (Norwegian aquaculture deployments).
 */
export const PLATFORM_DEFAULT_CURRENCY = 'NOK';

@ObjectType()
@Entity('finance_settings')
@Index('UQ_finance_settings_tenant', ['tenantId'], { unique: true })
export class FinanceSettings {
  // Nullable in GraphQL: the read path returns an in-memory defaults view
  // (no persisted row) for a tenant that has not saved settings yet — that
  // view has no id, and a non-null id would crash serialization.
  @Field(() => ID, { nullable: true })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  tenantId!: string;

  @Field()
  @Column('varchar', { length: 3, default: PLATFORM_DEFAULT_CURRENCY })
  defaultCurrency!: string;

  /** 1-12; month the tenant's fiscal year starts in (yearly aggregation anchor). */
  @Field(() => Int)
  @Column('smallint', { default: 1 })
  fiscalYearStartMonth!: number;

  @Field(() => String, { nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string | null;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
