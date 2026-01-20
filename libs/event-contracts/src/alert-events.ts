import { BaseEvent } from './base-event';

/**
 * Alert Triggered Event
 * Published when an alert condition is met
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
  triggeringData: {
    sensorId?: string;
    farmId?: string;
    pondId?: string;
    parameter?: string;
    value?: number;
    threshold?: number;
    [key: string]: unknown;
  };
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
 * Alert Rule Created Event
 */
export interface AlertRuleCreatedEvent extends BaseEvent {
  eventType: 'AlertRuleCreated';
  ruleId: string;
  name: string;
  conditions: unknown[];
  notificationChannels: string[];
}

/**
 * Alert Rule Updated Event
 */
export interface AlertRuleUpdatedEvent extends BaseEvent {
  eventType: 'AlertRuleUpdated';
  ruleId: string;
  changes: Record<string, unknown>;
}
