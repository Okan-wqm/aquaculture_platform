import type { AlertRecipientRole } from './alert-events';

/**
 * notification-service → auth-service: expand an escalated alarm's targets into
 * tenant user ids (ALERT-CRITICAL-004).
 *
 * WHY here: auth-service owns users, roles and site assignments. The alarm's
 * policy names ROLES ("site managers + tenant admins"), not people, so the
 * delivery side must ask the directory's owner who those are right now —
 * copying a user directory into notification-service or alert-engine would be a
 * second, drifting source of truth.
 *
 * WHAT: a tenant-bound signed internal HTTP call (the same channel and identity
 * gate as `/internal/users/:id/pii`). The answer is user ids ONLY — no e-mail,
 * no names — so the surface can never become a profile oracle; contact details
 * are resolved per user through the existing PII endpoint.
 */
export function alertRecipientQueryPath(tenantId: string): string {
  return `/api/v1/internal/tenants/${encodeURIComponent(tenantId)}/alert-recipients`;
}

/** Explicit ids a single escalation level may name. */
export const ALERT_RECIPIENT_QUERY_MAX_USER_IDS = 50;

/** Upper bound on one expansion — beyond this an alarm is a broadcast, not a page. */
export const ALERT_RECIPIENT_RESULT_MAX_USER_IDS = 100;

export interface AlertRecipientQuery {
  /** Every ACTIVE tenant user holding one of these roles. */
  tenantWideRoles: AlertRecipientRole[];
  /**
   * ACTIVE tenant users holding one of these roles AND effectively assigned to
   * `siteId`. With `siteId: null` these widen to tenant-wide — a missing site
   * must never silence an alarm.
   */
  siteRoles: AlertRecipientRole[];
  siteId: string | null;
  /** Explicit ids; only ACTIVE members of the tenant survive. */
  userIds: string[];
}

export interface AlertRecipientResult {
  userIds: string[];
  /** True when the expansion exceeded the cap and was cut deterministically. */
  truncated: boolean;
}
