import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';
import { ObjectType, Field, ID, GraphQLISODateTime } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';

/**
 * Alert History Entity
 * Records triggered alerts for audit and tracking
 */
@ObjectType()
@Entity('alert_history')
@Index(['tenantId', 'triggeredAt'])
// PE-02: Explicit descending composite index for the cooldown query
// (ruleId equality + triggeredAt range with DESC ordering).
@Index(['ruleId', 'triggeredAt'], { spatial: false, unique: false })
@Index(['severity', 'acknowledged'])
@Index('UQ_alert_history_source_event_rule', ['sourceEventId', 'ruleId'], {
  unique: true,
  where: '"source_event_id" IS NOT NULL',
})
export class AlertHistory {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'source_event_id', type: 'uuid', nullable: true })
  sourceEventId?: string;

  @Field()
  @Column({ name: 'rule_id' })
  @Index()
  ruleId!: string;

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
