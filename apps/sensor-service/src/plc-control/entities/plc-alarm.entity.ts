import { ObjectType, Field, ID, Float, Int, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum AlarmSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
  EMERGENCY = 'EMERGENCY',
}

export enum AlarmSource {
  OXYGEN_SENSOR = 'OXYGEN_SENSOR',
  TEMPERATURE_SENSOR = 'TEMPERATURE_SENSOR',
  PH_SENSOR = 'PH_SENSOR',
  FLOW_SENSOR = 'FLOW_SENSOR',
  BLOWER_VFD = 'BLOWER_VFD',
  DOSER_VFD = 'DOSER_VFD',
  FEEDING_SYSTEM = 'FEEDING_SYSTEM',
  PLC_SYSTEM = 'PLC_SYSTEM',
  COMMUNICATION = 'COMMUNICATION',
}

registerEnumType(AlarmSeverity, { name: 'AlarmSeverity' });
registerEnumType(AlarmSource, { name: 'AlarmSource' });

@ObjectType('ApprovalChainEntry')
export class ApprovalChainEntry {
  @Field()
  userId!: string;

  @Field(() => Int)
  level!: number;

  @Field()
  approvedAt!: Date;

  @Field({ nullable: true })
  notes?: string;
}

@ObjectType()
@Entity('plc_alarms')
@Index(['tenantId', 'plcConnectionId', 'timestamp'])
@Index(['tenantId', 'acknowledged'])
export class PlcAlarm {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  plcConnectionId!: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  tankId?: string;

  @Field()
  @Column()
  alarmCode!: string; // e.g., "ALM-2026-001"

  @Field(() => AlarmSeverity)
  @Column({ type: 'varchar' })
  severity!: AlarmSeverity;

  @Field(() => AlarmSource)
  @Column({ type: 'varchar' })
  source!: AlarmSource;

  @Field()
  @Column()
  message!: string;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  value?: number; // Current value that triggered the alarm

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  threshold?: number; // Threshold that was exceeded

  @Field({ nullable: true })
  @Column({ nullable: true })
  action?: string; // Action taken by PLC (e.g., "Besleme durduruldu")

  @Field()
  @Column()
  @Index()
  timestamp!: Date;

  @Field()
  @Column({ default: false })
  acknowledged!: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  acknowledgedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  acknowledgedBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  clearedAt?: Date; // When the alarm condition was cleared

  @Field({ nullable: true })
  @Column({ nullable: true })
  notes?: string; // Operator notes

  // === Enterprise Approval Workflow ===

  /** Current approval level (0=pending, 1=operator, 2=supervisor, 3=manager) */
  @Field(() => Int)
  @Column({ name: 'approval_level', type: 'int', default: 0 })
  approvalLevel!: number;

  /** Minimum required approval level based on severity */
  @Field(() => Int)
  @Column({ name: 'required_approval_level', type: 'int', default: 1 })
  requiredApprovalLevel!: number;

  /** Approval chain history: [{userId, level, approvedAt, notes}] */
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'approval_chain', type: 'jsonb', default: '[]' })
  approvalChain!: ApprovalChainEntry[];

  /** When alarm was escalated to higher level */
  @Field({ nullable: true })
  @Column({ name: 'escalated_at', type: 'timestamptz', nullable: true })
  escalatedAt?: Date;

  /** Auto-escalation timeout in milliseconds */
  @Field(() => Int, { nullable: true })
  @Column({ name: 'auto_escalate_after_ms', type: 'int', nullable: true })
  autoEscalateAfterMs?: number;

  /** SLA deadline for acknowledgement */
  @Field({ nullable: true })
  @Column({ name: 'sla_deadline', type: 'timestamptz', nullable: true })
  slaDeadline?: Date;

  /** Whether SLA has been breached */
  @Field()
  @Column({ name: 'sla_breached', default: false })
  slaBreached!: boolean;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;
}
