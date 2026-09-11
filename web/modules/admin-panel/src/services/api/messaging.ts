/**
 * Messaging Admin API
 *
 * REST client for messaging admin endpoints:
 *   - GET  /messaging/compliance/stats
 *   - GET  /messaging/compliance/legal-holds
 *   - POST /messaging/compliance/legal-holds
 *   - DELETE /messaging/compliance/legal-holds/:id
 *   - GET  /messaging/retention/policies
 *   - PUT  /messaging/retention/policies/:id
 *   - GET  /messaging/monitoring/stats
 *   - GET  /messaging/tenants
 *   - GET  /messaging/audit
 *
 * @see ADR-012 Phase 3
 * @see ADMIN-HIGH-009 (monitoring stats + tenants overview)
 */

import { apiFetch, buildQueryString } from '../http-client';
import type { PaginatedResult } from '../types';
import type { MessagingMonitoringStats, MessagingTenantsOverview } from '../types/messaging';

// ============================================================================
// Types -- Compliance
// ============================================================================

/** Aggregated compliance statistics returned by GET /messaging/compliance/stats */
export interface ComplianceStats {
  messagesUnderLegalHold: number;
  pendingRetentionCleanup: number;
  activeExports: number;
  complianceScore: number;
  activeHoldsCount: number;
  retentionPoliciesCount: number;
  auditEntriesCount: number;
}

/** Legal hold record returned by GET /messaging/compliance/legal-holds */
export interface LegalHold {
  id: string;
  tenantId: string;
  tenantName: string;
  channelId: string | null;
  channelName: string | null;
  reason: string;
  startedBy: string;
  startedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  isActive: boolean;
}

/** Payload for POST /messaging/compliance/legal-holds */
export interface CreateLegalHoldInput {
  tenantId: string;
  channelId?: string | null;
  reason: string;
  legalMatterId: string;
  legalMatterDescription?: string;
  expiresAt?: string;
}

// ============================================================================
// Types -- Retention
// ============================================================================

export interface RetentionPolicy {
  id: string;
  tenantId: string;
  tenantName: string;
  defaultRetention: '90d' | '1y' | '3y' | 'indefinite';
  channelOverridesCount: number;
  lastCleanup: string | null;
  nextCleanup: string;
  messagesCount: number;
  expiredCount: number;
}

export interface RetentionPolicyUpdate {
  defaultRetention: string;
  applyToAll: boolean;
}

// ============================================================================
// Types -- Audit
// ============================================================================

export interface MessagingAuditEntry {
  id: string;
  timestamp: string;
  tenantId: string;
  tenantName: string;
  userId: string;
  userName: string;
  action: string;
  details: string;
  channelId?: string;
  messageId?: string;
}

