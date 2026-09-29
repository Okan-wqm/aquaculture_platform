import * as client from 'prom-client';

/**
 * Life-safety alarm delivery metric — the ONE counter an operator alerts on
 * when a farm alarm (critical water quality, mortality, stock-out) did not
 * take its normal path to a person (ALERT-CRITICAL-004, V-S1a-2/3/5, V-S1b-7).
 *
 * WHY a counter of its own: every degradation below used to end in a log line
 * at best — an incident with no matching policy was logged at `log` level, a
 * policy that resolved to nobody was acknowledged with an ERROR line. A log
 * line is not an alert. `infrastructure/monitoring/droplet/rules/
 * 60-dataflow-integrity.yml` pages on any increase of this series.
 *
 * Labels (bounded — `tenant_id` is deliberately NOT a label, cardinality):
 *   - service  : the emitting service;
 *   - reason   : {@link LifeSafetyAlarmDegradation};
 *   - severity : the alarm severity (six values).
 *
 * Registered on the default prom-client registry (the one every service's
 * /metrics endpoint exposes), register-or-reuse so a process that loads the
 * module twice does not trip the duplicate-registration error.
 */
export const LIFE_SAFETY_ALARM_DEGRADED_METRIC = 'life_safety_alarm_degraded_total';

export type LifeSafetyAlarmDegradation =
  /** CRITICAL/HIGH incident matched no escalation policy → hard floor used. */
  | 'no_policy_match'
  /** Policy targets resolved to nobody → widened to every active TENANT_ADMIN. */
  | 'widened_to_tenant_admins'
  /** Nobody at all could be resolved — the alarm is dead-lettered, not acked. */
  | 'no_recipients';

function degradedCounter(): client.Counter<string> {
  const existing = client.register.getSingleMetric(LIFE_SAFETY_ALARM_DEGRADED_METRIC);
  if (existing instanceof client.Counter) {
    return existing;
  }
  return new client.Counter({
    name: LIFE_SAFETY_ALARM_DEGRADED_METRIC,
    help: 'Life-safety alarms that left their normal delivery path (floor used or undeliverable)',
    labelNames: ['service', 'reason', 'severity'],
  });
}

/** Count one degraded life-safety alarm. */
export function recordLifeSafetyAlarmDegraded(
  service: string,
  reason: LifeSafetyAlarmDegradation,
  severity: string,
): void {
  degradedCounter().inc({ service, reason, severity });
}
