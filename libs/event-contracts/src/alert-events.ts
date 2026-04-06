import { BaseEvent } from './base-event';

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
  severity: 'info' | 'warning' | 'critical';
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
