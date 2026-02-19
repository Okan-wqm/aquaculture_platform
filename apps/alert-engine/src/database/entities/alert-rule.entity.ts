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
  parameter!: string; // 'temperature', 'ph', 'dissolvedOxygen', etc.

  @Field(() => AlertOperator)
  operator!: AlertOperator;

  @Field()
  threshold!: number;

  @Field(() => AlertSeverity)
  severity!: AlertSeverity;
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
@Index(['name', 'tenantId'], { unique: true })
export class AlertRule {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'name' })
  name!: string;

  @Field({ nullable: true })
  @Column({ name: 'description', nullable: true })
  description?: string;

  @Field()
  @Column({ name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field({ nullable: true })
  @Column({ name: 'farm_id', nullable: true })
  @Index()
  farmId?: string;

  @Field({ nullable: true })
  @Column({ name: 'pond_id', nullable: true })
  @Index()
  pondId?: string;

  @Field({ nullable: true })
  @Column({ name: 'sensor_id', nullable: true })
  @Index()
  sensorId?: string;

  @Field(() => GraphQLJSON)
  @Column({ name: 'conditions', type: 'jsonb' })
  conditions!: AlertCondition[];

  @Field(() => AlertSeverity, { nullable: true })
  @Column({
    name: 'severity',
    type: 'enum',
    enum: AlertSeverity,
    default: AlertSeverity.MEDIUM,
    nullable: true,
  })
  severity?: AlertSeverity;

  @Field()
  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @Field(() => [String], { nullable: true })
  @Column({ name: 'notification_channels', type: 'jsonb', nullable: true })
  notificationChannels?: string[]; // ['email', 'sms', 'push']

  @Field(() => [String], { nullable: true })
  @Column({ name: 'recipients', type: 'jsonb', nullable: true })
  recipients?: string[]; // user IDs or email addresses

  @Field(() => Int)
  @Column({ name: 'cooldown_minutes', type: 'int', default: 0 })
  cooldownMinutes!: number; // Prevent alert spam

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;
}
