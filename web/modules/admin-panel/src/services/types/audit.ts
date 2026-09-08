/**
 * Audit log domain types
 */

import type { ApiSchema } from '../contract';

/**
 * One `admin.audit_logs` row, as `GET /admin/audit` returns it.
 *
 * Hand-declared until now, with two drifts the index signature it also carried
 * (`[key: string]: unknown`) made invisible to the compiler:
 *
 *  - `severity` was `low | medium | high | critical`. The column is
 *    `AuditSeverity` — `info | warning | critical` (ADMIN-HIGH-112). Three of
 *    the four filter values matched no row that can exist, and a `warning` row
 *    fell through the badge map to render grey, like a routine one.
 *  - `metadata` does not exist; the column is `details`.
 *
 * Sourced from the contract, both are compile errors instead.
 */
export type AuditLog = ApiSchema<'AuditLog'>;

export interface AuditLogStats {
  totalLogs: number;
  last24Hours: number;
  bySeverity: Array<{ severity: string; count: number }>;
  byAction: Array<{ action: string; count: number }>;
  topUsers: Array<{ userId: string; email: string; count: number }>;
}
