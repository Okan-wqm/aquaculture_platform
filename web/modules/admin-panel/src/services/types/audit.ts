/**
 * Audit log domain types
 */

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
// Imported so shapes below can reference them; re-exported so import sites
// are unchanged.
import type {
  AuditLog,
} from './generated/admin-contracts';

export type {
  AuditLog,
};

export interface AuditLogStats {
  totalLogs: number;
  last24Hours: number;
  bySeverity: Array<{ severity: string; count: number }>;
  byAction: Array<{ action: string; count: number }>;
  topUsers: Array<{ userId: string; email: string; count: number }>;
}
