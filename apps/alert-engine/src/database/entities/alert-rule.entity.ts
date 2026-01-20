import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

/**
 * Alert condition operator
 */
export enum AlertOperator {
  GT = 'gt',
  GTE = 'gte',
  LT = 'lt',
  LTE = 'lte',
  EQ = 'eq',
}

registerEnumType(AlertOperator, {
  name: 'AlertOperator',
  description: 'Comparison operator for alert conditions',
});

/**
 * Alert severity level
 */
export enum AlertSeverity {
  INFO = 'info',
  LOW = 'low',
  WARNING = 'warning',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

registerEnumType(AlertSeverity, {
  name: 'AlertSeverity',
  description: 'Severity level for alerts',
});

/**
 * Alert condition structure
 */
@ObjectType('AlertCondition')
export class AlertCondition {
  @Field()
  parameter: string; // 'temperature', 'ph', 'dissolvedOxygen', etc.

  @Field(() => AlertOperator)
  operator: AlertOperator;

  @Field()
  threshold: number;

  @Field(() => AlertSeverity)
  severity: AlertSeverity;
}

/**
 * Alert Rule Entity
 * Defines conditions for triggering alerts
 */
@ObjectType()
@Entity('alert_rules')
@Index(['tenantId', 'isActive'])
@Index(['farmId'])
@Index(['pondId'])
export class AlertRule {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column()
  name: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  description?: string;

  @Field()
  @Column()
  @Index()
  tenantId: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  @Index()
  farmId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  @Index()
  pondId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  sensorId?: string;

  @Field(() => GraphQLJSON)
  @Column('jsonb')
  conditions: AlertCondition[];

  @Field(() => AlertSeverity, { nullable: true })
  @Column({
    type: 'enum',
    enum: AlertSeverity,
    default: AlertSeverity.MEDIUM,
    nullable: true,
  })
  severity?: AlertSeverity;

  @Field()
  @Column({ default: true })
  isActive: boolean;

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  notificationChannels?: string[]; // ['email', 'sms', 'push']

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  recipients?: string[]; // user IDs or email addresses

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  cooldownMinutes: number; // Prevent alert spam

  @Field()
  @CreateDateColumn()
  createdAt: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  createdBy?: string;
}
