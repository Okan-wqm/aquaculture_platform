import {
  ALERT_ESCALATED_TEXT_LIMITS,
  ALERT_RECIPIENT_QUERY_MAX_USER_IDS,
  UUID_PATTERN,
  createBaseEvent,
  type AlertDeliveryChannel,
  type AlertEscalatedEvent,
  type AlertRecipientRole,
} from '@platform/event-contracts';

import { AlertIncident } from '../database/entities/alert-incident.entity';
import {
  EscalationLevel,
  EscalationRecipientScope,
  NotificationChannel,
} from '../database/entities/escalation-policy.entity';

/**
 * Policy channels notification-service can serve. The rest (SMS, Slack, Teams,
 * webhook, PagerDuty) have no recipient directory behind them today; they are
 * reported back to the caller, never shipped as a channel nobody can deliver.
 */
const DELIVERABLE_CHANNELS: Partial<Record<NotificationChannel, AlertDeliveryChannel>> = {
  [NotificationChannel.PUSH]: 'push',
  [NotificationChannel.EMAIL]: 'email',
};

export interface AlertEscalatedBuildInput {
  incident: AlertIncident;
  level: number;
  levelConfig: EscalationLevel;
  /** Explicit user ids of the level (+ current on-call). */
  targetUsers: string[];
  /** The rendered escalation message. */
  reason: string;
}

export interface AlertEscalatedBuild {
  event: AlertEscalatedEvent;
  /** Policy channels dropped because no delivery path exists for them. */
  undeliverableChannels: NotificationChannel[];
  /** Explicit ids beyond the contract cap, dropped (the policy DTO caps them too). */
  droppedUserIds: string[];
  /**
   * Explicit ids that are not user ids at all (free text in a policy or an
   * on-call row). They can name nobody, and shipping one would make the whole
   * event fail the delivery boundary — so they are dropped and reported.
   */
  malformedUserIds: string[];
}

const USER_ID = new RegExp(UUID_PATTERN);

/** Title the event carries when an incident's own title is blank (schema: non-empty). */
function titleOf(incident: AlertIncident): string {
  const title = incident.title.trim();
  return title.length > 0 ? title : `Alert incident ${incident.id}`;
}

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function rolesIn(level: EscalationLevel, scope: EscalationRecipientScope): AlertRecipientRole[] {
  return unique((level.notifyRoles ?? []).filter((t) => t.scope === scope).map((t) => t.role));
}

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Build the AlertEscalated hand-off for one executed escalation level.
 *
 * WHY pure (ALERT-CRITICAL-004): the event is enqueued on the SAME transaction
 * manager as the incident's escalation-level write, so the builder must do no
 * I/O. WHAT it guarantees: the event satisfies the event-contracts trust
 * boundary schema by construction — texts are cut to the contract limits,
 * channels are deduped and restricted to deliverable ones, and role targets are
 * flattened into the two scope arrays (flat event rule, ADR-006).
 */
export function buildAlertEscalatedEvent(input: AlertEscalatedBuildInput): AlertEscalatedBuild {
  const { incident, level, levelConfig, targetUsers, reason } = input;

  const undeliverableChannels: NotificationChannel[] = [];
  const channels: AlertDeliveryChannel[] = [];
  for (const channel of unique(levelConfig.channels)) {
    const deliverable = DELIVERABLE_CHANNELS[channel];
    if (deliverable) channels.push(deliverable);
    else undeliverableChannels.push(channel);
  }

  // INVARIANT: the built event passes checkAlertEscalatedEvent. If violated →
  // notification-service dead-letters it and the alarm pages nobody, so every
  // field is brought inside the contract here rather than trusted.
  const users = unique(targetUsers);
  const wellFormed = users.filter((id) => USER_ID.test(id));
  const malformedUserIds = users.filter((id) => !USER_ID.test(id));
  const escalatedTo = wellFormed.slice(0, ALERT_RECIPIENT_QUERY_MAX_USER_IDS);
  const title = titleOf(incident);

  const event: AlertEscalatedEvent = {
    ...createBaseEvent<AlertEscalatedEvent>('AlertEscalated', incident.tenantId, {
      aggregateId: incident.id,
      aggregateType: 'AlertIncident',
    }),
    alertId: incident.id,
    escalationLevel: level,
    escalatedTo,
    reason: cut(reason, ALERT_ESCALATED_TEXT_LIMITS.reason),
    ruleId: incident.ruleId,
    signalKey: incident.signalKey ?? null,
    title: cut(title, ALERT_ESCALATED_TEXT_LIMITS.title),
    description: cut(incident.description ?? title, ALERT_ESCALATED_TEXT_LIMITS.description),
    severity: incident.severity,
    channels,
    tenantWideRecipientRoles: rolesIn(levelConfig, EscalationRecipientScope.TENANT),
    siteRecipientRoles: rolesIn(levelConfig, EscalationRecipientScope.INCIDENT_SITE),
    siteId: incident.siteId ?? null,
  };

  return {
    event,
    undeliverableChannels,
    droppedUserIds: wellFormed.slice(ALERT_RECIPIENT_QUERY_MAX_USER_IDS),
    malformedUserIds,
  };
}
