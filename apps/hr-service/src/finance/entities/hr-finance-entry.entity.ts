/**
 * HrFinanceEntry Entity — manual HR expense bookings (training,
 * recruitment, PPE, travel…). Payroll itself is NOT booked here — the
 * Labour Cost read model projects it from employees + payrolls +
 * hr_payroll_cost_settings so the payroll SSoT is never duplicated.
 */
import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

import { HrFinanceCategory } from './hr-finance-category.entity';

@ObjectType()
@Entity('hr_finance_entries')
@Index('IDX_hr_finance_entries_tenant_date', ['tenantId', 'entryDate'])
@Index('IDX_hr_finance_entries_tenant_category_date', ['tenantId', 'categoryId', 'entryDate'])
@Index('IDX_hr_finance_entries_tenant_department', ['tenantId', 'departmentHrId'])
export class HrFinanceEntry {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  tenantId!: string;

  @Field()
  @Column('uuid')
  categoryId!: string;

  @Field(() => HrFinanceCategory, { nullable: true })
  @ManyToOne(() => HrFinanceCategory, { nullable: true })
  @JoinColumn({ name: 'categoryId' })
  category?: HrFinanceCategory;

  @Field()
  @Column('date')
  entryDate!: Date;

  @Field(() => Float, {
    deprecationReason:
      'Use amountDecimal (exact decimal string, ADR-0004). Float is removed after the coexistence window.',
  })
  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    transformer: new DecimalTransformer(),
  })
  amount!: number;

  /**
   * The same value as `amount`, on the wire as an EXACT decimal string via the
   * platform Decimal scalar (ADR-0004 / DATA-MEDIUM-009). Additive coexistence:
   * `amount` (Float) stays until consumers migrate, then Float is removed. A
   * getter (not a column) so TypeORM ignores it and no handler change is needed.
   */
  @Field(() => DecimalScalar, {
    description: 'Exact-decimal amount as a string. Coexists with the deprecated Float `amount`.',
  })
  get amountDecimal(): number {
    return this.amount;
  }

  /** ISO 4217 — defaulted from hr_payroll_cost_settings at write time. */
  @Field()
  @Column('varchar', { length: 3 })
  currency!: string;

  @Field(() => String, { nullable: true })
  @Column('text', { nullable: true })
  description?: string | null;

  @Field(() => String, { nullable: true })
  @Column('uuid', { nullable: true })
  departmentHrId?: string | null;

  @Field(() => String, { nullable: true })
  @Column('uuid', { nullable: true })
  employeeId?: string | null;

  @Field(() => String, { nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string | null;

  @Field(() => String, { nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string | null;

  @Column('boolean', { default: false })
  isDeleted!: boolean;

  @Column('timestamptz', { nullable: true })
  deletedAt?: Date | null;

  /** Actor who soft-deleted the row — required for financial audit attribution. */
  @Column('uuid', { nullable: true })
  deletedBy?: string | null;

  @VersionColumn()
  version!: number;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
