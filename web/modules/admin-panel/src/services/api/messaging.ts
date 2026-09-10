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

/**
 * One `messaging.retention_policies` row (ADMIN-CRITICAL-151).
 *
 * The previous declaration had NINE fields, seven of them invented:
 * `tenantName`, `channelOverridesCount`, `lastCleanup`, `nextCleanup`,
 * `messagesCount`, `expiredCount`, and `defaultRetention` as one of four
 * labels — `'90d' | '1y' | '3y' | 'indefinite'` — when the wire carries a
 * NUMBER OF DAYS. The table rendered three of the invented counts through
 * `.toLocaleString()`, so the first row that ever arrived would have thrown.
 */
export interface RetentionPolicy {
  id: string;
  tenantId: string;
  /** `null` is the tenant's default window; a channel id is an override. */
  channelId: string | null;
  /** `-1` is indefinite: the nightly cleanup skips the policy. */
  retentionDays: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What `PUT /messaging/retention/policies/:tenantId` accepts.
 *
 * The previous shape was `{defaultRetention: string, applyToAll: boolean}` —
 * neither key exists on `UpdateRetentionPolicyDto`, and the platform's
 * ValidationPipe runs `forbidNonWhitelisted: true`, so every save was refused
 * twice over: two unknown properties, and no `retentionDays`.
 */
export interface RetentionPolicyUpdate {
  /** Omit or pass null for the tenant default; a channel id sets an override. */
  readonly channelId?: string | null;
  /** -1 for indefinite, otherwise 1–3650. Never 0. */
  readonly retentionDays: number;
}

// ============================================================================
// Types -- Audit
// ============================================================================

/**
 * Every action `ComplianceAction` can record, in
 * `apps/messaging-service/src/compliance/entities/compliance-audit-log.entity.ts`
 * (ADMIN-CRITICAL-150).
 *
 * Declared here rather than derived, because the enum belongs to
 * messaging-service and reaches admin-api only as a NATS reply — nothing in
 * admin's OpenAPI carries it, and admin-api may not import another service's
 * source. So this list is pinned to the entity by
 * `tests/invariants/messaging-compliance-action-parity.spec.ts` instead: the
 * two must be equal, in both directions.
 *
 * The page's own hand-written vocabulary was `send`, `edit`, `delete`,
 * `create_channel`, `join_channel`, `leave_channel`, `upload_file` — SEVEN
 * values, not one of which the column can hold. Every action filter therefore
 * returned nothing, permanently, and the four an auditor actually looks for
 * (`message_export`, `data_anonymize`, `retention_set`, `legal_hold_toggle`)
 * were not offered at all.
 */
export const MESSAGING_COMPLIANCE_ACTIONS = [
  'message_send',
  'message_edit',
  'message_delete',
  'channel_create',
  'channel_archive',
  'member_add',
  'member_remove',
  'message_export',
  'data_anonymize',
  'retention_set',
  'legal_hold_toggle',
] as const;

export type MessagingComplianceAction = (typeof MESSAGING_COMPLIANCE_ACTIONS)[number];

/**
 * One `messaging.compliance_audit_logs` row, as the audit route returns it
 * (ADMIN-CRITICAL-150).
 *
 * The previous declaration invented five fields and mistyped a sixth:
 * `timestamp` (the column is `createdAt`, so the page rendered
 * `Invalid Date`), `tenantName` and `userName` (absent — two blank columns),
 * `channelId` and `messageId` (absent; the row identifies its subject with
 * `resourceType` + `resourceId`, which the page never showed), and `details`
 * as a `string` when it is `jsonb | null` — so the cell rendered
 * `[object Object]` and the CSV export called `.replace` on an object and
 * THREW. `ipAddress` and `userAgent`, the two fields that say where an action
 * came from on a forensic surface, were missing entirely.
 */
export interface MessagingAuditEntry {
  id: string;
  tenantId: string;
  userId: string;
  action: MessagingComplianceAction;
  resourceType: string;
  resourceId: string;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

/**
 * One page of the audit log, as the route returns it.
 *
 * CURSOR-paginated, and it was typed as `PaginatedResult<T>` — an offset page
 * with a `data` array. The response has `items`, so `result.data` was
 * `undefined` and the page crashed on the first render that got past the 400.
 */
export interface MessagingAuditPage {
  items: MessagingAuditEntry[];
  hasMore: boolean;
  cursor: string | null;
  totalCount: number;
}

/**
 * What `GET /messaging/audit` accepts.
 *
 * `tenantId` is REQUIRED — the route declares
 * `@TenantParam('query') tenantId: string` and refuses a request without one
 * (ADMIN-HIGH-149 made the contract say so). `page` and `pageSize` were sent
 * and are not parameters this route has: it takes `limit` and `cursor`, so
 * every "page" returned the same first rows and the pager moved nothing.
 */
export interface MessagingAuditFilters {
  readonly tenantId: string;
  readonly userId?: string;
  readonly action?: MessagingComplianceAction;
  readonly resourceType?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly limit?: number;
  readonly cursor?: string;
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
  /**
   * The tenant's retention policies: its default, plus one row per channel
   * override.
   *
   * `tenantId` is REQUIRED — the route declares `@TenantParam('query')` and
   * refuses a request without one (ADMIN-CRITICAL-151, third instance of
   * ADMIN-HIGH-149's consequence).
   */
  getRetentionPolicies: (tenantId: string, signal?: AbortSignal): Promise<RetentionPolicy[]> =>
    apiFetch<RetentionPolicy[]>(
      `/messaging/retention/policies?${buildQueryString({ tenantId })}`,
      { signal },
    ),

  /**
   * Set the tenant's default window, or one channel's override.
   *
   * The path parameter is the TENANT id — the route reads it through
   * `@TenantParam('param', { key: 'id' })` and verifies it against
   * `auth.tenants`. The page used to pass the POLICY id, so even a
   * well-formed body answered `Tenant <policy-uuid> not found`.
   */
  updateRetentionPolicy: (
    tenantId: string,
    update: RetentionPolicyUpdate,
  ): Promise<RetentionPolicy> =>
    apiFetch<RetentionPolicy>(`/messaging/retention/policies/${tenantId}`, {
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
    filters: MessagingAuditFilters,
    signal?: AbortSignal,
  ): Promise<MessagingAuditPage> =>
    apiFetch<MessagingAuditPage>(`/messaging/audit?${buildQueryString({ ...filters })}`, {
      signal,
    }),

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
