import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';
import { ObjectType, Field, ID, GraphQLISODateTime } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import { OWNER_MODULE, type OwnerModuleCode } from '@aquaculture/shared-contracts';
import { ALERT_MODULE_ENUM } from './alert-module.enum';

/**
 * Alert History Entity
 * Records triggered alerts for audit and tracking
 */
@ObjectType()
@Entity('alert_history')
@Index(['tenantId', 'triggeredAt'])
// The console reads alarms per site and per module (module dashboards, the
// workspace menu's counts): both filters narrow by equality, newest first.
@Index('IDX_alert_history_site_id_triggered_at', ['siteId', 'triggeredAt'])
@Index('IDX_alert_history_module_triggered_at', ['module', 'triggeredAt'])
// PE-02: Explicit descending composite index for the cooldown query
// (ruleId equality + triggeredAt range with DESC ordering).
@Index(['ruleId', 'triggeredAt'], { spatial: false, unique: false })
@Index(['severity', 'acknowledged'])
// Task 1.5 idempotency: one alert per (rule, source reading event). A
// redelivered SensorReading (deterministic eventId, Task 1.4) hits this
// constraint instead of double-firing notifications.
@Index('uq_alert_history_rule_source_event', ['ruleId', 'sourceEventId'], { unique: true })
export class AlertHistory {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'rule_id' })
  @Index()
  ruleId!: string;

  /**
   * The SensorReading event's own (deterministic) eventId that fired this
   * alert — the idempotency half of the (rule_id, source_event_id) unique
   * key. Nullable only for rows predating the column (legacy backfill).
   */
  @Field({ nullable: true })
  @Column({ name: 'source_event_id', type: 'uuid', nullable: true })
  sourceEventId?: string;

  @Field()
  @Column({ name: 'rule_name' })
  ruleName!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field({ nullable: true })
  @Column({ name: 'farm_id', nullable: true })
  farmId?: string;

  @Field({ nullable: true })
  @Column({ name: 'pond_id', nullable: true })
  pondId?: string;

  @Field({ nullable: true })
  @Column({ name: 'sensor_id', nullable: true })
  sensorId?: string;

  /**
   * The farm site the alarm's source belongs to, as its producer knew it (the
   * sensor's site, the measured unit's site, the day plan's site). Null when
   * the source has no single site — a batch-level FCR, tenant-wide stock — or
   * the row predates the column and no exact backfill reached it
   * (migration 1801300000000).
   */
  @Field(() => ID, { nullable: true })
  @Column({ name: 'site_id', type: 'uuid', nullable: true })
  siteId?: string | null;

  /**
   * The module the alarm originates in (a module dictionary owner module). Null only on rows that
   * predate the column and whose rule the backfill could not attribute.
   */
  @Field(() => ALERT_MODULE_ENUM, { nullable: true })
  @Column({ name: 'module', type: 'enum', enum: OWNER_MODULE, nullable: true })
  module?: OwnerModuleCode | null;

  @Field(() => AlertSeverity)
  @Column({ name: 'severity', type: 'enum', enum: AlertSeverity })
  severity!: AlertSeverity;

  @Field()
  @Column({ name: 'message', type: 'text' })
  message!: string;

  @Field(() => GraphQLJSON)
  @Column({ name: 'triggering_data', type: 'jsonb' })
  triggeringData!: Record<string, unknown>; // The sensor reading that triggered

  @Field(() => GraphQLISODateTime)
  @Column({ name: 'triggered_at', type: 'timestamptz' })
  @Index()
  triggeredAt!: Date;

  @Field()
  @Column({ name: 'acknowledged', default: false })
  acknowledged!: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
  acknowledgedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'acknowledged_by', nullable: true })
  acknowledgedBy?: string;

  @Field({ nullable: true })
  @Column({ name: 'acknowledgement_note', type: 'text', nullable: true })
  acknowledgementNote?: string;

  @Field()
  @Column({ name: 'resolved', default: false })
  resolved!: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt?: Date;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
