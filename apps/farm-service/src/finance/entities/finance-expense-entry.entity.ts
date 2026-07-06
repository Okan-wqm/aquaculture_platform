/**
 * FinanceExpenseEntry Entity
 *
 * MANUAL ledger rows only — expenses/revenues the tenant books directly
 * in the finance tab (electricity, oxygen, insurance, software, …).
 *
 * Derived costs (feed from feeding_records, fingerlings from batches_v2,
 * maintenance from work_orders, treatments from health_events, harvest
 * revenue from harvest_records) are INTENTIONALLY absent from this table:
 * they are projected at query time from their source-of-truth rows by
 * FinanceLedgerQueryService via the DERIVED_COST_SOURCES registry. A
 * second persisted copy would be a dual ledger — the exact drift failure
 * mode documented on the feed_inventory/storage_inventory reconciliation.
 */
import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
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
import { DecimalTransformer } from '@aquaculture/backend-common/database';

import { FinanceCategory } from './finance-category.entity';

@ObjectType()
@Entity('finance_expense_entries')
@Index('idx_finance_entries_tenant_date', ['tenantId', 'entryDate'])
@Index('idx_finance_entries_tenant_category_date', ['tenantId', 'categoryId', 'entryDate'])
@Index('idx_finance_entries_tenant_batch', ['tenantId', 'batchId'])
@Index('idx_finance_entries_tenant_site', ['tenantId', 'siteId'])
export class FinanceExpenseEntry {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  @Field()
  @Column('uuid')
  categoryId: string;

  @Field(() => FinanceCategory, { nullable: true })
  @ManyToOne(() => FinanceCategory, { nullable: true })
  @JoinColumn({ name: 'categoryId' })
  category?: FinanceCategory;

  /** Day the expense/revenue is booked on (drives all time aggregation). */
  @Field()
  @Column('date')
  entryDate: Date;

  /** Optional coverage period (e.g. an annual insurance premium). */
  @Field({ nullable: true })
  @Column('date', { nullable: true })
  periodStart?: Date;

  @Field({ nullable: true })
  @Column('date', { nullable: true })
  periodEnd?: Date;

  @Field(() => Float)
  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    transformer: new DecimalTransformer(),
  })
  amount: number;

  /** ISO 4217 — defaulted from the tenant finance settings at write time. */
  @Field()
  @Column('varchar', { length: 3 })
  currency: string;

  @Field(() => String, { nullable: true })
  @Column('text', { nullable: true })
  description?: string | null;

  @Field(() => String, { nullable: true })
  @Column('uuid', { nullable: true })
  siteId?: string | null;

  @Field(() => String, { nullable: true })
  @Column('uuid', { nullable: true })
  batchId?: string | null;

  @Field(() => String, { nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string | null;

  @Field(() => String, { nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string | null;

  /** Soft delete — deleted rows leave aggregates but keep audit history. */
  @Column('boolean', { default: false })
  isDeleted: boolean;

  @Column('timestamptz', { nullable: true })
  deletedAt?: Date | null;

  @VersionColumn()
  version: number;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
