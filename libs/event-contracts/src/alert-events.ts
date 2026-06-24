import { BaseEvent } from './base-event';

/**
 * Canonical alert severity levels.
 *
 * SSoT mirror of the alert-engine `AlertSeverity` enum
 * (`apps/alert-engine/src/database/entities/alert-rule.entity.ts`). The
 * alert-engine evaluates conditions against all six levels and emits the
 * matched level verbatim on `AlertTriggered`; the notification-service
 * dispatcher accepts the same six. The event-contract type MUST therefore
 * cover all six — a narrower `'info' | 'warning' | 'critical'` union would
 * make the interface lie about the runtime value and force a cast at the
 * (transactional) enqueue boundary.
 */
export type AlertSeverityLevel =
  | 'info'
  | 'low'
  | 'warning'
  | 'medium'
  | 'high'
  | 'critical';

/**
 * Alert Triggered Event (v2 — flat fields)
 * Published when an alert condition is met.
 *
 * ARCH-C01: trigger context is flat `triggerXxx` fields instead of nested `triggeringData`.
 * Legacy v1 events with nested `triggeringData` are upcasted by AlertTriggeredUpcaster.
 */
export interface AlertTriggeredEvent extends BaseEvent {
  eventType: 'AlertTriggered';
  alertId: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverityLevel;
  message: string;
  channels: string[];
  recipients: string[];
  triggerSensorId?: string;
  triggerFarmId?: string;
  triggerPondId?: string;
  triggerParameter?: string;
  triggerValue?: number;
  triggerThreshold?: number;
}

/**
 * Alert Acknowledged Event
 */
export interface AlertAcknowledgedEvent extends BaseEvent {
  eventType: 'AlertAcknowledged';
  alertId: string;
  acknowledgedBy: string;
  acknowledgedAt: Date;
  notes?: string;
}

/**
 * Alert Resolved Event
 */
export interface AlertResolvedEvent extends BaseEvent {
  eventType: 'AlertResolved';
  alertId: string;
  resolvedBy?: string;
  resolvedAt: Date;
  resolution?: string;
  autoResolved: boolean;
}

/**
 * Alert Escalated Event
 */
export interface AlertEscalatedEvent extends BaseEvent {
  eventType: 'AlertEscalated';
  alertId: string;
  escalationLevel: number;
  escalatedTo: string[];
  reason: string;
}

/**
 * Snapshot of an alert condition for event contracts.
 * Mirrors the relevant fields of AlertCondition from the alert-engine domain.
 */
export interface AlertConditionSnapshot {
  parameter: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
  threshold: number;
  severity: 'info' | 'warning' | 'critical';
}

/**
 * Alert Rule Created Event
 */
export interface AlertRuleCreatedEvent extends BaseEvent {
  eventType: 'AlertRuleCreated';
  ruleId: string;
  name: string;
  conditions: AlertConditionSnapshot[];
  notificationChannels: string[];
}

/**
 * Alert Rule Updated Event
 */
export interface AlertRuleUpdatedEvent extends BaseEvent {
  eventType: 'AlertRuleUpdated';
  ruleId: string;
  name?: string;
  conditions?: AlertConditionSnapshot[];
  notificationChannels?: string[];
}

// ==================== Type Union ====================

/**
 * Union type for all alert events
 */
export type AlertEvent =
  | AlertTriggeredEvent
  | AlertAcknowledgedEvent
  | AlertResolvedEvent
  | AlertEscalatedEvent
  | AlertRuleCreatedEvent
  | AlertRuleUpdatedEvent;
