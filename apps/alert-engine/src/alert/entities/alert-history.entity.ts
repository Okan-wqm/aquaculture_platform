import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
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
@Index(['ruleId', 'triggeredAt'])
@Index(['severity', 'acknowledged'])
export class AlertHistory {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  @Index()
  ruleId: string;

  @Field()
  @Column()
  ruleName: string;

  @Field()
  @Column()
  @Index()
  tenantId: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  farmId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  pondId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  sensorId?: string;

  @Field(() => AlertSeverity)
  @Column({ type: 'enum', enum: AlertSeverity })
  severity: AlertSeverity;

  @Field()
  @Column('text')
  message: string;

  @Field(() => GraphQLJSON)
  @Column('jsonb')
  triggeringData: Record<string, unknown>; // The sensor reading that triggered

  @Field(() => GraphQLISODateTime)
  @Column({ type: 'timestamptz' })
  @Index()
  triggeredAt: Date;

  @Field()
  @Column({ default: false })
  acknowledged: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  acknowledgedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  acknowledgedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  acknowledgementNote?: string;

  @Field()
  @Column({ default: false })
  resolved: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt?: Date;

  @Field()
  @CreateDateColumn()
  createdAt: Date;
}
