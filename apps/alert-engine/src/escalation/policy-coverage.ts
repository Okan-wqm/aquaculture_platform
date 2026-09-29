import { UUID_PATTERN } from '@platform/event-contracts';

import { AlertSeverity } from '../database/entities/alert-rule.entity';
import type {
  EscalationLevel,
  EscalationPolicy,
  OnCallSchedule,
} from '../database/entities/escalation-policy.entity';

/**
 * Severities that must always reach a person (ALERT-CRITICAL-004, V-S1a-2,
 * V-S1b-2): a critical water-quality excursion, a mortality spike, a stock-out.
 */
export const LIFE_SAFETY_SEVERITIES: readonly AlertSeverity[] = [
  AlertSeverity.CRITICAL,
  AlertSeverity.HIGH,
];

export function isLifeSafetySeverity(severity: AlertSeverity): boolean {
  return LIFE_SAFETY_SEVERITIES.includes(severity);
}

const USER_ID = new RegExp(UUID_PATTERN);

/** A level names somebody the delivery side can actually resolve to a person. */
export function levelHasResolvableTarget(
  level: EscalationLevel,
  onCallSchedule: readonly OnCallSchedule[] | undefined,
): boolean {
  if ((level.notifyRoles ?? []).length > 0) return true;
  if (level.notifyUserIds.some((id) => USER_ID.test(id))) return true;
  return (onCallSchedule ?? []).some((entry) => USER_ID.test(entry.userId));
}

/** The policy fields coverage depends on — a prospective (unsaved) state qualifies. */
export type CoveragePolicyState = Pick<
  EscalationPolicy,
  'isActive' | 'severity' | 'levels' | 'onCallSchedule' | 'ruleIds' | 'farmIds'
>;

/**
 * Does this policy page somebody for EVERY incident of `severity`? It must be
 * active, list the severity, carry no rule/farm filter (a filtered policy
 * covers only some incidents) and have a level 1 with a resolvable target.
 */
export function coversSeverity(policy: CoveragePolicyState, severity: AlertSeverity): boolean {
  if (!policy.isActive || !policy.severity.includes(severity)) return false;
  if ((policy.ruleIds ?? []).length > 0 || (policy.farmIds ?? []).length > 0) return false;
  const first = policy.levels.find((level) => level.level === 1);
  return first !== undefined && levelHasResolvableTarget(first, policy.onCallSchedule);
}

/**
 * The life-safety severities the tenant's policy set would leave uncovered.
 *
 * INVARIANT (V-S1a-2, V-S1b-2): after every policy write, the tenant's ACTIVE
 * policies cover CRITICAL and HIGH with a resolvable target. Every write path
 * (create, update — with or without `levels` —, delete, deactivate, default
 * change, on-call change) evaluates the prospective set with this function and
 * refuses the write when it returns anything. If violated → a tenant edit
 * silently stops critical alarms from paging anyone.
 */
export function missingLifeSafetyCoverage(
  policies: readonly CoveragePolicyState[],
): AlertSeverity[] {
  return LIFE_SAFETY_SEVERITIES.filter(
    (severity) => !policies.some((policy) => coversSeverity(policy, severity)),
  );
}
