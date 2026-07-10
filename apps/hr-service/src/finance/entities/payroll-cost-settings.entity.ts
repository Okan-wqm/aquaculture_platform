/**
 * PayrollCostSettings Entity — per-tenant labour-cost configuration
 * (one row per tenant).
 *
 * Fund percentages apply over the annual salary base in the Labour Cost
 * read model:
 *   pension fund, social insurance fund, compulsory medical insurance
 *   fund — default 0.00 (the tenant admin enters their jurisdiction's
 *   employer rates; product-owner decision), and
 *   other cost — default 5.00 ("Other cost = 5% of annual salaries").
 *
 * `defaultCurrency` is PROJECTED from the farm finance_settings SSoT via
 * the FinanceSettingsUpdated event consumer — it is intentionally not
 * exposed as an editable field, so a second tenant-editable currency
 * source never exists.
 */
import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const HR_PLATFORM_DEFAULT_CURRENCY = 'NOK';

const pct = {
  type: 'decimal' as const,
  precision: 5,
  scale: 2,
  transformer: new DecimalTransformer(),
};

@ObjectType()
@Entity('hr_payroll_cost_settings')
@Index('UQ_hr_payroll_cost_settings_tenant', ['tenantId'], { unique: true })
export class PayrollCostSettings {
  // Nullable in GraphQL: the read path returns an in-memory defaults view
  // (no persisted row) for a tenant that has not saved settings yet — that
  // view has no id, and a non-null id would crash serialization.
  @Field(() => ID, { nullable: true })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  tenantId!: string;

  @Field(() => Float)
  @Column({ ...pct, default: 0 })
  pensionFundPct!: number;

  @Field(() => Float)
  @Column({ ...pct, default: 0 })
  socialInsurancePct!: number;

  @Field(() => Float)
  @Column({ ...pct, default: 0 })
  medicalInsurancePct!: number;

  @Field(() => Float)
  @Column({ ...pct, default: 5 })
  otherCostPct!: number;

  @Field()
  @Column('varchar', { length: 3, default: HR_PLATFORM_DEFAULT_CURRENCY })
  defaultCurrency!: string;

  /**
   * Source timestamp of the last FinanceSettingsUpdated event applied to
   * `defaultCurrency`. The consumer only projects an event newer than this
   * watermark, so an out-of-order redelivery cannot regress the currency.
   */
  @Column('timestamptz', { nullable: true })
  currencyProjectedAt?: Date | null;

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
