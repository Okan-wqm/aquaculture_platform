/**
 * Messaging Admin API
 *
 * REST client for messaging admin endpoints:
 *   - GET  /messaging/compliance/stats
 *   - GET  /messaging/compliance/legal-holds
 *   - POST /messaging/compliance/legal-holds
 *   - POST /messaging/compliance/legal-holds/:id/release-operations
 *   - POST /messaging/compliance/legal-hold-release-operations/:id/authorizations
 *   - GET  /messaging/compliance/legal-hold-release-operations
 *   - GET  /messaging/retention/policies
 *   - PUT  /messaging/retention/policies/:id
 *   - GET  /messaging/monitoring/stats  (returns 501 until real-time metrics infra)
 *   - GET  /messaging/audit
 *
 * @see ADR-012 Phase 3
 */

import type {
  AdminAuthorizeLegalHoldReleaseOperationV1,
  AdminCreateLegalHoldReleaseOperationV1,
  AdminLegalHoldReleaseOperationV1,
  AdminLegalHoldV1,
  AdminMessagingComplianceStatsV1,
  AdminMessagingAuditEntryV1,
  AdminMessagingAuditPageV1,
  AdminMessagingAuditQueryV1,
} from '@platform/admin-http-contracts';

import { apiFetch, buildQueryString } from '../http-client';

// ============================================================================
// Types -- Compliance
// ============================================================================

export type ComplianceStats = AdminMessagingComplianceStatsV1;
export type LegalHold = AdminLegalHoldV1;
export type LegalHoldReleaseOperation = AdminLegalHoldReleaseOperationV1;
export type CreateLegalHoldReleaseOperationInput = AdminCreateLegalHoldReleaseOperationV1;
export type AuthorizeLegalHoldReleaseOperationInput = AdminAuthorizeLegalHoldReleaseOperationV1;

/** Payload for POST /messaging/compliance/legal-holds */
export interface CreateLegalHoldInput {
  tenantId: string;
  channelId?: string | null;
  reason: string;
  legalMatterId: string;
  legalMatterDescription?: string;
  requestedBy?: string;
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

export type MessagingAuditEntry = AdminMessagingAuditEntryV1;

export type MessagingAuditFilters = Omit<AdminMessagingAuditQueryV1, 'cursor' | 'limit'> & {
  readonly cursor?: string | null;
  readonly limit?: number;
};

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
   * Fetch compliance statistics for one explicit tenant boundary.
   * @param tenantId - Required tenant UUID; platform-wide aggregation is forbidden.
   */
  getComplianceStats: (tenantId: string): Promise<ComplianceStats> =>
    apiFetch<ComplianceStats>(`/messaging/compliance/stats?${buildQueryString({ tenantId })}`),

  // ── Legal Holds ──

  /**
   * Fetch legal holds for one explicit tenant boundary.
   * @param tenantId - Required tenant UUID; cross-tenant listing is forbidden.
   */
  getLegalHolds: (tenantId: string): Promise<readonly LegalHold[]> =>
    apiFetch<LegalHold[]>(`/messaging/compliance/legal-holds?${buildQueryString({ tenantId })}`),

  /** Create a new legal hold on messaging data. */
  createLegalHold: (input: CreateLegalHoldInput): Promise<LegalHold> =>
    apiFetch<LegalHold>('/messaging/compliance/legal-holds', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  createLegalHoldReleaseOperation: (
    holdId: string,
    input: CreateLegalHoldReleaseOperationInput,
  ): Promise<LegalHoldReleaseOperation> =>
    apiFetch<LegalHoldReleaseOperation>(
      `/messaging/compliance/legal-holds/${holdId}/release-operations`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  authorizeLegalHoldReleaseOperation: (
    operationId: string,
    input: AuthorizeLegalHoldReleaseOperationInput,
  ): Promise<LegalHoldReleaseOperation> =>
    apiFetch<LegalHoldReleaseOperation>(
      `/messaging/compliance/legal-hold-release-operations/${operationId}/authorizations`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  getLegalHoldReleaseOperations: (
    tenantId: string,
  ): Promise<readonly LegalHoldReleaseOperation[]> =>
    apiFetch<LegalHoldReleaseOperation[]>(
      `/messaging/compliance/legal-hold-release-operations?${buildQueryString({ tenantId })}`,
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
   * Fetch monitoring stats.
   * IMPORTANT: This endpoint currently returns 501 (Not Implemented)
   * because real-time metrics infrastructure is not yet available.
   */
  getMonitoringStats: (): Promise<unknown> => apiFetch<unknown>('/messaging/monitoring/stats'),

  // ── Audit ──

  /** Query messaging audit log with pagination and filters */
  getAuditLog: (filters: MessagingAuditFilters): Promise<AdminMessagingAuditPageV1> =>
    apiFetch<AdminMessagingAuditPageV1>(`/messaging/audit?${buildQueryString(filters)}`),

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
    apiFetch<AiPersonaDefinition[]>(`/messaging/personas?${buildQueryString({ tenantId })}`),

  /**
   * Update an AI persona configuration.
   * IMPORTANT: Currently returns 501 (Not Implemented) because personas are static.
   * @param personaId - Persona identifier
   * @param updates - Fields to update
   */
  updatePersona: (personaId: string, updates: Record<string, unknown>): Promise<unknown> =>
    apiFetch<unknown>(`/messaging/personas/${personaId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),
};
