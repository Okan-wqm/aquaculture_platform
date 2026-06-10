import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { AlertSeverity } from './alert-rule.entity';

/**
 * Escalation action type
 */
export enum EscalationActionType {
  NOTIFY = 'NOTIFY',
  ASSIGN = 'ASSIGN',
  ESCALATE_TO_MANAGER = 'ESCALATE_TO_MANAGER',
  CREATE_TICKET = 'CREATE_TICKET',
  WEBHOOK = 'WEBHOOK',
  AUTO_RESOLVE = 'AUTO_RESOLVE',
}

registerEnumType(EscalationActionType, {
  name: 'EscalationActionType',
  description: 'Type of escalation action',
});

/**
 * Notification channel type
 */
export enum NotificationChannel {
  EMAIL = 'EMAIL',
  SMS = 'SMS',
  SLACK = 'SLACK',
  TEAMS = 'TEAMS',
  WEBHOOK = 'WEBHOOK',
  PUSH = 'PUSH',
  PAGERDUTY = 'PAGERDUTY',
}

registerEnumType(NotificationChannel, {
  name: 'NotificationChannel',
  description: 'Notification delivery channel',
});

/**
 * Escalation level configuration
 */
@ObjectType('EscalationLevel')
export class EscalationLevel {
  @Field(() => Int)
  level!: number;

  @Field()
  name!: string;

  @Field(() => Int)
  timeoutMinutes!: number;

  @Field(() => [String])
  notifyUserIds!: string[];

  @Field(() => [String], { nullable: true })
  notifyTeamIds?: string[];

  @Field(() => [NotificationChannel])
  channels!: NotificationChannel[];

  @Field(() => EscalationActionType)
  action!: EscalationActionType;

  @Field({ nullable: true })
  actionConfig?: string; // JSON string for action-specific config

  @Field({ nullable: true })
  messageTemplate?: string;
}

/**
 * On-call schedule entry
 */
@ObjectType('OnCallSchedule')
export class OnCallSchedule {
  @Field()
  dayOfWeek!: number; // 0 = Sunday, 6 = Saturday

  @Field()
  startTime!: string; // HH:mm format

  @Field()
  endTime!: string; // HH:mm format

  @Field()
  userId!: string;

  @Field({ nullable: true })
  backupUserId?: string;
}

/**
 * Suppression window
 */
@ObjectType('SuppressionWindow')
export class SuppressionWindow {
  @Field()
  id!: string;

  @Field()
  name!: string;

  @Field()
  startTime!: Date;

  @Field()
  endTime!: Date;

  @Field({ nullable: true })
  reason?: string;

  @Field()
  createdBy!: string;

  @Field()
  isRecurring!: boolean;

  @Field({ nullable: true })
  recurringPattern?: string; // cron expression
}

/**
 * Escalation Policy Entity
 * Defines how alerts are escalated and who gets notified
 */
@ObjectType()
@Entity('escalation_policies')
@Index(['tenantId', 'isActive'])
@Index(['severity'])
export class EscalationPolicy {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field()
  @Column({ name: 'name' })
  name!: string;

  @Field({ nullable: true })
  @Column({ name: 'description', type: 'text', nullable: true })
  description?: string;

  @Field(() => [AlertSeverity])
  @Column({ name: 'severity', type: 'jsonb' })
  severity!: AlertSeverity[];

  @Field(() => [EscalationLevel])
  @Column({ name: 'levels', type: 'jsonb' })
  levels!: EscalationLevel[];

  @Field(() => [OnCallSchedule], { nullable: true })
  @Column({ name: 'on_call_schedule', type: 'jsonb', nullable: true })
  onCallSchedule?: OnCallSchedule[];

  @Field(() => [SuppressionWindow], { nullable: true })
  @Column({ name: 'suppression_windows', type: 'jsonb', nullable: true })
  suppressionWindows?: SuppressionWindow[];

  @Field(() => Int)
  @Column({ name: 'repeat_interval_minutes', type: 'int', default: 5 })
  repeatIntervalMinutes!: number;

  @Field(() => Int)
  @Column({ name: 'max_repeats', type: 'int', default: 3 })
  maxRepeats!: number;

  @Field()
  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @Field()
  @Column({ name: 'is_default', default: false })
  isDefault!: boolean;

  @Field(() => Int)
  @Column({ name: 'priority', type: 'int', default: 0 })
  priority!: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'conditions', type: 'jsonb', nullable: true })
  conditions?: Record<string, unknown>; // Additional conditions for policy selection

  @Field({ nullable: true })
  @Column({ name: 'timezone', nullable: true })
  timezone?: string;

  @Field(() => [String], { nullable: true })
  @Column({ name: 'rule_ids', type: 'jsonb', nullable: true })
  ruleIds?: string[]; // Specific rules this policy applies to

  @Field(() => [String], { nullable: true })
  @Column({ name: 'farm_ids', type: 'jsonb', nullable: true })
  farmIds?: string[]; // Specific farms this policy applies to

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  // ============================================
  // Helper Methods
  // ============================================

  getLevel(levelNumber: number): EscalationLevel | undefined {
    return this.levels.find(l => l.level === levelNumber);
  }

  getMaxLevel(): number {
    if (!this.levels || this.levels.length === 0) return 0;
    return Math.max(...this.levels.map(l => l.level));
  }

  hasNextLevel(currentLevel: number): boolean {
    return currentLevel < this.getMaxLevel();
  }

  getNextLevel(currentLevel: number): EscalationLevel | undefined {
    const nextLevelNumber = currentLevel + 1;
    return this.getLevel(nextLevelNumber);
  }

  getCurrentOnCall(date: Date = new Date()): string | undefined {
    if (!this.onCallSchedule?.length) return undefined;

    const dayOfWeek = date.getDay();
    const currentTime = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;

    const schedule = this.onCallSchedule.find(
      s => s.dayOfWeek === dayOfWeek &&
           s.startTime <= currentTime &&
           s.endTime >= currentTime
    );

    return schedule?.userId;
  }

  /**
   * Check whether `date` falls within any suppression window.
   *
   * Contract: `SuppressionWindow.startTime` and `endTime` MUST be stored and
   * retrieved as UTC values (PostgreSQL `timestamptz` columns are always UTC).
   * `date` defaults to `new Date()` which is always UTC-based in Node.js.
   * Using `.getTime()` for explicit numeric comparison avoids any implicit
   * Date coercion that could mask a timezone mismatch.
   */
  isInSuppressionWindow(date: Date = new Date()): boolean {
    if (!this.suppressionWindows?.length) return false;

    const nowMs = date.getTime();
    return this.suppressionWindows.some(
      w => nowMs >= w.startTime.getTime() && nowMs <= w.endTime.getTime()
    );
  }

  appliesTo(severity: AlertSeverity, ruleId?: string, farmId?: string): boolean {
    // Check severity match
    if (!this.severity.includes(severity)) return false;

    // Check rule filter
    if (this.ruleIds?.length && ruleId && !this.ruleIds.includes(ruleId)) {
      return false;
    }

    // Check farm filter
    if (this.farmIds?.length && farmId && !this.farmIds.includes(farmId)) {
      return false;
    }

    return true;
  }
}
