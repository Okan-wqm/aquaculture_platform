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
 * AuditMethod — closed vocabulary describing the *channel* through which an
 * audit-emitting action arrived (AUDITTRAIL-CRITICAL-004 cure).
 *
 * # Why this exists
 *
 * Without `method`, forensic timelines cannot distinguish a CRON-triggered
 * action ("system did this nightly") from an HTTP-triggered action
 * ("a SUPER_ADMIN clicked a button"). SOC 2 CC1 cross-tenant access
 * reconstruction requires that distinction be queryable, not derived.
 *
 * # Why these exact values
 *
 * The vocabulary mirrors the only five entry-channels the platform ever
 * surfaces:
 *   - HTTP    — REST controllers (gateway-api proxied)
 *   - GRAPHQL — Apollo resolvers
 *   - NATS    — event-bus subscribers / outbox publishers
 *   - CRON    — `@Cron`-decorated scheduled jobs
 *   - CLI     — db-migrate, manual operator scripts
 *
 * The closed set is enforced at the DB layer by a CHECK constraint
 * installed by migration `1788100000000-AddAuditLogShapeExtension`.
 */
export enum AuditMethod {
  HTTP = 'HTTP',
  GRAPHQL = 'GRAPHQL',
  NATS = 'NATS',
  CRON = 'CRON',
  CLI = 'CLI',
}

/**
 * AuditResult — closed vocabulary describing the outcome of an audited
 * action (AUDITTRAIL-CRITICAL-004 cure).
 *
 * # Why this is separate from `severity`
 *
 * Severity (INFO/WARNING/ERROR/CRITICAL) is the operator's filter knob —
 * "show me anomalies." Result is the auditor's truth — "was the action
 * permitted, denied, or did it crash?" Conflating the two collapses two
 * orthogonal axes:
 *
 *   - DENIED is not the same as ERROR. An access-control denial is the
 *     system working correctly; an unhandled exception is not.
 *   - SUCCESS at INFO severity is the common case; SUCCESS at CRITICAL
 *     severity is a SUPER_ADMIN cross-tenant action that succeeded
 *     (still success, but worth alarming on).
 *
 * The closed set is enforced at the DB layer by a CHECK constraint
 * installed by migration `1788100000000-AddAuditLogShapeExtension`.
 */
export enum AuditResult {
  SUCCESS = 'SUCCESS',
  DENIED = 'DENIED',
  FAILED = 'FAILED',
}

/**
 * DTO for creating an audit log entry. Mirrors the
 * `CreateAuditEntryDto` interface in `audit-log.service.ts`. Duplicated
 * here so the token + interface contract is self-contained (no transitive
 * import path back to the service implementation).
 *
 * # Mandatory-shape extension (AUDITTRAIL-CRITICAL-004)
 *
 * The agent's mandatory-shape contract introduces 8 fields previously
 * forced into `metadata.jsonb` (not queryable) or simply absent. They
 * are surfaced here as OPTIONAL on the DTO because:
 *
 *   - existing call sites pre-date the shape and must continue to compile
 *     unchanged (TypeORM-level migration nullability matches);
 *   - the values are only meaningful for specific call surfaces (e.g.
 *     `mfaVerified` is meaningful at auth gates, not at CRON sweeps);
 *     omission is the correct default for unrelated callers.
 *
 * The forensic guarantee comes from CALLER discipline (each domain wires
 * its own enrichment), enforced by per-call invariant tests (e.g. the
 * impersonation lifecycle audit must always set `actorHomeTenantId`).
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

  // ── AUDITTRAIL-CRITICAL-004 mandatory-shape extension ──
  /**
   * Actor's *home* tenantId — the tenant the actor belongs to. Distinct
   * from `tenantId` (legacy) which is now semantically the *target*
   * tenant. Critical for SUPER_ADMIN dual-identity reconstruction (a
   * cross-tenant impersonation row will have actorHomeTenantId !=
   * actedOnTenantId).
   */
  actorHomeTenantId?: string | null;
  /**
   * Acted-on tenantId — the tenant the action targeted. Same as the
   * legacy `tenantId` for back-compat; consumers SHOULD set both during
   * the V1→V2 transition window so query writers can pivot to
   * `actedOnTenantId` without a backfill stall.
   */
  actedOnTenantId?: string | null;
  /**
   * Channel through which the action arrived. See `AuditMethod` enum.
   * DB-level CHECK constraint enforces the closed vocabulary.
   */
  method?: AuditMethod | null;
  /**
   * True iff the actor cleared MFA step-up at the time of the action.
   * SOC 2 CC6.1 evidence reports filter on this column directly
   * (partial index supports the filter).
   */
  mfaVerified?: boolean;
  /**
   * Outcome of the audited action. See `AuditResult` enum. DB-level
   * CHECK constraint enforces the closed vocabulary.
   */
  result?: AuditResult | null;
  /**
   * Hex-encoded SHA-256 of the entity state BEFORE the mutation
   * (mutation-integrity proof; AUDITTRAIL-MEDIUM-001 cure). 64 chars
   * for SHA-256 hex output. Null for non-mutation actions.
   */
  preStateHash?: string | null;
  /**
   * Hex-encoded SHA-256 of the entity state AFTER the mutation. Null
   * for non-mutation actions or DENIED/FAILED actions where no
   * post-state exists.
   */
  postStateHash?: string | null;
  /**
   * Free-text justification supplied by the actor for override actions
   * (admin override of a scheduled change, manual unlock, etc.). The
   * audit-trail-completeness-auditor invariant requires this to be
   * non-null whenever `action` matches the `*_OVERRIDE` pattern.
   */
  justification?: string | null;
  /**
   * Foreign keys to other audit rows participating in the same logical
   * session — e.g. an impersonation start row points to the end row,
   * a multi-step OVERRIDE points to its individual mutations. Allows
   * forensic reconstruction without timestamp-window heuristics.
   */
  relatedAuditIds?: string[] | null;
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
