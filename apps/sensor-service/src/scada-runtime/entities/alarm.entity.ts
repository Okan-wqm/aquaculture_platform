/**
 * Alarm Entities
 *
 * Plain TypeScript classes representing the two alarm persistence tables:
 *  - ScadaAlarm:          Active (live) alarm instances.
 *  - ScadaAlarmChronicle: Historical alarm records (append-only chronicle).
 *
 * These are used by AlarmStorageService for Prisma raw-SQL or ORM upserts.
 * The class shape mirrors the AlarmInstance interface from scada-runtime.types.ts
 * while adding persistence-specific fields (id as UUID string, DB timestamps).
 */

import type { AlarmSeverity, AlarmRuntimeStatus } from '../../../../../../web/modules/sensor-module/src/types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Active Alarm                                                        */
/* ------------------------------------------------------------------ */

/**
 * ScadaAlarm — represents a currently active or recently cleared alarm.
 * Maps to the `scada_alarms` table.
 *
 * Lifecycle: created on ACTIVE, updated on CLEARED/ACKNOWLEDGED, deleted
 * once the alarm fully resolves and is moved to chronicle.
 */
export class ScadaAlarm {
  /** UUID primary key. */
  id!: string;

  /** FK to the alarm rule that produced this instance. */
  ruleId!: string;

  /** Human-readable rule name (denormalised for fast display). */
  ruleName!: string;

  /** Alarm severity level. */
  severity!: AlarmSeverity;

  /** Current state-machine status. */
  status!: AlarmRuntimeStatus;

  /** Evaluated alarm message (may include interpolated tag values). */
  message!: string;

  /** Optional grouping label (e.g. 'Pond 3', 'HVAC'). */
  group?: string;

  /** Tag value at the moment the alarm fired (or most recent evaluation). */
  currentValue!: number;

  /** Threshold value from the alarm rule. */
  threshold!: number;

  /** Unix ms when the alarm condition first became true (ACTIVE). */
  onTime!: number;

  /** Unix ms when the alarm condition cleared (CLEARED). Null if still active. */
  offTime?: number;

  /** Unix ms when the alarm was acknowledged (ACKNOWLEDGED). Null if not yet acked. */
  ackTime?: number;

  /** User ID of the operator who acknowledged this alarm. */
  ackUserId?: string;

  /** Optional custom display colors from the alarm rule definition. */
  colors?: { background: string; text: string };
}

/* ------------------------------------------------------------------ */
/*  Alarm Chronicle (History)                                          */
/* ------------------------------------------------------------------ */

/**
 * ScadaAlarmChronicle — immutable historical record of a completed alarm cycle.
 * Maps to the `scada_alarm_chronicle` table.
 *
 * Records are appended when an alarm transitions to ACKNOWLEDGED (for ackActive/
 * ackPassive modes) or when an alarm in 'float' mode returns to INACTIVE.
 * Records are never updated after insertion.
 */
export class ScadaAlarmChronicle {
  /** UUID primary key. */
  id!: string;

  /** FK to the alarm rule. */
  ruleId!: string;

  /** Human-readable rule name (denormalised). */
  ruleName!: string;

  /** Alarm severity level. */
  severity!: AlarmSeverity;

  /** Final status when the alarm was archived (cleared | acknowledged). */
  status!: AlarmRuntimeStatus;

  /** Alarm message. */
  message!: string;

  /** Alarm group. */
  group?: string;

  /** Tag value at time of alarm activation. */
  currentValue!: number;

  /** Threshold value from the rule. */
  threshold!: number;

  /** Unix ms when the alarm activated. */
  onTime!: number;

  /** Unix ms when the alarm condition cleared. */
  offTime?: number;

  /** Unix ms when the alarm was acknowledged. */
  ackTime?: number;

  /** User ID of the acknowledging operator. */
  ackUserId?: string;
}
