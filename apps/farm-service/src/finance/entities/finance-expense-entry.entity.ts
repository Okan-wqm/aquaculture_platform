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
import { DecimalTransformer } from '@aquaculture/backend-common/database';

import { FinanceCategory } from './finance-category.entity';

@ObjectType()
@Entity('finance_expense_entries')
// Partial on the read path's dominant predicate (soft-deleted rows leave
// aggregates but keep audit history) — see migration 1805500000000.
@Index('idx_finance_entries_tenant_date_active', ['tenantId', 'entryDate'], {
  where: '"isDeleted" = false',
})
@Index(
  'idx_finance_entries_tenant_category_date_active',
  ['tenantId', 'categoryId', 'entryDate'],
  { where: '"isDeleted" = false' },
)
@Index('idx_finance_entries_tenant_batch_active', ['tenantId', 'batchId'], {
  where: '"isDeleted" = false',
})
@Index('idx_finance_entries_tenant_site_active', ['tenantId', 'siteId'], {
  where: '"isDeleted" = false',
})
export class FinanceExpenseEntry {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  @Field()
  @Column('uuid')
  categoryId!: string;

  @Field(() => FinanceCategory, { nullable: true })
  @ManyToOne(() => FinanceCategory, { nullable: true })
  @JoinColumn({ name: 'categoryId' })
  category?: FinanceCategory;

  /** Day the expense/revenue is booked on (drives all time aggregation). */
  @Field()
  @Column('date')
  entryDate!: Date;

  /** Optional coverage period (e.g. an annual insurance premium). */
  @Field({ nullable: true })
  @Column('date', { nullable: true })
  periodStart?: Date;

  @Field({ nullable: true })
  @Column('date', { nullable: true })
  periodEnd?: Date;

  @Field(() => Float, {
    deprecationReason: 'Use amountDecimal (exact decimal string, ADR-0004).',
  })
  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    transformer: new DecimalTransformer(),
  })
  amount!: number;

  /** Same value as `amount`, on the wire as an exact decimal string (ADR-0004 /
   *  DATA-MEDIUM-009). A getter (not a column) so TypeORM ignores it. */
  @Field(() => DecimalScalar)
  get amountDecimal(): number {
    return this.amount;
  }

  /** ISO 4217 — defaulted from the tenant finance settings at write time. */
  @Field()
  @Column('varchar', { length: 3 })
  currency!: string;

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
