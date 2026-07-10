/**
 * HrFinanceCategory Entity — dynamic HR expense taxonomy.
 *
 * Same posture as the farm finance_categories table: categories are
 * per-tenant DATA rows, never DDL. System categories carry a stable
 * `code`; the "Other HR cost = 5% of annual salaries" line is a
 * computed rule evaluated at read time, not a bookable row.
 *
 * The pension / social-insurance / medical-fund lines of the Labour
 * Cost table are NOT categories — they are projections of
 * hr_payroll_cost_settings percentages over the salary base.
 */
import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export interface HrFinanceComputedRule {
  type: 'PERCENT_OF_ANNUAL_SALARIES';
  percent: number;
}

@ObjectType()
@Entity('hr_finance_categories')
@Index('IDX_hr_finance_categories_tenant', ['tenantId', 'isActive'])
export class HrFinanceCategory {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  tenantId!: string;

  @Field()
  @Column('varchar', { length: 120 })
  name!: string;

  /** Stable machine code — system categories only (partial unique index). */
  @Field(() => String, { nullable: true })
  @Column('varchar', { length: 40, nullable: true })
  code?: string | null;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column('jsonb', { nullable: true })
  computedRule?: HrFinanceComputedRule | null;

  @Field()
  @Column('boolean', { default: false })
  isSystem!: boolean;

  @Field()
  @Column('boolean', { default: true })
  isActive!: boolean;

  @Field(() => Int)
  @Column('int', { default: 0 })
  displayOrder!: number;

  @Field(() => String, { nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string | null;

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
