import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import * as crypto from 'crypto';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { AlertRule, AlertSeverity } from './alert-rule.entity';

/**
 * Incident status lifecycle
 */
export enum IncidentStatus {
  NEW = 'NEW',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  INVESTIGATING = 'INVESTIGATING',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
  SUPPRESSED = 'SUPPRESSED',
}

registerEnumType(IncidentStatus, {
  name: 'IncidentStatus',
  description: 'Status of an alert incident',
});

/**
 * Timeline event types
 */
export enum TimelineEventType {
  CREATED = 'CREATED',
  STATUS_CHANGE = 'STATUS_CHANGE',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  ESCALATED = 'ESCALATED',
  ASSIGNED = 'ASSIGNED',
  COMMENT_ADDED = 'COMMENT_ADDED',
  NOTIFICATION_SENT = 'NOTIFICATION_SENT',
  RESOLVED = 'RESOLVED',
  REOPENED = 'REOPENED',
}

registerEnumType(TimelineEventType, {
  name: 'TimelineEventType',
  description: 'Type of timeline event',
});

/**
 * Timeline event structure
 */
@ObjectType('IncidentTimelineEvent')
export class IncidentTimelineEvent {
  @Field()
  id!: string;

  @Field(() => TimelineEventType)
  type!: TimelineEventType;

  @Field()
  timestamp!: Date;

  @Field({ nullable: true })
  userId?: string;

  @Field({ nullable: true })
  userEmail?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  metadata?: Record<string, unknown>;
}

/**
 * Alert Incident Entity
 * Represents an actual alert occurrence
 */
