/**
 * Audit log injection tokens + interface contract.
 *
 * IMPORTANT: this file MUST NOT import any TypeORM `@Entity()`-decorated
 * class. It exists specifically so cross-cutting consumers (TenantGuard,
 * other shared utilities under `libs/backend-common/src/**`) can depend on
 * the audit-logging contract WITHOUT loading `AuditLogEntity` as a side
 * effect.
 *
 * Loading `AuditLogEntity` from a non-audit consumer pollutes TypeORM's
 * global metadata storage (`getMetadataArgsStorage()`) for every service
 * that imports anything from `@aquaculture/backend-common`, which then
 * surfaces in the schema-drift validator as cross-service contamination
 * (e.g. farm-service "owning" `shared.audit_logs` even though it never
 * imported `AuditLogModule`).
 *
 * The contract here is intentionally minimal — just the methods that
 * external consumers (TenantGuard's `auditCrossTenantAccess()`) need.
 * The full `AuditLogService` class implements this interface and is
 * provided under the `AUDIT_LOG_SERVICE` token by `AuditLogModule`.
 */

/**
 * Severity level for audit log entries. Re-exported from
 * `audit-log.entity.ts` for back-compat; the canonical declaration lives
 * here so consumers that need the enum value at runtime do not have to
 * load the entity module.
 */
export enum AuditSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

/**
 * DTO for creating an audit log entry. Mirrors the
 * `CreateAuditEntryDto` interface in `audit-log.service.ts`. Duplicated
 * here so the token + interface contract is self-contained (no transitive
 * import path back to the service implementation).
 */
export interface CreateAuditEntryDto {
  action: string;
  resource: string;
  resourceId?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  tenantId?: string | null;
  schemaName?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  severity?: AuditSeverity;
  correlationId?: string | null;
}

/**
 * Minimal interface that cross-cutting consumers (TenantGuard et al)
 * depend on. The concrete `AuditLogService` class implements this AND
 * exposes additional query methods (`findByTenant`, `findByResource`)
 * that are NOT part of this interface — query consumers should depend
 * on the concrete class via deep import (`@aquaculture/backend-common/audit`).
 */
export interface IAuditLogService {
  /**
   * Persist an audit log entry (fire-and-forget).
   */
  record(dto: CreateAuditEntryDto): void;

  /**
   * Persist an audit log entry and await the result. Use for critical
   * security events (SUPER_ADMIN cross-tenant access, MFA step-up, etc.)
   * where silent loss is unacceptable.
   *
   * @throws Error if the database write fails.
   */
  recordAwait(dto: CreateAuditEntryDto): Promise<void>;
}

/**
 * NestJS DI token for the audit-logging contract. Consumers inject via
 * `@Optional() @Inject(AUDIT_LOG_SERVICE) private readonly audit?: IAuditLogService`.
 *
 * Use a `Symbol` rather than a string to make accidental token collisions
 * impossible across modules.
 */
export const AUDIT_LOG_SERVICE = Symbol.for('aquaculture:AUDIT_LOG_SERVICE');
