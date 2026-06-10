import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';

/**
 * PayrollAudit — immutable audit trail for payroll calculations.
 *
 * HR-HIGH-006: Labor law compliance requires an immutable record of
 * every payroll calculation's inputs, outputs, and approval decisions.
 *
 * This entity is INSERT-ONLY. No update or delete operations are permitted.
 * The table should have a DB-level trigger or RLS policy preventing UPDATE/DELETE
 * in production.
 *
 * Each row captures a single payroll lifecycle event (creation, approval,
 * rejection, payment). The combination of payrollId + action forms the
 * audit trail for a given payroll record.
 */
export enum PayrollAuditAction {
  CREATED = 'CREATED',
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
  RECALCULATED = 'RECALCULATED',
}

@ObjectType()
@Entity('payroll_audit', { schema: 'hr' })
@Index(['tenantId', 'payrollId'])
@Index(['tenantId', 'employeeId'])
@Index(['tenantId', 'action', 'createdAt'])
@Index(['tenantId', 'createdAt'])
export class PayrollAudit {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid' })
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  payrollId!: string;

  @Field()
  @Column()
  employeeId!: string;

  @Field()
  @Column({ type: 'varchar', length: 30 })
  action!: string;

  /** Snapshot of calculation inputs at the time of the action */
  @Field(() => String, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  calculationInputs?: Record<string, unknown>;

  /** Snapshot of calculation outputs at the time of the action */
  @Field(() => String, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  calculationOutputs?: Record<string, unknown>;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  grossPay?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  netPay?: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  currency?: string;

  @Field()
  @Column()
  performedBy!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  /** IP address of the request (for audit compliance) */
  @Field({ nullable: true })
  @Column({ length: 45, nullable: true })
  ipAddress?: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
