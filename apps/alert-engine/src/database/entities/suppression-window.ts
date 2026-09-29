import type { ValueTransformer } from 'typeorm';

import { AlertSeverity } from './alert-rule.entity';

/**
 * The persisted shape of one suppression window (a `jsonb` array element).
 * Declared here, not on the GraphQL class, so this module has no decorator
 * dependency and the entity can import it without a cycle.
 */
export interface SuppressionWindowRecord {
  id: string;
  name: string;
  startTime: Date;
  endTime: Date;
  reason?: string;
  createdBy: string;
  /**
   * True only when a TENANT_ADMIN created the window. ALERT-3 / V-S1b-2: only
   * such a window may silence a HIGH alarm; CRITICAL is never silenced.
   */
  createdByTenantAdmin: boolean;
  isRecurring: boolean;
  recurringPattern?: string;
}

/** A window as a caller asks for it — id, creator and admin flag are stamped by the writer. */
export type NewSuppressionWindow = Omit<
  SuppressionWindowRecord,
  'id' | 'createdBy' | 'createdByTenantAdmin'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A jsonb timestamp (ISO string) or an in-memory Date → a valid Date, else null. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Rehydrate one stored window, or null when it cannot be read as a window.
 *
 * WHY (V-S1a-2d): the column is `jsonb`, so a stored `startTime` comes back as
 * an ISO STRING. The escalation check called `.getTime()` on it, which threw a
 * TypeError for every escalation of a policy that had any window at all — the
 * incident dead-lettered and nobody was paged. Every read now goes through this
 * function (the column transformer), so the entity only ever holds Dates.
 *
 * An entry that is not a readable window suppresses nothing: dropping it is the
 * fail-safe direction for an alarm (it pages instead of staying silent). A
 * window stored before `createdByTenantAdmin` existed reads as `false`, so it
 * can no longer silence a HIGH alarm.
 */
export function rehydrateSuppressionWindow(raw: unknown): SuppressionWindowRecord | null {
  if (!isRecord(raw)) return null;
  const startTime = toDate(raw['startTime']);
  const endTime = toDate(raw['endTime']);
  const id = raw['id'];
  const name = raw['name'];
  if (
    startTime === null ||
    endTime === null ||
    typeof id !== 'string' ||
    typeof name !== 'string'
  ) {
    return null;
  }
  return {
    id,
    name,
    startTime,
    endTime,
    reason: optionalString(raw['reason']),
    createdBy: optionalString(raw['createdBy']) ?? 'unknown',
    createdByTenantAdmin: raw['createdByTenantAdmin'] === true,
    isRecurring: raw['isRecurring'] === true,
    recurringPattern: optionalString(raw['recurringPattern']),
  };
}

/** Rehydrate the whole stored array (null/absent column → undefined). */
export function rehydrateSuppressionWindows(raw: unknown): SuppressionWindowRecord[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => rehydrateSuppressionWindow(entry))
    .filter((entry): entry is SuppressionWindowRecord => entry !== null);
}

/**
 * The `suppression_windows` column transformer — the ONE place stored windows
 * become objects. Writes go out as-is (JSON serializes Dates to ISO strings).
 */
export const SUPPRESSION_WINDOWS_TRANSFORMER: ValueTransformer = {
  to: (value: unknown): unknown => value,
  from: (value: unknown): SuppressionWindowRecord[] | undefined =>
    rehydrateSuppressionWindows(value),
};

/**
 * Does any window silence an alarm of `severity` at `at`? (ALERT-3, V-S1b-2)
 *
 *   - CRITICAL: never. A life-threatening condition pages in every window.
 *   - HIGH: only a window a TENANT_ADMIN created (the admin owns that risk;
 *     the decision is audit-logged when the window is created and when it
 *     silences an alarm).
 *   - anything lower: any active window.
 *
 * INVARIANT: a CRITICAL alarm is never suppressed by configuration. If
 * violated → a manager's maintenance window mutes a dissolved-oxygen crash.
 */
export function windowsSuppress(
  windows: readonly SuppressionWindowRecord[] | undefined,
  severity: AlertSeverity,
  at: Date,
): boolean {
  if (severity === AlertSeverity.CRITICAL || !windows || windows.length === 0) {
    return false;
  }
  const nowMs = at.getTime();
  return windows.some(
    (window) =>
      nowMs >= window.startTime.getTime() &&
      nowMs <= window.endTime.getTime() &&
      (severity !== AlertSeverity.HIGH || window.createdByTenantAdmin),
  );
}
