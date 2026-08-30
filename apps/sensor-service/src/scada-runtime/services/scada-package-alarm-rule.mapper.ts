/**
 * SCADA package → runtime alarm-rule mapper (RT-011 Faz 3).
 *
 * A published `scada_package.package_data` (ScadaPackageDocV2) stores alarm
 * rules in the BUILDER shape (`{ id, tag, condition, value, severity, message,
 * deadband?, delay? }`, see `libs/sensor-contracts/.../scada-package-doc.schema.ts`
 * ALARM_RULE_SCHEMA — condition/severity are free strings there). The evaluation
 * engine consumes the RUNTIME shape `AlarmRuleRuntime` (`scada-types`), which
 * renames three fields (`tag→tagId`, `value→threshold`, `delay→timeDelay`) and
 * additionally REQUIRES `name`, `ackMode`, `enabled`.
 *
 * This is the transform the activation bridge applies. It is pure + total: an
 * un-mappable rule (missing tag / un-parseable condition) is dropped with the
 * reason returned, never silently mis-evaluated.
 */
import type { AlarmRuleRuntime, AlarmSeverity } from '../scada-types';

/** The builder-shape alarm rule as stored in `package_data.alarmRules[]`. */
export interface StoredAlarmRule {
  id?: unknown;
  tag?: unknown;
  condition?: unknown;
  value?: unknown;
  severity?: unknown;
  message?: unknown;
  deadband?: unknown;
  delay?: unknown;
  // ScadaPackageDocV2 ALARM_RULE_SCHEMA is additionalProperties:true, so a
  // future package may already carry the runtime-only fields — honoured if present.
  name?: unknown;
  ackMode?: unknown;
  enabled?: unknown;
  group?: unknown;
}

type Operator = AlarmRuleRuntime['condition'];
type AckMode = AlarmRuleRuntime['ackMode'];

const OPERATORS: ReadonlySet<string> = new Set(['>', '<', '>=', '<=', '==', '!=']);

/** Word/alias forms the builder or an imported project might use. */
const CONDITION_ALIASES: Readonly<Record<string, Operator>> = {
  greater: '>',
  greaterthan: '>',
  gt: '>',
  above: '>',
  greaterorequal: '>=',
  greaterthanorequal: '>=',
  gte: '>=',
  atleast: '>=',
  less: '<',
  lessthan: '<',
  lt: '<',
  below: '<',
  lessorequal: '<=',
  lessthanorequal: '<=',
  lte: '<=',
  atmost: '<=',
  equal: '==',
  equals: '==',
  eq: '==',
  notequal: '!=',
  notequals: '!=',
  ne: '!=',
};

const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'warning', 'info']);
const SEVERITY_ALIASES: Readonly<Record<string, AlarmSeverity>> = {
  medium: 'warning',
  warn: 'warning',
  minor: 'warning',
  low: 'info',
  major: 'high',
  fatal: 'critical',
};

const ACK_MODES: ReadonlySet<string> = new Set(['float', 'ackActive', 'ackPassive']);

/** Normalise a free-string condition into a runtime operator, or null if unknown. */
export function normalizeCondition(raw: unknown): Operator | null {
  const t = String(raw ?? '').trim();
  if (OPERATORS.has(t)) return t as Operator;
  const key = t.toLowerCase().replace(/[\s_-]/g, '');
  return CONDITION_ALIASES[key] ?? null;
}

/** Normalise a free-string severity, defaulting to 'warning'. */
export function normalizeSeverity(raw: unknown): AlarmSeverity {
  const t = String(raw ?? '')
    .toLowerCase()
    .trim();
  if (SEVERITIES.has(t)) return t as AlarmSeverity;
  return SEVERITY_ALIASES[t] ?? 'warning';
}

/** A rule that could not be mapped, with the reason (for logging, never silent). */
export interface DroppedAlarmRule {
  id: string;
  reason: string;
}

export interface MappedAlarmRules {
  rules: AlarmRuleRuntime[];
  dropped: DroppedAlarmRule[];
}

/**
 * Map a package's stored alarm rules into runtime rules. Drops (with reason) any
 * rule missing a tag or carrying an un-parseable condition — an alarm the engine
 * cannot evaluate correctly must not run at all rather than mis-fire.
 */
export function mapPackageAlarmRules(stored: readonly StoredAlarmRule[]): MappedAlarmRules {
  const rules: AlarmRuleRuntime[] = [];
  const dropped: DroppedAlarmRule[] = [];

  for (const r of stored) {
    const id = String(r.id ?? '').trim();
    if (!id) {
      dropped.push({ id: '<no-id>', reason: 'missing id' });
      continue;
    }

    const tagId = String(r.tag ?? '').trim();
    if (!tagId) {
      dropped.push({ id, reason: 'missing tag' });
      continue;
    }

    const condition = normalizeCondition(r.condition);
    if (condition === null) {
      dropped.push({ id, reason: `un-parseable condition "${String(r.condition)}"` });
      continue;
    }

    const threshold = Number(r.value);
    if (!Number.isFinite(threshold)) {
      dropped.push({ id, reason: `non-numeric value "${String(r.value)}"` });
      continue;
    }

    const message = String(r.message ?? '').trim();
    const ackMode: AckMode = ACK_MODES.has(String(r.ackMode))
      ? (r.ackMode as AckMode)
      : 'ackActive';

    rules.push({
      id,
      // The runtime requires a name; the builder shape has none, so fall back to
      // the message, then a stable synthetic name.
      name: String(r.name ?? '').trim() || message || `Alarm ${id}`,
      tagId,
      condition,
      threshold,
      severity: normalizeSeverity(r.severity),
      message,
      deadband: Number.isFinite(Number(r.deadband)) ? Number(r.deadband) : undefined,
      timeDelay: Number.isFinite(Number(r.delay)) ? Number(r.delay) : undefined,
      group: typeof r.group === 'string' ? r.group : undefined,
      ackMode,
      // Builder rules carry no explicit enabled flag; a stored rule is active.
      enabled: r.enabled === undefined ? true : r.enabled !== false,
    });
  }

  return { rules, dropped };
}