export interface MessagingAuditFilters {
  tenantId?: string;
  userId?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

// ============================================================================
// Types -- Shared (used across compliance page sections)
// ============================================================================

export interface ExportRecord {
  id: string;
  tenantName: string;
  format: 'json' | 'csv';
  recordCount: number;
  status: 'pending' | 'completed' | 'failed';
  isUnderLegalHold: boolean;
  createdAt: string;
  downloadUrl?: string;
}

export interface RetentionBucket {
  label: string;
  tenantCount: number;
  color: string;
}

export interface DailyAuditData {
  date: string;
  count: number;
}

// ============================================================================
// Types -- Data Export
// ============================================================================

/** Result returned by POST /messaging/tenants/:id/export */
export interface ExportTriggerResult {
  jobId: string;
  status: string;
  format: string;
  recordCount: number;
  isUnderLegalHold: boolean;
  exportedAt: string;
}

// ============================================================================
// Types -- AI Personas
// ============================================================================

/** Persona definition returned by GET /messaging/personas */
export interface AiPersonaDefinition {
  /** Persona ID matching ai-service persona IDs. Null = general AI assistant. */
  id: string | null;
  /** Human-readable display name. */
  name: string;
  /** Short description of what the persona specializes in. */
  description: string;
  /** Icon identifier for frontend rendering (Lucide icon name). */
  icon: string;
  /** Theme color key for UI styling. */
  color: string;
  /** List of capability labels describing what the persona can do. */
  capabilities: string[];
}

// ============================================================================
// API
// ============================================================================

export const messagingApi = {
  // ── Compliance Stats ──

  /**
   * Fetch compliance statistics for ONE tenant.
   *
   * `tenantId` is REQUIRED (ADMIN-CRITICAL-147). It used to be optional, and
   * the docblock promised that omitting it returned platform-wide stats — a
   * mode `MessagingAdminController.getComplianceStats` has never had. Its
   * parameter is `@TenantParam('query') tenantId: string` with the default
   * `optional: false`, so `VerifiedTenantPipe` answers a request without one
   * with `BadRequestException('tenantId is required')`. Every call the panel
   * made therefore 400'd, and the compliance page rendered its
   * `complianceScore: 100` placeholder instead. Requiring the argument makes
   * that call impossible to write.
   */
  getComplianceStats: (tenantId: string, signal?: AbortSignal): Promise<ComplianceStats> =>
    apiFetch<ComplianceStats>(
      `/messaging/compliance/stats?${buildQueryString({ tenantId })}`,
      { signal },
    ),

  // ── Legal Holds ──

  /**
   * Fetch the legal holds of ONE tenant.
   *
   * `tenantId` is REQUIRED, for the same reason as the stats read above: the
   * route rejects a request without one, and legal holds are held per tenant.
   */
  getLegalHolds: (tenantId: string, signal?: AbortSignal): Promise<LegalHold[]> =>
    apiFetch<LegalHold[]>(
      `/messaging/compliance/legal-holds?${buildQueryString({ tenantId })}`,
      { signal },
    ),

  /** Create a new legal hold on messaging data. */
  createLegalHold: (input: CreateLegalHoldInput): Promise<LegalHold> =>
    apiFetch<LegalHold>('/messaging/compliance/legal-holds', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * Release (deactivate) an existing legal hold.
   * @param holdId - UUID of the legal hold to release
   * @param tenantId - Tenant that owns the hold
   */
  releaseLegalHold: (holdId: string, tenantId: string): Promise<void> =>
    apiFetch<void>(
      `/messaging/compliance/legal-holds/${holdId}?${buildQueryString({ tenantId })}`,
      { method: 'DELETE' },
    ),

  // ── Retention ──

  /** Fetch all tenant retention policies */
  getRetentionPolicies: (): Promise<RetentionPolicy[]> =>
    apiFetch<RetentionPolicy[]>('/messaging/retention/policies'),

  /** Update a single tenant retention policy */
  updateRetentionPolicy: (
    policyId: string,
    update: RetentionPolicyUpdate,
  ): Promise<RetentionPolicy> =>
    apiFetch<RetentionPolicy>(`/messaging/retention/policies/${policyId}`, {
      method: 'PUT',
      body: JSON.stringify(update),
    }),

  // ── Monitoring ──

  /**
   * Platform-wide messaging monitoring statistics: message volume totals
   * (24h / 7d / all-time), active channels, the per-tenant breakdown and
   * transactional-outbox health. Cached backend-side for 60 seconds.
   */
  getMonitoringStats: (): Promise<MessagingMonitoringStats> =>
    apiFetch<MessagingMonitoringStats>('/messaging/monitoring/stats'),

  // ── Tenant Overview ──

  /**
   * Per-tenant messaging overview (message counts 24h / 7d / all-time plus
   * active channel counts), sorted by 24h volume descending. Cached
   * backend-side for 60 seconds.
   */
  getTenantsOverview: (): Promise<MessagingTenantsOverview> =>
    apiFetch<MessagingTenantsOverview>('/messaging/tenants'),

  // ── Audit ──

  /** Query messaging audit log with pagination and filters */
  getAuditLog: (
    filters?: MessagingAuditFilters,
  ): Promise<PaginatedResult<MessagingAuditEntry>> =>
    apiFetch<PaginatedResult<MessagingAuditEntry>>(
      `/messaging/audit?${buildQueryString({ ...(filters || {}) })}`,
    ),

  // ── Data Export ──

  /**
   * Trigger a data export for a specific tenant.
   * @param tenantId - UUID of the tenant to export
   * @param format - Export format ('csv' or 'json'), defaults to 'json'
   */
  triggerExport: (
    tenantId: string,
    format: 'csv' | 'json' = 'json',
  ): Promise<ExportTriggerResult> =>
    apiFetch<ExportTriggerResult>(`/messaging/tenants/${tenantId}/export`, {
      method: 'POST',
      body: JSON.stringify({ format }),
    }),

  // ── AI Personas ──

  /**
   * Fetch AI persona definitions for a tenant.
   * Returns the list of available personas from the backend registry.
   * @param tenantId - UUID of the tenant
   */
  getPersonas: (tenantId: string): Promise<AiPersonaDefinition[]> =>
    apiFetch<AiPersonaDefinition[]>(
      `/messaging/personas?${buildQueryString({ tenantId })}`,
    ),
};
