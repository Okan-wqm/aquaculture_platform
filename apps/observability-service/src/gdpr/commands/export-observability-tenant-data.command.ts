/**
 * ExportObservabilityTenantDataCommand — GDPR Art 15 / Art 20 handler.
 * ============================================================================
 *
 * Dispatched by the platform DSAR orchestrator when a tenant requests
 * their migration-audit records (Art 15 right of access + Art 20 data
 * portability). Observability-service returns every tenant-scoped row
 * from the tables it owns, keyed by the HMAC hash of the cleartext
 * tenant schema (ADR-022).
 *
 * Output is a structured payload the orchestrator pipes into the
 * caller's preferred export format (JSON / CSV / ZIP).
 */

export interface ExportObservabilityTenantDataPayload {
  /** Cleartext tenant schema name; hashed via hmacTenantHash in the handler. */
  readonly tenantSchema: string;
  /**
   * Optional time-range filter — e.g. "last 90 days". Orchestrator
   * supplies based on regulator's ask; defaults to the full retention
   * window of the source table (migration_events: 13 months).
   */
  readonly fromOccurredAt?: Date;
  readonly toOccurredAt?: Date;
}

export class ExportObservabilityTenantDataCommand {
  public readonly payload: ExportObservabilityTenantDataPayload;

  constructor(payload: ExportObservabilityTenantDataPayload) {
    this.payload = payload;
  }
}
