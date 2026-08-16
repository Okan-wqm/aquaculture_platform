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
 *   - GET  /messaging/monitoring/stats  (returns 501 until real-time metrics infra)
 *   - GET  /messaging/audit
 *
 * @see ADR-012 Phase 3
 */

import { apiFetch } from '../http-client';
import { ADMIN_API_ROUTES } from '../types/generated/admin-route-contracts';
import type {
  AdminApiRouteQuery,
  AdminApiRouteResponse,
} from '../types/generated/admin-route-contracts';

// ============================================================================
// Types -- Compliance
// ============================================================================

/** Aggregated compliance statistics returned by GET /messaging/compliance/stats */
export type ComplianceStats = AdminApiRouteResponse<'GET /messaging/compliance/stats'>;

/** Legal hold record returned by GET /messaging/compliance/legal-holds */
export type LegalHold = AdminApiRouteResponse<'GET /messaging/compliance/legal-holds'>[number];

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

export type RetentionPolicy = AdminApiRouteResponse<'GET /messaging/retention/policies'>[number];

export interface RetentionPolicyUpdate {
  channelId?: string | null;
  retentionDays: number;
}

// ============================================================================
// Types -- Audit
// ============================================================================

export type MessagingAuditResult = AdminApiRouteResponse<'GET /messaging/audit'>;

export type MessagingAuditEntry = MessagingAuditResult['items'][number];

export type MessagingAuditFilters = AdminApiRouteQuery<'GET /messaging/audit'>;

type ComplianceStatsQuery = AdminApiRouteQuery<'GET /messaging/compliance/stats'>;
type LegalHoldsQuery = AdminApiRouteQuery<'GET /messaging/compliance/legal-holds'>;

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
export type ExportTriggerResult = AdminApiRouteResponse<'POST /messaging/tenants/:id/export'>;

// ============================================================================
// Types -- AI Personas
// ============================================================================

/** Persona definition returned by GET /messaging/personas */
export type AiPersonaDefinition = AdminApiRouteResponse<'GET /messaging/personas'>[number];

// ============================================================================
// API
// ============================================================================

export const messagingApi = {
  // ── Compliance Stats ──

  /**
   * Fetch compliance statistics.
   * @param tenantId - Optional tenant filter. Omit for platform-wide stats.
   */
  getComplianceStats: (
    tenantId: ComplianceStatsQuery['tenantId'],
  ): Promise<AdminApiRouteResponse<'GET /messaging/compliance/stats'>> =>
    apiFetch(ADMIN_API_ROUTES['GET /messaging/compliance/stats'], { query: { tenantId } }),

  // ── Legal Holds ──

  /**
   * Fetch legal holds list.
   * @param tenantId - Optional tenant filter. Omit for all tenants.
   */
  getLegalHolds: (
    tenantId: LegalHoldsQuery['tenantId'],
  ): Promise<AdminApiRouteResponse<'GET /messaging/compliance/legal-holds'>> =>
    apiFetch(ADMIN_API_ROUTES['GET /messaging/compliance/legal-holds'], { query: { tenantId } }),

  /** Create a new legal hold on messaging data. */
  createLegalHold: (
    input: CreateLegalHoldInput,
  ): Promise<AdminApiRouteResponse<'POST /messaging/compliance/legal-holds'>> =>
    apiFetch(ADMIN_API_ROUTES['POST /messaging/compliance/legal-holds'], { body: input }),

  /**
   * Release (deactivate) an existing legal hold.
   * @param holdId - UUID of the legal hold to release
   * @param tenantId - Tenant that owns the hold
   */
  releaseLegalHold: (
    holdId: string,
    tenantId: string,
  ): Promise<AdminApiRouteResponse<'DELETE /messaging/compliance/legal-holds/:id'>> =>
    apiFetch(ADMIN_API_ROUTES['DELETE /messaging/compliance/legal-holds/:id'], {
      path: { id: holdId },
      query: { tenantId },
    }),

  // ── Retention ──

  /** Fetch all tenant retention policies */
  getRetentionPolicies: (
    tenantId: string,
  ): Promise<AdminApiRouteResponse<'GET /messaging/retention/policies'>> =>
    apiFetch(ADMIN_API_ROUTES['GET /messaging/retention/policies'], { query: { tenantId } }),

  /** Update a single tenant retention policy */
  updateRetentionPolicy: (
    policyId: string,
    update: RetentionPolicyUpdate,
  ): Promise<AdminApiRouteResponse<'PUT /messaging/retention/policies/:id'>> =>
    apiFetch(ADMIN_API_ROUTES['PUT /messaging/retention/policies/:id'], {
      path: { id: policyId },
      body: update,
    }),

  // ── Monitoring ──

  /**
   * Fetch monitoring stats.
   * IMPORTANT: This endpoint currently returns 501 (Not Implemented)
   * because real-time metrics infrastructure is not yet available.
   */
  getMonitoringStats: (): Promise<unknown> =>
    apiFetch(ADMIN_API_ROUTES['GET /messaging/monitoring/stats']),

  // ── Audit ──

  /** Query messaging audit log with pagination and filters */
  getAuditLog: (
    filters: MessagingAuditFilters,
  ): Promise<AdminApiRouteResponse<'GET /messaging/audit'>> =>
    apiFetch(ADMIN_API_ROUTES['GET /messaging/audit'], { query: filters }),

  // ── Data Export ──

  /**
   * Trigger a data export for a specific tenant.
   * @param tenantId - UUID of the tenant to export
   * @param format - Export format ('csv' or 'json'), defaults to 'json'
   */
  triggerExport: (
    tenantId: string,
    format: 'csv' | 'json' = 'json',
  ): Promise<AdminApiRouteResponse<'POST /messaging/tenants/:id/export'>> =>
    apiFetch(ADMIN_API_ROUTES['POST /messaging/tenants/:id/export'], {
      path: { id: tenantId },
      body: { format },
    }),

  // ── AI Personas ──

  /**
   * Fetch AI persona definitions for a tenant.
   * Returns the list of available personas from the backend registry.
   * @param tenantId - UUID of the tenant
   */
  getPersonas: (tenantId: string): Promise<AdminApiRouteResponse<'GET /messaging/personas'>> =>
    apiFetch(ADMIN_API_ROUTES['GET /messaging/personas'], { query: { tenantId } }),
};
