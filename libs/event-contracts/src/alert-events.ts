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
  /** The AlertHistory row of this trigger. */
  alertId: string;
  /**
   * The AlertIncident this trigger opened or joined (v3, decision 7). It is
   * the delivery key of the rule's EXTERNAL targets (raw e-mail, SMS,
   * webhook): notification-service sends each target once per incident, so a
   * later trigger that only bumps the open incident sends nothing new. People
   * (user-id recipients) are never paged from this event — the incident's
   * escalation (`AlertEscalated`) pages them.
   */
  incidentId: string;
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
  acknowledgedAt: string;
  notes?: string;
}

/**
 * Alert Resolved Event
 */
export interface AlertResolvedEvent extends BaseEvent {
  eventType: 'AlertResolved';
  alertId: string;
  resolvedBy?: string;
  resolvedAt: string;
  resolution?: string;
  autoResolved: boolean;
}

/**
 * Channels notification-service can deliver an escalated alarm through
 * (ALERT-CRITICAL-004). A policy may list more (SMS, Slack, PagerDuty…); only
 * these have a recipient directory behind them, so the producer maps the rest
 * out and logs them instead of shipping a channel nobody can serve.
 */
export const ALERT_DELIVERY_CHANNELS = ['push', 'email'] as const;
export type AlertDeliveryChannel = (typeof ALERT_DELIVERY_CHANNELS)[number];

/**
 * Tenant roles an escalation level can target — the auth-service `users.role`
 * codes a tenant user can hold. SUPER_ADMIN is deliberately absent: a platform
 * operator is never a tenant alarm recipient.
 */
export const ALERT_RECIPIENT_ROLES = ['TENANT_ADMIN', 'MODULE_MANAGER', 'MODULE_USER'] as const;
export type AlertRecipientRole = (typeof ALERT_RECIPIENT_ROLES)[number];

/**
 * Alert Escalated Event — the ONLY hand-off from the alert ladder to delivery.
 *
 * WHY the delivery fields (ALERT-CRITICAL-004): the event used to carry only
 * `escalatedTo` user ids and a reason, and nothing consumed it, so a farm-signal
 * incident reached nobody. It now carries everything notification-service needs
 * to reach a person without reading alert-engine's database: what happened
 * (title/description/severity), how (channels) and to whom — explicit user ids
 * PLUS role targets that notification-service expands through auth-service (the
 * user directory's owner), tenant-wide or narrowed to `siteId`.
 *
 * Flat by rule (ADR-006): role targets are two string arrays, not nested objects.
 * `siteId: null` means the incident has no site; site-scoped roles then widen to
 * the whole tenant so a missing site can never silence an alarm.
 */
/**
 * Wire versions of the two alarm hand-offs (V-S1a-11). A producer stamps these
 * — never the `createBaseEvent` default of 1, which the timestamp upcaster
 * turns into 2, the version the pre-delivery AlertEscalated shape carries.
 */
export const ALERT_ESCALATED_EVENT_VERSION = 3;
export const ALERT_TRIGGERED_EVENT_VERSION = 3;

export interface AlertEscalatedEvent extends BaseEvent {
  eventType: 'AlertEscalated';
  /** The escalated AlertIncident id. */
  alertId: string;
  escalationLevel: number;
  /** Explicit recipient user ids (policy `notifyUserIds` + current on-call). */
  escalatedTo: string[];
  reason: string;
  /**
   * The incident's identity — exactly one is non-null (ALERT-CRITICAL-009):
   * the alert rule of a rule-driven incident, or the `signalKey()` of a
   * farm-signal incident.
   */
  ruleId: string | null;
  signalKey: string | null;
  title: string;
  description: string;
  severity: AlertSeverityLevel;
  channels: AlertDeliveryChannel[];
  /** Roles whose every active holder in the tenant is a recipient. */
  tenantWideRecipientRoles: AlertRecipientRole[];
  /** Roles whose holders assigned to `siteId` are recipients. */
  siteRecipientRoles: AlertRecipientRole[];
  siteId: string | null;
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