@ObjectType()
@Entity('alert_incidents')
@Index(['tenantId', 'status'])
@Index(['severity'])
@Index(['createdAt'])
export class AlertIncident {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'tenant_id', type: 'uuid' })
  @Index()
  tenantId!: string;

  @Field()
  @Column({ name: 'rule_id' })
  @Index()
  ruleId!: string;

  @Field()
  @Column({ name: 'title' })
  title!: string;

  @Field({ nullable: true })
  @Column({ name: 'description', type: 'text', nullable: true })
  description?: string;

  @Field(() => AlertSeverity)
  @Column({ name: 'severity', type: 'enum', enum: AlertSeverity, default: AlertSeverity.WARNING })
  severity!: AlertSeverity;

  @Field(() => IncidentStatus)
  @Column({ name: 'status', type: 'enum', enum: IncidentStatus, default: IncidentStatus.NEW })
  status!: IncidentStatus;

  @Field(() => Int)
  @Column({ name: 'risk_score', type: 'int', default: 0 })
  riskScore!: number;

  @Field(() => GraphQLJSON)
  @Column({ name: 'trigger_data', type: 'jsonb' })
  triggerData!: Record<string, unknown>;

  @Field({ nullable: true })
  @Column({ name: 'farm_id', nullable: true })
  farmId?: string;

  @Field({ nullable: true })
  @Column({ name: 'pond_id', nullable: true })
  pondId?: string;

  @Field({ nullable: true })
  @Column({ name: 'sensor_id', nullable: true })
  sensorId?: string;

  @Field({ nullable: true })
  @Column({ name: 'assigned_to', nullable: true })
  @Index()
  assignedTo?: string;

  @Field({ nullable: true })
  @Column({ name: 'acknowledged_by', nullable: true })
  acknowledgedBy?: string;

  @Field({ nullable: true })
  @Column({ name: 'acknowledged_at', nullable: true })
  acknowledgedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'resolved_by', nullable: true })
  resolvedBy?: string;

  @Field({ nullable: true })
  @Column({ name: 'resolved_at', nullable: true })
  resolvedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'resolution_notes', type: 'text', nullable: true })
  resolutionNotes?: string;

  @Field(() => Int)
  @Column({ name: 'escalation_level', type: 'int', default: 0 })
  escalationLevel!: number;

  @Field({ nullable: true })
  @Column({ name: 'last_escalated_at', nullable: true })
  lastEscalatedAt?: Date;

  @Field(() => [IncidentTimelineEvent])
  @Column({ name: 'timeline', type: 'jsonb', default: [] })
  timeline!: IncidentTimelineEvent[];

  @Field(() => [String])
  @Column({ name: 'related_incident_ids', type: 'jsonb', default: [] })
  relatedIncidentIds!: string[];

  @Field({ nullable: true })
  @Column({ name: 'parent_incident_id', nullable: true })
  parentIncidentId?: string;

  @Field(() => Int)
  @Column({ name: 'occurrence_count', type: 'int', default: 1 })
  occurrenceCount!: number;

  @Field({ nullable: true })
  @Column({ name: 'last_occurred_at', nullable: true })
  lastOccurredAt?: Date;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  // ============================================
  // Relations
  // ============================================

  @ManyToOne(() => AlertRule, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'rule_id' })
  rule?: AlertRule;

  // ============================================
  // Helper Methods
  // ============================================

  isOpen(): boolean {
    return [
      IncidentStatus.NEW,
      IncidentStatus.ACKNOWLEDGED,
      IncidentStatus.INVESTIGATING,
    ].includes(this.status);
  }

  isClosed(): boolean {
    return [
      IncidentStatus.RESOLVED,
      IncidentStatus.CLOSED,
      IncidentStatus.SUPPRESSED,
    ].includes(this.status);
  }

  canEscalate(): boolean {
    return this.isOpen() && this.status !== IncidentStatus.SUPPRESSED;
  }

  addTimelineEvent(event: Omit<IncidentTimelineEvent, 'id' | 'timestamp'> & { data?: Record<string, unknown> }): void {
    this.timeline.push({
      ...event,
      id: `evt-${crypto.randomUUID()}`,
      timestamp: new Date(),
      metadata: event.data,
    });
  }

  acknowledge(userId: string, message?: string): void {
    if (!this.isOpen()) {
      throw new Error('Cannot acknowledge a closed incident');
    }

    this.status = IncidentStatus.ACKNOWLEDGED;
    this.acknowledgedBy = userId;
    this.acknowledgedAt = new Date();

    this.addTimelineEvent({
      type: TimelineEventType.ACKNOWLEDGED,
      userId,
      description: message || `Incident acknowledged by ${userId}`,
    });
  }

  assign(userId: string, assignedBy?: string): void {
    this.assignedTo = userId;

    this.addTimelineEvent({
      type: TimelineEventType.ASSIGNED,
      userId: assignedBy || userId,
      description: `Incident assigned to ${userId}`,
      data: { assignedTo: userId },
    });
  }

  startInvestigation(userId: string): void {
    if (!this.isOpen()) {
      throw new Error('Cannot start investigation on a closed incident');
    }

    // Capture previous status BEFORE changing it
    const previousStatus = this.status;
    this.status = IncidentStatus.INVESTIGATING;

    this.addTimelineEvent({
      type: TimelineEventType.STATUS_CHANGE,
      userId,
      description: 'Investigation started',
      data: { previousStatus, newStatus: IncidentStatus.INVESTIGATING },
    });
  }

  resolve(userId: string, notes?: string): void {
    if (this.isClosed()) {
      throw new Error('Incident is already closed');
    }

    this.status = IncidentStatus.RESOLVED;
    this.resolvedBy = userId;
    this.resolvedAt = new Date();
    this.resolutionNotes = notes;

    this.addTimelineEvent({
      type: TimelineEventType.RESOLVED,
      userId,
      description: notes || 'Incident resolved',
    });
  }

  close(userId: string): void {
    if (this.status !== IncidentStatus.RESOLVED) {
      throw new Error('Can only close resolved incidents');
    }

    this.status = IncidentStatus.CLOSED;

    this.addTimelineEvent({
      type: TimelineEventType.STATUS_CHANGE,
      userId,
      description: 'Incident closed',
    });
  }

  reopen(userId: string, reason?: string): void {
    if (!this.isClosed()) {
      throw new Error('Can only reopen closed incidents');
    }

    this.status = IncidentStatus.NEW;
    this.resolvedBy = undefined;
    this.resolvedAt = undefined;
    this.resolutionNotes = undefined;

    this.addTimelineEvent({
      type: TimelineEventType.REOPENED,
      userId,
      description: reason || 'Incident reopened',
    });
  }

  suppress(userId: string, reason?: string): void {
    this.status = IncidentStatus.SUPPRESSED;

    this.addTimelineEvent({
      type: TimelineEventType.STATUS_CHANGE,
      userId,
      description: reason || 'Incident suppressed',
      data: { reason },
    });
  }

  escalate(level: number): void {
    if (!this.canEscalate()) {
      throw new Error('Incident cannot be escalated');
    }

    this.escalationLevel = level;
    this.lastEscalatedAt = new Date();

    this.addTimelineEvent({
      type: TimelineEventType.ESCALATED,
      description: `Escalated to level ${level}`,
      data: { level },
    });
  }

  addComment(userId: string, comment: string): void {
    this.addTimelineEvent({
      type: TimelineEventType.COMMENT_ADDED,
      userId,
      description: comment,
    });
  }

  /**
   * FARM-LOW-145: record another occurrence at the EVENT time, not the
   * processing wall-clock. Stamping `new Date()` here made lastOccurredAt jump
   * from event-time (on create) to ingest-time (on every bump), corrupting
   * recency/flapping analytics — the gap widened exactly under consumer lag.
   */
  recordOccurrence(occurredAt: Date): void {
    this.occurrenceCount++;
    this.lastOccurredAt = occurredAt;
  }

  linkIncident(incidentId: string): void {
    if (!this.relatedIncidentIds.includes(incidentId)) {
      this.relatedIncidentIds.push(incidentId);
    }
  }

  unlinkIncident(incidentId: string): void {
    this.relatedIncidentIds = this.relatedIncidentIds.filter(id => id !== incidentId);
  }

  getDuration(): number {
    if (this.resolvedAt) {
      return this.resolvedAt.getTime() - this.createdAt.getTime();
    }
    return Date.now() - this.createdAt.getTime();
  }

  getTimeToAcknowledge(): number | null {
    if (this.acknowledgedAt) {
      return this.acknowledgedAt.getTime() - this.createdAt.getTime();
    }
    return null;
  }

  getTimeToResolve(): number | null {
    if (this.resolvedAt) {
      return this.resolvedAt.getTime() - this.createdAt.getTime();
    }
    return null;
  }

  getLatestTimelineEvent(): IncidentTimelineEvent | undefined {
    return this.timeline[this.timeline.length - 1];
  }

  getTimelineEventsByType(type: TimelineEventType): IncidentTimelineEvent[] {
    return this.timeline.filter(e => e.type === type);
  }
}
