/**
 * FinanceCategory Entity
 *
 * Dynamic, per-tenant expense/revenue category catalogue for the farm
 * finance ledger. Categories are DATA ROWS, never DDL — a tenant adding
 * a custom expense type inserts a row into its own tenant_<uuid> schema,
 * which keeps the 100% physical isolation guarantee without runtime
 * schema mutation.
 *
 * Two category classes:
 *
 *   - System categories (`isSystem = true`) carry a stable machine `code`
 *     (e.g. FEED, FINGERLINGS, OTHER_VARIABLE). Derived-cost binding and
 *     computed rules reference the CODE, never the display name — tenants
 *     rename freely without breaking derivation. Seeded idempotently per
 *     tenant by FinanceCategorySeedService.
 *   - User categories (`isSystem = false`, `code = null`) are fully
 *     user-managed: create / rename / archive. Hard delete is allowed
 *     only while no entry references them.
 *
 * Computed categories carry a `computedRule` (e.g. "Other variable cost =
 * 5% of total operational cost") evaluated at READ time by
 * ComputedRuleEvaluator — the 5% is never materialised as rows, so it can
 * never drift from its base.
 */
import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum FinanceCategoryScope {
  FARM_OPEX = 'FARM_OPEX',
  FARM_REVENUE = 'FARM_REVENUE',
}

registerEnumType(FinanceCategoryScope, {
  name: 'FinanceCategoryScope',
  description: 'Which farm finance ledger a category belongs to',
});

export enum FinanceCategoryKind {
  EXPENSE = 'EXPENSE',
  REVENUE = 'REVENUE',
}

registerEnumType(FinanceCategoryKind, {
  name: 'FinanceCategoryKind',
  description: 'Whether entries in the category are money out or money in',
});

/**
 * Read-time computation rule attached to a category.
 *
 * PERCENT_OF_SCOPE_TOTAL: value = percent% of the sum of all NON-computed
 * category totals in the same scope and period. Restricting the base to
 * non-computed categories makes the definition non-self-referential — no
 * fixpoint iteration, one deterministic pass.
 */
export interface FinanceComputedRule {
  type: 'PERCENT_OF_SCOPE_TOTAL';
  percent: number;
  base: 'NON_COMPUTED';
}

@ObjectType()
@Entity('finance_categories')
@Index('idx_finance_categories_tenant_scope_active', ['tenantId', 'scope', 'isActive'])
export class FinanceCategory {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  @Field()
  @Column('varchar', { length: 120 })
  name: string;

  /**
   * Stable machine code — system categories only. Uniqueness per
   * (tenantId, scope, code) is enforced by a partial unique index in the
   * migration (WHERE "code" IS NOT NULL), which TypeORM decorators cannot
   * express.
   */
  @Field(() => String, { nullable: true })
  @Column('varchar', { length: 40, nullable: true })
  code?: string | null;

  @Field(() => FinanceCategoryScope)
  @Column({
    type: 'enum',
    enum: FinanceCategoryScope,
    enumName: 'finance_category_scope_enum',
  })
  scope: FinanceCategoryScope;

  @Field(() => FinanceCategoryKind)
  @Column({
    type: 'enum',
    enum: FinanceCategoryKind,
    enumName: 'finance_category_kind_enum',
    default: FinanceCategoryKind.EXPENSE,
  })
  kind: FinanceCategoryKind;

  /**
   * Read-time computation rule (see FinanceComputedRule). Categories with
   * a rule reject manual entries — their value exists only as a projection.
   */
  @Field(() => GraphQLJSON, { nullable: true })
  @Column('jsonb', { nullable: true })
  computedRule?: FinanceComputedRule | null;

  @Field()
  @Column('boolean', { default: false })
  isSystem: boolean;

  @Field()
  @Column('boolean', { default: true })
  isActive: boolean;

  @Field(() => Int)
  @Column('int', { default: 0 })
  displayOrder: number;

  @Field(() => String, { nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string | null;

  @Field(() => String, { nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string | null;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
