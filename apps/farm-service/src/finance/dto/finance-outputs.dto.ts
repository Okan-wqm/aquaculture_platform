/**
 * Finance read-model GraphQL types — the unified ledger surface.
 *
 * FinanceLineItem is the single row shape for the Expenses tab:
 * `origin` distinguishes MANUAL rows (editable in place) from DERIVED
 * rows (read-only projections of a source record — `sourceDomain` +
 * `sourceRecordId` drive the "edit at source" deep link).
 */
import { Field, Float, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';

import {
  FinanceCategoryKind,
  FinanceCategoryScope,
} from '../entities/finance-category.entity';

// ADR-0004 / DATA-MEDIUM-009 additive coexistence: each money `Float` field gains
// a parallel `*Decimal` field (exact decimal string via the Decimal scalar),
// populated by a resolver-boundary mapper (finance-decimal.mapper). The `Float`
// fields are deprecated and stay through the window.
import {
  FinanceGranularity,
  FinanceLineOrigin,
} from '../services/finance-ledger-query.service';

registerEnumType(FinanceLineOrigin, {
  name: 'FinanceLineOrigin',
  description: 'Whether a ledger line is a manual booking or a derived projection',
});

registerEnumType(FinanceGranularity, {
  name: 'FinanceGranularity',
  description: 'Time bucket size for finance aggregation',
});

@ObjectType()
export class FinanceLineItem {
  @Field(() => ID)
  id!: string;

  @Field(() => FinanceLineOrigin)
  origin!: FinanceLineOrigin;

  @Field(() => ID, { nullable: true })
  categoryId?: string | null;

  @Field(() => String, { nullable: true })
  categoryCode?: string | null;

  @Field()
  categoryName!: string;

  @Field(() => FinanceCategoryKind)
  kind!: FinanceCategoryKind;

  @Field(() => Float, { deprecationReason: 'Use amountDecimal (exact decimal string, ADR-0004).' })
  amount!: number;

  @Field(() => DecimalScalar)
  amountDecimal?: number;

  @Field()
  currency!: string;

  @Field()
  entryDate!: Date;

  @Field(() => ID, { nullable: true })
  batchId?: string | null;

  @Field(() => ID, { nullable: true })
  siteId?: string | null;

  @Field(() => String, { nullable: true })
  description?: string | null;

  /** True when the amount is an estimate (e.g. an uncosted work order). */
  @Field()
  estimated!: boolean;

  /** MANUAL rows are editable here; DERIVED rows are edited at their source. */
  @Field()
  editable!: boolean;

  @Field(() => String, { nullable: true })
  sourceDomain?: string | null;

  @Field(() => ID, { nullable: true })
  sourceRecordId?: string | null;
}

@ObjectType()
export class FinanceCategoryTotal {
  @Field(() => ID)
  categoryId!: string;

  @Field(() => String, { nullable: true })
  categoryCode?: string | null;

  @Field()
  categoryName!: string;

  @Field(() => FinanceCategoryScope)
  scope!: FinanceCategoryScope;

  @Field(() => FinanceCategoryKind)
  kind!: FinanceCategoryKind;

  @Field()
  isComputed!: boolean;

  @Field()
  isDerived!: boolean;

  @Field(() => Float, { deprecationReason: 'Use totalDecimal (exact decimal string, ADR-0004).' })
  total!: number;

  @Field(() => DecimalScalar)
  totalDecimal?: number;
}

@ObjectType()
export class FinanceTimeBucket {
  @Field()
  bucketStart!: Date;

  @Field(() => Float, { deprecationReason: 'Use totalExpenseDecimal (ADR-0004).' })
  totalExpense!: number;

  @Field(() => DecimalScalar)
  totalExpenseDecimal?: number;

  @Field(() => Float, { deprecationReason: 'Use totalRevenueDecimal (ADR-0004).' })
  totalRevenue!: number;

  @Field(() => DecimalScalar)
  totalRevenueDecimal?: number;
}

@ObjectType()
export class FinanceBatchTotal {
  @Field(() => ID)
  batchId!: string;

  @Field(() => Float, { deprecationReason: 'Use totalExpenseDecimal (ADR-0004).' })
  totalExpense!: number;

  @Field(() => DecimalScalar)
  totalExpenseDecimal?: number;

  @Field(() => Float, { deprecationReason: 'Use totalRevenueDecimal (ADR-0004).' })
  totalRevenue!: number;

  @Field(() => DecimalScalar)
  totalRevenueDecimal?: number;
}

@ObjectType()
export class FinanceSummary {
  @Field()
  currency!: string;

  @Field(() => Float, { deprecationReason: 'Use totalExpenseDecimal (ADR-0004).' })
  totalExpense!: number;

  @Field(() => DecimalScalar)
  totalExpenseDecimal?: number;

  @Field(() => Float, { deprecationReason: 'Use totalRevenueDecimal (ADR-0004).' })
  totalRevenue!: number;

  @Field(() => DecimalScalar)
  totalRevenueDecimal?: number;

  @Field(() => Float, { deprecationReason: 'Use netResultDecimal (ADR-0004).' })
  netResult!: number;

  @Field(() => DecimalScalar)
  netResultDecimal?: number;

  @Field(() => [FinanceCategoryTotal])
  byCategory!: FinanceCategoryTotal[];

  @Field(() => [FinanceTimeBucket])
  series!: FinanceTimeBucket[];
}
