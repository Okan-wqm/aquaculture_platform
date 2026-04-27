/**
 * EraseObservabilityTenantDataCommand — GDPR Art 17 cascade entry point.
 * ============================================================================
 *
 * Dispatched by the platform GDPR orchestrator when a tenant invokes
 * Right-to-Erasure. Observability-service consumer HMAC-hashes the
 * cleartext tenant schema with the per-env pepper (ADR-022) and deletes
 * every matching row from the audit tables it owns:
 *
 *   - observability.migration_events (tenant-scoped rows only —
 *     most rows are platform-level with tenant_id_hash IS NULL and
 *     are never touched by erasure).
 *
 * dryRun=true performs the lookup + returns the would-be-deleted
 * count WITHOUT issuing DELETE, so the orchestrator can preview the
 * blast radius before committing.
 */

export interface EraseObservabilityTenantDataPayload {
  /**
   * Cleartext tenant schema name (e.g. `tenant_abc1234...`). Handler
   * HMACs this via hmacTenantHash — the DB never sees the cleartext.
   */
  readonly tenantSchema: string;
  /**
   * When true, the handler counts matching rows + returns the count
   * WITHOUT deleting. Defaults to false — production erasure executes
   * the DELETE immediately because the orchestrator has already
   * performed the preview in a prior dry-run pass.
   */
  readonly dryRun?: boolean;
}

export class EraseObservabilityTenantDataCommand {
  public readonly payload: EraseObservabilityTenantDataPayload;

  constructor(payload: EraseObservabilityTenantDataPayload) {
    this.payload = payload;
  }
}
